/**
 * Shopify GraphQL Admin API client.
 *
 * - Native fetch, no SDK.
 * - Supports a static Admin API token (shpat_...) OR the Dev Dashboard
 *   "client credentials" grant (token fetched + refreshed automatically).
 * - Cost-based rate limiting: reads `extensions.cost.throttleStatus` after each
 *   call and pauses ALL concurrent workers when the bucket runs low; retries
 *   THROTTLED / 429 / 5xx / network errors with exponential backoff.
 *
 * Retrying mutations is safe here: every mutation sets ABSOLUTE price values,
 * so applying the same payload twice yields the same result (idempotent).
 */

const PRODUCTS_PAGE_SIZE = 8; // 8 products x 100 variants ≈ 830 query-cost points (< 1000 max)
const VARIANTS_PAGE_SIZE = 100;
const PRODUCT_VARIANTS_PAGE_SIZE = 250;
const BULK_UPDATE_CHUNK = 100;
const MAX_RETRIES = 6;
const REQUEST_TIMEOUT_MS = 60_000;
const MIN_BUCKET_RESERVE = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) =>
  Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);

export class ShopifyError extends Error {
  /**
   * @param {string} message  Human readable (French) message.
   * @param {object} opts
   * @param {string}  [opts.code]       Machine code.
   * @param {number}  [opts.status]     HTTP status if any.
   * @param {*}       [opts.details]    Raw details for logs.
   * @param {boolean} [opts.fatal]      Auth/permission problem: abort the whole job.
   * @param {boolean} [opts.ambiguous]  The request MAY have been applied by Shopify.
   */
  constructor(message, { code = 'SHOPIFY_ERROR', status = null, details = null, fatal = false, ambiguous = false } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.fatal = fatal;
    this.ambiguous = ambiguous;
  }
}

export function normalizeShopDomain(input) {
  let domain = String(input || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN est vide.');
  if (!domain.includes('.')) domain = `${domain}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error(
      `SHOPIFY_STORE_DOMAIN invalide : "${input}". Format attendu : ma-boutique.myshopify.com`
    );
  }
  return domain;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const VARIANT_FIELDS = `id title price compareAtPrice`;

const ACTIVE_PRODUCTS_QUERY = `#graphql
  query ActiveProducts($first: Int!, $after: String, $query: String!, $variantsFirst: Int!) {
    products(first: $first, after: $after, query: $query, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          status
          isGiftCard
          variants(first: $variantsFirst) {
            pageInfo { hasNextPage endCursor }
            edges { node { ${VARIANT_FIELDS} } }
          }
        }
      }
    }
  }`;

const PRODUCT_WITH_VARIANTS_QUERY = `#graphql
  query ProductWithVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      id
      title
      status
      isGiftCard
      variants(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node { ${VARIANT_FIELDS} } }
      }
    }
  }`;

const BULK_UPDATE_MUTATION = `#graphql
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id }
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }`;

const SHOP_QUERY = `#graphql
  query ShopInfo { shop { name currencyCode myshopifyDomain } }`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ShopifyClient {
  constructor({ storeDomain, clientId, clientSecret, adminToken = null, apiVersion = '2026-01', logger = console }) {
    this.domain = normalizeShopDomain(storeDomain);
    this.apiVersion = String(apiVersion || '2026-01').trim();
    this.endpoint = `https://${this.domain}/admin/api/${this.apiVersion}/graphql.json`;
    this.logger = logger;

    this.clientId = clientId?.trim() || null;
    this.clientSecret = clientSecret?.trim() || null;
    // Allow legacy token only if Client ID / Secret are not provided and token is not a dummy placeholder
    const validStaticToken = adminToken?.trim() && !adminToken.includes('xxxx') ? adminToken.trim() : null;
    this.staticToken = (!this.clientId || !this.clientSecret) ? validStaticToken : null;

    if (!this.staticToken && (!this.clientId || !this.clientSecret)) {
      throw new Error(
        'Identifiants Shopify manquants : veuillez renseigner SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET dans votre .env.'
      );
    }
    this.authMode = this.staticToken ? 'admin_token' : 'client_credentials';

    this._token = null;
    this._tokenExpiresAt = 0;
    this._tokenPromise = null;
    this._pausedUntil = 0; // shared throttle gate for all concurrent workers
    this._versionWarned = false;
  }

  // ----- Authentication (Client Credentials Grant Flow) --------------------

  /**
   * Obtains or refreshes an Admin API access token using client_id and client_secret.
   * Tokens are cached in-memory and automatically refreshed 5 minutes before expiry.
   */
  async _getAccessToken(forceRefresh = false) {
    if (this.staticToken) return this.staticToken;
    if (!forceRefresh && this._token && Date.now() < this._tokenExpiresAt - 5 * 60_000) {
      return this._token;
    }
    if (!this._tokenPromise) {
      this._tokenPromise = (async () => {
        let res;
        try {
          res = await fetch(`https://${this.domain}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: this.clientId,
              client_secret: this.clientSecret,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          throw new ShopifyError(`Shopify injoignable lors de l'obtention du jeton d'accès : ${err.message}`, {
            code: 'NETWORK',
          });
        }
        const text = await res.text();
        if (!res.ok) {
          throw new ShopifyError(
            `Échec d'authentification Shopify Client Credentials (HTTP ${res.status}). Vérifiez SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET dans votre .env et assurez-vous que l'application est bien installée sur la boutique "${this.domain}".`,
            { code: 'AUTH', status: res.status, details: text.slice(0, 500), fatal: true }
          );
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new ShopifyError('Réponse OAuth Shopify invalide.', { code: 'AUTH', fatal: true });
        }
        if (!json.access_token) {
          throw new ShopifyError('Réponse OAuth Shopify sans access_token.', { code: 'AUTH', fatal: true });
        }
        this._token = json.access_token;
        this._tokenExpiresAt = Date.now() + (Number(json.expires_in) || 86_399) * 1000;
        this.logger.log(`[shopify] ✅ Jeton d'accès Admin API obtenu via Client Credentials (expire dans ~${Math.round((this._tokenExpiresAt - Date.now()) / 3600000)}h)`);
        return this._token;
      })().finally(() => {
        this._tokenPromise = null;
      });
    }
    return this._tokenPromise;
  }

  // ----- Throttling --------------------------------------------------------

  _pause(ms) {
    this._pausedUntil = Math.max(this._pausedUntil, Date.now() + ms);
  }

  async _waitForCapacity() {
    // Loop because another worker may extend the pause while we sleep.
    for (;;) {
      const wait = this._pausedUntil - Date.now();
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  _handleCost(cost) {
    const throttle = cost?.throttleStatus;
    if (!throttle) return;
    const { currentlyAvailable, restoreRate, maximumAvailable } = throttle;
    if (!restoreRate) return;
    const target = Math.min(maximumAvailable ?? Infinity, Math.max(cost.requestedQueryCost ?? 0, MIN_BUCKET_RESERVE));
    if (currentlyAvailable < target) {
      this._pause(Math.ceil(((target - currentlyAvailable) / restoreRate) * 1000) + 100);
    }
  }

  _checkVersion(res) {
    if (this._versionWarned) return;
    const served = res.headers.get('x-shopify-api-version');
    if (served && served !== this.apiVersion) {
      this._versionWarned = true;
      this.logger.warn(
        `[shopify] ⚠️ Version d'API demandée ${this.apiVersion} non supportée : Shopify a répondu avec ${served}. Mettez à jour SHOPIFY_API_VERSION.`
      );
    }
  }

  // ----- Core request ------------------------------------------------------

  async graphql(query, variables = {}) {
    let attempt = 0;
    let tokenRefreshed = false;

    for (;;) {
      attempt += 1;
      await this._waitForCapacity();

      const token = await this._getAccessToken();
      let res;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt <= MAX_RETRIES) {
          this.logger.warn(`[shopify] Erreur réseau (tentative ${attempt}) : ${err.message}`);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ShopifyError(`Shopify injoignable après plusieurs tentatives : ${err.message}`, {
          code: 'NETWORK',
          ambiguous: true,
        });
      }

      this._checkVersion(res);

      if (res.status === 401 && !this.staticToken && !tokenRefreshed) {
        tokenRefreshed = true;
        await this._getAccessToken(true);
        attempt -= 1;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        throw new ShopifyError(
          `Accès refusé par Shopify (HTTP ${res.status}). Vérifiez le jeton d'accès et les permissions read_products / write_products.`,
          { code: 'AUTH', status: res.status, details: text.slice(0, 500), fatal: true }
        );
      }

      if (res.status === 402 || res.status === 423) {
        throw new ShopifyError(
          `La boutique est indisponible (HTTP ${res.status} : boutique gelée ou verrouillée).`,
          { code: 'SHOP_UNAVAILABLE', status: res.status, fatal: true }
        );
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt <= MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
          this.logger.warn(`[shopify] HTTP ${res.status}, nouvelle tentative dans ${ms} ms`);
          this._pause(ms);
          continue;
        }
        throw new ShopifyError(`Shopify indisponible (HTTP ${res.status}) après plusieurs tentatives.`, {
          code: res.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
          status: res.status,
          ambiguous: res.status >= 500,
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ShopifyError(`Erreur Shopify inattendue (HTTP ${res.status}).`, {
          code: 'HTTP_ERROR',
          status: res.status,
          details: text.slice(0, 500),
        });
      }

      let body;
      try {
        body = await res.json();
      } catch {
        if (attempt <= MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ShopifyError('Réponse illisible de Shopify.', { code: 'BAD_RESPONSE', ambiguous: true });
      }

      this._handleCost(body?.extensions?.cost);

      const errors = Array.isArray(body?.errors)
        ? body.errors
        : body?.errors
          ? [{ message: String(body.errors) }]
          : [];

      if (errors.length) {
        const throttled = errors.some((e) => e?.extensions?.code === 'THROTTLED');
        if (throttled && attempt <= MAX_RETRIES) {
          if (this._pausedUntil <= Date.now()) this._pause(backoffMs(attempt));
          continue;
        }
        const messages = errors.map((e) => e?.message).filter(Boolean).join(' | ');
        const accessDenied = errors.some((e) => e?.extensions?.code === 'ACCESS_DENIED');
        throw new ShopifyError(
          accessDenied
            ? `Permission Shopify manquante : ${messages}. L'app doit avoir les accès read_products et write_products.`
            : `Erreur GraphQL Shopify : ${messages}`,
          { code: errors[0]?.extensions?.code || 'GRAPHQL_ERROR', details: errors, fatal: accessDenied || throttled }
        );
      }

      return body.data;
    }
  }

  // ----- High-level helpers ------------------------------------------------

  async getShopInfo() {
    const data = await this.graphql(SHOP_QUERY);
    return data.shop;
  }

  /**
   * Fetches ALL products with status ACTIVE and ALL their variants
   * (cursor pagination on products, and on variants when a product has > 100).
   * @param {{ onProgress?: (count: number) => void }} [opts]
   * @returns {Promise<Array<{id, title, status, isGiftCard, variants: Array<{id, title, price, compareAtPrice}>}>>}
   */
  async fetchAllActiveProducts({ onProgress } = {}) {
    const products = [];
    let after = null;

    for (;;) {
      const data = await this.graphql(ACTIVE_PRODUCTS_QUERY, {
        first: PRODUCTS_PAGE_SIZE,
        after,
        query: 'status:active',
        variantsFirst: VARIANTS_PAGE_SIZE,
      });
      const connection = data?.products;
      if (!connection) throw new ShopifyError('Réponse inattendue de Shopify (products).', { code: 'BAD_RESPONSE' });

      for (const { node } of connection.edges) {
        // Double check: the search index can lag behind real product status.
        if (node.status !== 'ACTIVE') continue;

        let variants = node.variants.edges.map((e) => e.node);
        if (node.variants.pageInfo.hasNextPage) {
          const full = await this.fetchProductWithVariants(node.id);
          variants = full ? full.variants : variants;
        }
        products.push({
          id: node.id,
          title: node.title,
          status: node.status,
          isGiftCard: Boolean(node.isGiftCard),
          variants,
        });
      }

      onProgress?.(products.length);
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }

    return products;
  }

  /**
   * Fetches one product with ALL its variants. Returns null if the product no longer exists.
   */
  async fetchProductWithVariants(productId) {
    let after = null;
    let product = null;
    const variants = [];

    for (;;) {
      const data = await this.graphql(PRODUCT_WITH_VARIANTS_QUERY, {
        id: productId,
        first: PRODUCT_VARIANTS_PAGE_SIZE,
        after,
      });
      if (!data?.product) return null;
      product = data.product;
      variants.push(...product.variants.edges.map((e) => e.node));
      if (!product.variants.pageInfo.hasNextPage) break;
      after = product.variants.pageInfo.endCursor;
    }

    return {
      id: product.id,
      title: product.title,
      status: product.status,
      isGiftCard: Boolean(product.isGiftCard),
      variants,
    };
  }

  /**
   * Runs productVariantsBulkUpdate for one product (chunked by 100 variants).
   * Each chunk is atomic on Shopify's side. Stops at the first chunk with userErrors.
   * @param {string} productId
   * @param {Array<{id: string, price: string, compareAtPrice: string|null}>} variants
   * @returns {Promise<{ updated: Array, userErrors: Array }>}
   *   `updated.length > 0` together with `userErrors` means the product was PARTIALLY updated.
   */
  async bulkUpdateVariants(productId, variants) {
    const updated = [];
    const userErrors = [];

    for (let i = 0; i < variants.length; i += BULK_UPDATE_CHUNK) {
      const chunk = variants.slice(i, i + BULK_UPDATE_CHUNK).map((v) => ({
        id: v.id,
        price: v.price,
        compareAtPrice: v.compareAtPrice ?? null, // null clears the compare-at price
      }));

      const data = await this.graphql(BULK_UPDATE_MUTATION, { productId, variants: chunk });
      const payload = data?.productVariantsBulkUpdate;
      if (!payload) {
        throw new ShopifyError('Réponse inattendue de Shopify (productVariantsBulkUpdate vide).', {
          code: 'BAD_RESPONSE',
          ambiguous: true,
        });
      }
      if (payload.userErrors?.length) {
        userErrors.push(...payload.userErrors);
        break;
      }
      updated.push(...(payload.productVariants || []));
    }

    return { updated, userErrors };
  }
}
