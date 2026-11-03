/**
 * Promo manager: price math, backup, anti-double-discount lock, Dry-Run simulation, start/stop workflows.
 *
 * Safety invariants
 * -----------------
 * 1. The backup (data/price-backup.json) is written ONCE, atomically, and verified
 *    BEFORE any mutation. It is never modified afterwards.
 * 2. "backup file exists"  <=>  "promo is considered active" (enforced at boot).
 *    => Activation is refused while a backup exists, so originals can never be
 *       overwritten by already-discounted prices.
 * 3. Dry-Run simulation mode:
 *    - Reads the REAL Shopify catalog via GraphQL.
 *    - Saves price-backup.json and calculates all discounted prices.
 *    - SKIPS GraphQL mutations completely.
 *    - Saves data/last-simulation.json with preview of real products.
 *    - On stop: resets state without mutating Shopify.
 * 4. A backup is never deleted: after a successful restore (or simulation stop)
 *    it is MOVED to data/history/.
 * 5. Only one operation (start or stop) can run at a time (in-process lock).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createStorage } from './storage.js';

export const MIN_DISCOUNT = 5;
export const MAX_DISCOUNT = 70;
const MAX_FAILURES_LISTED = 50;
const BACKUP_FORMAT_VERSION = 1;

export class PromoError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PromoError';
    this.status = status;
  }
}

// ===========================================================================
// Pure helpers (unit-tested in test/pricing.test.js)
// ===========================================================================

/** "19.90" -> 1990 ; null/""/invalid -> null */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** 1990 -> "19.90" (exact, no floating point formatting) */
export function centsToMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatPct(n) {
  return String(n).replace('.', ',');
}

/** Accepts number or numeric string ("40", "33,5"). Range: 5 – 70. */
export function validateDiscount(raw) {
  const n = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: false, error: 'Le pourcentage de remise doit être un nombre.' };
  }
  if (n < MIN_DISCOUNT || n > MAX_DISCOUNT) {
    return {
      ok: false,
      error: `Le pourcentage de remise doit être compris entre ${MIN_DISCOUNT} % et ${MAX_DISCOUNT} %.`,
    };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * Computes the discounted price of one variant.
 *  - base = compareAtPrice if it is strictly greater than price, otherwise price
 *  - newCompareAtPrice = base
 *  - newPrice = base * (1 - pct/100), rounded to the cent
 *  - neverIncreasePrice: if the variant is already sold cheaper than newPrice, keep its current price.
 */
export function computeVariantPlan(variant, discountPercentage, { neverIncreasePrice = false } = {}) {
  const priceCents = toCents(variant.price);
  const compareCents = toCents(variant.compareAtPrice);

  if (priceCents === null) return { action: 'skip', reason: 'Prix illisible' };
  if (priceCents <= 0) return { action: 'skip', reason: 'Produit gratuit (prix à 0)' };

  const baseCents = compareCents !== null && compareCents > priceCents ? compareCents : priceCents;
  let newPriceCents = Math.round((baseCents * (100 - discountPercentage)) / 100);

  let keptExistingSale = false;
  if (neverIncreasePrice && newPriceCents > priceCents) {
    newPriceCents = priceCents;
    keptExistingSale = true;
  }

  if (newPriceCents <= 0) return { action: 'skip', reason: 'Prix remisé nul' };
  if (newPriceCents >= baseCents) return { action: 'skip', reason: 'Remise trop faible pour ce prix' };
  if (newPriceCents === priceCents && compareCents === baseCents) {
    return { action: 'skip', reason: 'Déjà soldé à un prix inférieur ou égal' };
  }

  return {
    action: 'update',
    newPrice: centsToMoney(newPriceCents),
    newCompareAtPrice: centsToMoney(baseCents),
    keptExistingSale,
  };
}

// ===========================================================================
// File helpers
// ===========================================================================

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Reads JSON. Missing file -> fallback. Corrupted file -> throws. */
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Fichier JSON corrompu : ${file}. Intervention requise.`);
  }
}

/** Atomic write: temp file + fsync + rename. */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

async function runPool(items, concurrency, worker, shouldStop = () => false) {
  let index = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length && !shouldStop()) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function formatUserErrors(userErrors) {
  return userErrors.map((e) => e.message).filter(Boolean).join(' ; ') || 'Erreur Shopify inconnue';
}

const nowIso = () => new Date().toISOString();

// ===========================================================================
// Manager
// ===========================================================================

const DEFAULT_STATE = Object.freeze({
  isPromoActive: false,
  isDryRun: false,
  discountPercentage: null,
  activatedAt: null,
  activatedBy: null,
  affectedProductsCount: 0,
  affectedVariantsCount: 0,
  deactivatedAt: null,
  deactivatedBy: null,
  lastResult: null,
  pendingOperation: null,
});

export function createPromoManager({
  shopify,
  dataDir,
  databaseUrl = process.env.DATABASE_URL,
  storage: customStorage,
  concurrency = 2,
  neverIncreasePrice = false,
  logger = console,
}) {
  const storage = customStorage || createStorage({ dataDir, databaseUrl, logger });

  let state = { ...DEFAULT_STATE };
  let busy = false;
  let operation = null;
  let currentJob = null;

  // ----- persistence -------------------------------------------------------

  async function updateState(patch) {
    state = { ...state, ...patch };
    await storage.writeState(state);
  }

  async function archiveBackup(label) {
    return await storage.archiveBackup(label);
  }

  async function audit(event, email = null, details = {}) {
    await storage.appendAudit(event, email, details);
    logger.log(`[audit] ${event}${email ? ` (${email})` : ''} ${Object.keys(details).length ? JSON.stringify(details) : ''}`);
  }

  async function readAudit(opts = {}) {
    return await storage.readAudit(opts);
  }

  function setOp(patch) {
    operation = { ...operation, ...patch };
  }

  // ----- boot / crash recovery --------------------------------------------

  async function init() {
    await storage.init();

    state = { ...DEFAULT_STATE, ...(await storage.readState({})) };
    const backup = await storage.readBackup();
    const backupExists = Boolean(backup);
    let changed = false;

    const fillFromBackup = () => {
      if (!backup) return;
      const planned = backup.products?.filter((p) => p.variants?.some((v) => v.newPrice)) ?? [];
      state.isDryRun = Boolean(backup.isDryRun);
      state.discountPercentage ??= backup.discountPercentage ?? null;
      state.activatedAt ??= backup.createdAt ?? null;
      state.activatedBy ??= backup.createdBy ?? null;
      if (!state.affectedProductsCount) state.affectedProductsCount = planned.length;
      if (!state.affectedVariantsCount) {
        state.affectedVariantsCount = planned.reduce((n, p) => n + p.variants.filter((v) => v.newPrice).length, 0);
      }
    };

    if (state.pendingOperation) {
      const op = state.pendingOperation;
      const label = op.type === 'start' ? "d'activation" : 'de restauration';
      state.pendingOperation = null;
      state.isPromoActive = backupExists;
      if (backupExists) fillFromBackup();
      state.lastResult = {
        type: 'recovery',
        status: 'error',
        finishedAt: nowIso(),
        by: op.startedBy ?? null,
        message: backupExists
          ? `L'opération ${label} lancée le ${op.startedAt} a été interrompue (redémarrage du serveur). Les prix sont sauvegardés : vous pouvez restaurer ou annuler.`
          : `L'opération ${label} lancée le ${op.startedAt} a été interrompue avant toute modification. Aucun prix n'a été modifié.`,
        failures: [],
      };
      changed = true;
      await audit('recovery_interrupted_operation', op.startedBy ?? null, { type: op.type, backupExists });
    } else if (backupExists && !state.isPromoActive) {
      state.isPromoActive = true;
      fillFromBackup();
      state.lastResult = {
        type: 'recovery',
        status: 'error',
        finishedAt: nowIso(),
        by: null,
        message:
          "Une sauvegarde de prix non restaurée a été détectée : par sécurité, la promotion est considérée comme active. Cliquez sur « Arrêter la promo & Restaurer les prix d'origine » pour la clôturer.",
        failures: [],
      };
      changed = true;
      await audit('recovery_backup_detected', null, {});
    }

    if (changed) await storage.writeState(state);
    logger.log(
      `[promo] État chargé : promo ${state.isPromoActive ? `ACTIVE (-${state.discountPercentage}%${state.isDryRun ? ' [Simulation]' : ''})` : 'inactive'}, sauvegarde ${backupExists ? 'présente' : 'absente'}.`
    );
  }

  // ----- public status -----------------------------------------------------

  function getStatus() {
    // eslint-disable-next-line no-unused-vars
    const { pendingOperation, ...publicState } = state;
    return { state: publicState, busy, operation: operation ? { ...operation } : null };
  }

  function acquireLock() {
    if (busy) {
      throw new PromoError(409, 'Une opération est déjà en cours. Patientez quelques instants puis réessayez.');
    }
    busy = true;
  }

  function launch(job) {
    currentJob = job
      .catch((err) => logger.error('[promo] Erreur inattendue :', err))
      .finally(() => {
        busy = false;
        operation = null;
        currentJob = null;
      });
  }

  // ----- START (Real or Dry-Run) -------------------------------------------

  async function startPromo({ discountPercentage, dryRun = false, user }) {
    const check = validateDiscount(discountPercentage);
    if (!check.ok) throw new PromoError(400, check.error);
    const pct = check.value;
    const isDry = Boolean(dryRun);

    acquireLock();
    try {
      if (state.isPromoActive) {
        throw new PromoError(
          409,
          `Une promotion (-${formatPct(state.discountPercentage)} %) est déjà active${state.isDryRun ? ' en mode simulation' : ''}. Arrêtez-la avant d'en lancer une nouvelle.`
        );
      }
      if (await storage.readBackup()) {
        throw new PromoError(
          409,
          "Une sauvegarde de prix existe déjà. Pour éviter toute double remise, utilisez d'abord « Arrêter la promo & Restaurer les prix d'origine »."
        );
      }
      const startedAt = nowIso();
      operation = {
        type: 'start',
        phase: 'fetching',
        isDryRun: isDry,
        message: isDry
          ? 'Simulation : Récupération des produits actifs de Shopify (lecture seule)…'
          : 'Récupération des produits actifs de la boutique…',
        total: 0,
        done: 0,
        failed: 0,
        startedAt,
        startedBy: user.email,
        discountPercentage: pct,
      };
      await updateState({
        pendingOperation: { type: 'start', startedAt, startedBy: user.email, discountPercentage: pct, isDryRun: isDry },
      });
      await audit(isDry ? 'promo_simulation_requested' : 'promo_start_requested', user.email, { discountPercentage: pct });
    } catch (err) {
      busy = false;
      operation = null;
      throw err;
    }

    launch(runStart(pct, isDry, user));
    return getStatus();
  }

  async function runStart(pct, isDry, user) {
    const startedAt = operation.startedAt;
    try {
      // Step 1 — fetch all REAL ACTIVE products + variants from Shopify
      const products = await shopify.fetchAllActiveProducts({
        onProgress: (count) =>
          setOp({
            done: count,
            message: `${isDry ? 'Simulation : ' : ''}Récupération des produits… ${count} produit(s) trouvé(s)`,
          }),
      });
      const giftCards = products.filter((p) => p.isGiftCard);
      const eligible = products.filter((p) => !p.isGiftCard);

      // Step 2 — calculate plans
      let plannedVariants = 0;
      let skippedVariants = 0;
      const backupProducts = eligible.map((p) => ({
        id: p.id,
        title: p.title,
        variants: p.variants.map((v) => {
          const entry = { id: v.id, title: v.title, price: v.price, compareAtPrice: v.compareAtPrice ?? null };
          const plan = computeVariantPlan(v, pct, { neverIncreasePrice });
          if (plan.action === 'update') {
            plannedVariants += 1;
            entry.newPrice = plan.newPrice;
            entry.newCompareAtPrice = plan.newCompareAtPrice;
          } else {
            skippedVariants += 1;
            entry.skipped = plan.reason;
          }
          return entry;
        }),
      }));
      const toUpdate = backupProducts.filter((p) => p.variants.some((v) => v.newPrice));

      if (!toUpdate.length) {
        throw new PromoError(
          422,
          products.length
            ? 'Aucun prix de produit actif ne peut être modifié avec cette remise.'
            : "Aucun produit actif n'a été trouvé dans la boutique."
        );
      }

      // Step 3 — complete snapshot
      setOp({ phase: 'backup', message: "Sauvegarde des prix d'origine…" });
      const backup = {
        formatVersion: BACKUP_FORMAT_VERSION,
        isDryRun: isDry,
        shop: shopify.domain,
        createdAt: startedAt,
        createdBy: user.email,
        discountPercentage: pct,
        neverIncreasePrice,
        totals: {
          activeProducts: products.length,
          giftCardsExcluded: giftCards.length,
          productsToUpdate: toUpdate.length,
          variantsToUpdate: plannedVariants,
          variantsSkipped: skippedVariants,
        },
        products: backupProducts,
      };
      await storage.writeBackup(backup);
      const verify = await storage.readBackup();
      if (!verify || verify.products?.length !== backupProducts.length) {
        throw new Error('La vérification de la sauvegarde a échoué : opération annulée.');
      }
      await audit('backup_created', user.email, { products: backupProducts.length, isDryRun: isDry });

      // Build the 15-item preview list for testing verification
      const preview = [];
      for (const p of toUpdate) {
        for (const v of p.variants) {
          if (v.newPrice) {
            preview.push({
              productTitle: p.title,
              variantTitle: v.title && v.title !== 'Default Title' ? v.title : '',
              oldPrice: v.price,
              newPrice: v.newPrice,
              newCompareAtPrice: v.newCompareAtPrice,
            });
            if (preview.length >= 15) break;
          }
        }
        if (preview.length >= 15) break;
      }

      // =====================================================================
      // DRY-RUN BRANCH: SKIP ALL GRAPHQL MUTATIONS!
      // =====================================================================
      if (isDry) {
        setOp({ phase: 'simulating', message: 'Sauvegarde des résultats de la simulation…' });

        const simulationData = {
          createdAt: startedAt,
          createdBy: user.email,
          discountPercentage: pct,
          totalProducts: toUpdate.length,
          totalVariants: plannedVariants,
          preview,
          products: toUpdate,
        };
        await storage.writeSimulation(simulationData);

        const finishedAt = nowIso();
        const message = `Aperçu calculé : remise de -${formatPct(pct)}% sur ${toUpdate.length} article(s). Vos prix réels restent inchangés.`;

        await updateState({
          isPromoActive: true,
          isDryRun: true,
          discountPercentage: pct,
          activatedAt: startedAt,
          activatedBy: user.email,
          affectedProductsCount: toUpdate.length,
          affectedVariantsCount: plannedVariants,
          deactivatedAt: null,
          deactivatedBy: null,
          pendingOperation: null,
          lastResult: {
            type: 'start',
            status: 'success',
            isDryRun: true,
            finishedAt,
            by: user.email,
            message,
            preview,
            failures: [],
          },
        });

        await audit('promo_simulation_completed', user.email, {
          discountPercentage: pct,
          products: toUpdate.length,
          variants: plannedVariants,
        });
        return;
      }

      // =====================================================================
      // REAL MUTATION BRANCH
      // =====================================================================
      setOp({
        phase: 'updating',
        message: `Application de la remise… 0/${toUpdate.length} produits`,
        total: toUpdate.length,
        done: 0,
        failed: 0,
      });

      const failures = [];
      let okProducts = 0;
      let okVariants = 0;
      let ambiguous = false;
      let fatalError = null;

      await runPool(
        toUpdate,
        concurrency,
        async (product) => {
          const variants = product.variants
            .filter((v) => v.newPrice)
            .map((v) => ({ id: v.id, price: v.newPrice, compareAtPrice: v.newCompareAtPrice }));
          try {
            const res = await shopify.bulkUpdateVariants(product.id, variants);
            if (res.userErrors.length) {
              if (res.updated.length) ambiguous = true;
              failures.push({ productId: product.id, title: product.title, error: formatUserErrors(res.userErrors) });
            } else {
              okProducts += 1;
              okVariants += variants.length;
            }
          } catch (err) {
            if (err.ambiguous || !err.code) ambiguous = true;
            if (err.fatal) fatalError ??= err;
            failures.push({ productId: product.id, title: product.title, error: err.message });
          } finally {
            setOp({
              done: operation.done + 1,
              failed: failures.length,
              message: `Application de la remise… ${operation.done + 1}/${operation.total} produits`,
            });
          }
        },
        () => Boolean(fatalError)
      );

      const notProcessed = toUpdate.length - operation.done;
      const failedCount = failures.length + notProcessed;
      const finishedAt = nowIso();

      if (okProducts === 0 && !ambiguous) {
        await archiveBackup('activation-echouee');
        const reason = fatalError ? fatalError.message : failures[0]?.error || 'erreur inconnue';
        await updateState({
          pendingOperation: null,
          lastResult: {
            type: 'start',
            status: 'error',
            isDryRun: false,
            finishedAt,
            by: user.email,
            message: `La promotion n'a pas pu être appliquée : ${reason} Aucun prix n'a été modifié.`,
            failures: failures.slice(0, MAX_FAILURES_LISTED),
          },
        });
        await audit('promo_start_failed', user.email, { discountPercentage: pct, failed: failedCount, reason });
        return;
      }

      const pctLabel = formatPct(pct);
      let message =
        failedCount === 0
          ? `Promotion -${pctLabel} % appliquée sur ${okProducts} produit(s) (${okVariants} variante(s)).`
          : `Promotion -${pctLabel} % appliquée sur ${okProducts} produit(s), mais ${failedCount} produit(s) n'ont pas pu être modifiés. Les prix d'origine restent sauvegardés.`;
      if (giftCards.length) message += ` ${giftCards.length} carte(s) cadeau exclue(s) volontairement.`;

      await updateState({
        isPromoActive: true,
        isDryRun: false,
        discountPercentage: pct,
        activatedAt: startedAt,
        activatedBy: user.email,
        affectedProductsCount: okProducts,
        affectedVariantsCount: okVariants,
        deactivatedAt: null,
        deactivatedBy: null,
        pendingOperation: null,
        lastResult: {
          type: 'start',
          status: failedCount === 0 ? 'success' : 'partial',
          isDryRun: false,
          finishedAt,
          by: user.email,
          message,
          preview,
          failures: failures.slice(0, MAX_FAILURES_LISTED),
        },
      });
      await audit('promo_started', user.email, {
        discountPercentage: pct,
        products: okProducts,
        variants: okVariants,
        failed: failedCount,
      });
    } catch (err) {
      const backupExists = Boolean(await storage.readBackup());
      const mutationsStarted = operation?.phase === 'updating';
      const finishedAt = nowIso();
      if (backupExists && mutationsStarted) {
        await updateState({
          isPromoActive: true,
          isDryRun: isDry,
          discountPercentage: pct,
          activatedAt: startedAt,
          activatedBy: user.email,
          pendingOperation: null,
          lastResult: {
            type: 'start',
            status: 'error',
            isDryRun: isDry,
            finishedAt,
            by: user.email,
            message: `Erreur pendant l'application de la remise : ${err.message}`,
            failures: [],
          },
        });
      } else {
        if (backupExists) await archiveBackup('activation-echouee');
        await updateState({
          pendingOperation: null,
          lastResult: {
            type: 'start',
            status: 'error',
            isDryRun: isDry,
            finishedAt,
            by: user.email,
            message: `La promotion n'a pas pu être lancée : ${err.message}`,
            failures: [],
          },
        });
      }
      await audit('promo_start_failed', user.email, { discountPercentage: pct, reason: err.message });
    }
  }

  // ----- STOP (Real or Dry-Run) --------------------------------------------

  async function stopPromo({ user }) {
    acquireLock();
    let backup;
    try {
      backup = await storage.readBackup();
      const backupExists = Boolean(backup);
      if (!state.isPromoActive && !backupExists) {
        throw new PromoError(409, "Aucune promotion n'est active : les prix normaux sont déjà en place.");
      }
      if (!backup || !Array.isArray(backup.products)) {
        throw new PromoError(
          500,
          "Sauvegarde des prix introuvable ou invalide : contactez l'administrateur."
        );
      }
      const startedAt = nowIso();
      operation = {
        type: 'stop',
        phase: 'restoring',
        isDryRun: Boolean(state.isDryRun || backup.isDryRun),
        message: state.isDryRun ? 'Clôture du mode simulation…' : "Restauration des prix d'origine…",
        total: 0,
        done: 0,
        failed: 0,
        startedAt,
        startedBy: user.email,
        discountPercentage: state.discountPercentage,
      };
      await updateState({ pendingOperation: { type: 'stop', startedAt, startedBy: user.email } });
      await audit(state.isDryRun ? 'promo_simulation_stop_requested' : 'promo_stop_requested', user.email, {
        discountPercentage: state.discountPercentage,
      });
    } catch (err) {
      busy = false;
      operation = null;
      throw err;
    }

    launch(runStop(backup, user));
    return getStatus();
  }

  async function restoreProduct(product) {
    const res = await shopify.bulkUpdateVariants(product.id, product.variants);
    if (!res.userErrors.length) return { status: 'restored', variants: product.variants.length };

    const current = await shopify.fetchProductWithVariants(product.id);
    if (!current) return { status: 'skipped', reason: "Produit supprimé depuis l'activation" };
    const existing = new Set(current.variants.map((v) => v.id));
    const remaining = product.variants.filter((v) => existing.has(v.id));
    if (!remaining.length) return { status: 'skipped', reason: "Variantes supprimées depuis l'activation" };
    if (remaining.length === product.variants.length) throw new Error(formatUserErrors(res.userErrors));

    const retry = await shopify.bulkUpdateVariants(product.id, remaining);
    if (retry.userErrors.length) throw new Error(formatUserErrors(retry.userErrors));
    return { status: 'restored', variants: remaining.length };
  }

  async function runStop(backup, user) {
    try {
      const isDry = Boolean(state.isDryRun || backup?.isDryRun);
      const finishedAt = nowIso();

      // =====================================================================
      // DRY-RUN BRANCH: NO MUTATIONS NEEDED!
      // =====================================================================
      if (isDry) {
        await archiveBackup('simulation-terminee');
        await updateState({
          isPromoActive: false,
          isDryRun: false,
          discountPercentage: null,
          activatedAt: null,
          activatedBy: null,
          affectedProductsCount: 0,
          affectedVariantsCount: 0,
          deactivatedAt: finishedAt,
          deactivatedBy: user.email,
          pendingOperation: null,
          lastResult: {
            type: 'stop',
            status: 'success',
            isDryRun: true,
            finishedAt,
            by: user.email,
            message: "Aperçu terminé. Vos prix normaux sont actifs.",
            failures: [],
          },
        });
        await audit('promo_simulation_stopped', user.email);
        return;
      }

      // =====================================================================
      // REAL RESTORATION BRANCH
      // =====================================================================
      const hasPlan = backup.products.some((p) => p.variants?.some((v) => 'newPrice' in v || 'skipped' in v));
      const toRestore = backup.products
        .map((p) => ({
          id: p.id,
          title: p.title,
          variants: (p.variants || [])
            .filter((v) => !hasPlan || v.newPrice)
            .map((v) => ({
              id: v.id,
              price: v.price,
              compareAtPrice: v.compareAtPrice === '' || v.compareAtPrice === undefined ? null : v.compareAtPrice,
            })),
        }))
        .filter((p) => p.variants.length);

      setOp({
        total: toRestore.length,
        done: 0,
        message: `Restauration des prix d'origine… 0/${toRestore.length} produits`,
      });

      const failures = [];
      const skipped = [];
      let okProducts = 0;
      let okVariants = 0;
      let fatalError = null;

      await runPool(
        toRestore,
        concurrency,
        async (product) => {
          try {
            const outcome = await restoreProduct(product);
            if (outcome.status === 'restored') {
              okProducts += 1;
              okVariants += outcome.variants;
            } else {
              skipped.push({ productId: product.id, title: product.title, reason: outcome.reason });
            }
          } catch (err) {
            if (err.fatal) fatalError ??= err;
            failures.push({ productId: product.id, title: product.title, error: err.message });
          } finally {
            setOp({
              done: operation.done + 1,
              failed: failures.length,
              message: `Restauration des prix d'origine… ${operation.done + 1}/${operation.total} produits`,
            });
          }
        },
        () => Boolean(fatalError)
      );

      const notProcessed = toRestore.length - operation.done;
      const failedCount = failures.length + notProcessed;

      if (failedCount === 0) {
        const archived = await archiveBackup('restauree');
        await updateState({
          isPromoActive: false,
          isDryRun: false,
          discountPercentage: null,
          activatedAt: null,
          activatedBy: null,
          affectedProductsCount: 0,
          affectedVariantsCount: 0,
          deactivatedAt: finishedAt,
          deactivatedBy: user.email,
          pendingOperation: null,
          lastResult: {
            type: 'stop',
            status: 'success',
            isDryRun: false,
            finishedAt,
            by: user.email,
            message: `Prix d'origine restaurés sur ${okProducts} produit(s) (${okVariants} variante(s)).${
              skipped.length ? ` ${skipped.length} produit(s) supprimé(s) entre-temps ignoré(s).` : ''
            }`,
            failures: [],
          },
        });
        await audit('promo_stopped', user.email, {
          products: okProducts,
          variants: okVariants,
          skipped: skipped.length,
          archivedBackup: archived ? path.basename(String(archived)) : null,
        });
        return;
      }

      await updateState({
        pendingOperation: null,
        lastResult: {
          type: 'stop',
          status: okProducts ? 'partial' : 'error',
          isDryRun: false,
          finishedAt,
          by: user.email,
          message: `${failedCount} produit(s) n'ont pas pu être restaurés. ${okProducts} produit(s) ont retrouvé leur prix. La sauvegarde est conservée.`,
          failures: failures.slice(0, MAX_FAILURES_LISTED),
        },
      });
      await audit('promo_stop_failed', user.email, { restored: okProducts, failed: failedCount });
    } catch (err) {
      await updateState({
        pendingOperation: null,
        lastResult: {
          type: 'stop',
          status: 'error',
          isDryRun: false,
          finishedAt: nowIso(),
          by: user.email,
          message: `Erreur pendant la restauration : ${err.message}`,
          failures: [],
        },
      });
      await audit('promo_stop_failed', user.email, { reason: err.message });
    }
  }

  return {
    init,
    getStatus,
    startPromo,
    stopPromo,
    audit,
    readAudit,
    isBusy: () => busy,
    waitForIdle: () => currentJob ?? Promise.resolve(),
    storage,
  };
}
