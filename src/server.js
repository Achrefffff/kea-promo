/**
 * Shopify Promo Switcher — Express server.
 *
 * Auth flow:
 * - Email Whitelist + Personal Secret Code (configured via AUTHORIZED_USERS in .env)
 * - POST /api/auth/login -> verifies credentials -> issues signed HttpOnly JWT cookie (auth_token, 12h)
 * - Zero shared password, no external OAuth dependency.
 *
 * Simulation / Dry-Run:
 * - Controlled by DRY_RUN env or toggle in UI.
 * - When active: reads real Shopify catalog, calculates exact prices, previews 15 products,
 *   and DOES NOT mutate any prices on Shopify.
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import { ShopifyClient } from './shopify.js';
import { createPromoManager, PromoError, MIN_DISCOUNT, MAX_DISCOUNT } from './promoManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const SESSION_COOKIE = 'auth_token';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const JWT_ISSUER = 'shopify-promo-switcher';
const JWT_AUDIENCE = 'shopify-promo-switcher-ui';
const CSRF_HEADER_VALUE = 'promo-switcher';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseAuthorizedUsers(raw) {
  const users = new Map();
  const entries = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    if (idx !== -1) {
      const email = entry.slice(0, idx).trim().toLowerCase();
      const code = entry.slice(idx + 1).trim();
      if (email && code) {
        users.set(email, code);
      }
    }
  }
  return users;
}

function loadConfig() {
  const env = process.env;
  const errors = [];
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) errors.push(`${name} est obligatoire.`);
    return value;
  };

  const authorizedUsers = parseAuthorizedUsers(env.AUTHORIZED_USERS);
  if (!authorizedUsers.size) {
    errors.push('AUTHORIZED_USERS est vide ou mal formaté. Format attendu : email1@domaine.com:Code1,email2@domaine.com:Code2');
  }

  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) {
    errors.push('JWT_SECRET doit contenir au moins 32 caractères (64+ recommandés).');
  }

  const config = {
    port: Number(env.PORT) || 3000,
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR?.trim() || 'data'),
    jwtSecret,
    cookieSecure: String(env.COOKIE_SECURE || 'auto').trim().toLowerCase(),
    trustProxy: env.TRUST_PROXY?.trim() || 'loopback, linklocal, uniquelocal',
    forceDryRun: String(env.DRY_RUN || 'false').trim().toLowerCase() === 'true',
    shopify: {
      storeDomain: required('SHOPIFY_STORE_DOMAIN'),
      clientId: required('SHOPIFY_CLIENT_ID'),
      clientSecret: required('SHOPIFY_CLIENT_SECRET'),
      adminToken: env.SHOPIFY_ADMIN_TOKEN,
      apiVersion: env.SHOPIFY_API_VERSION?.trim() || '2026-01',
    },
    concurrency: Math.min(5, Math.max(1, Number(env.SHOPIFY_CONCURRENCY) || 2)),
    neverIncreasePrice: String(env.NEVER_INCREASE_PRICE ?? 'true').trim().toLowerCase() !== 'false',
    databaseUrl: env.DATABASE_URL?.trim() || null,
  };

  if (errors.length) {
    console.error('\n❌ Configuration invalide (.env) :\n  - ' + errors.join('\n  - ') + '\n');
    process.exit(1);
  }
  return config;
}

const config = loadConfig();
const ts = () => new Date().toISOString();
const logger = {
  log: (...a) => console.log(ts(), ...a),
  warn: (...a) => console.warn(ts(), ...a),
  error: (...a) => console.error(ts(), ...a),
};

let shopify;
try {
  shopify = new ShopifyClient({ ...config.shopify, logger });
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}

const promo = createPromoManager({
  shopify,
  dataDir: config.dataDir,
  databaseUrl: config.databaseUrl,
  concurrency: config.concurrency,
  neverIncreasePrice: config.neverIncreasePrice,
  logger,
});

// Shop info cache (name / currency)
const shopInfo = { data: null, error: null, fetchedAt: 0 };
async function refreshShopInfo({ force = false } = {}) {
  if (!force && (shopInfo.data || Date.now() - shopInfo.fetchedAt < 60_000)) return;
  shopInfo.fetchedAt = Date.now();
  try {
    shopInfo.data = await shopify.getShopInfo();
    shopInfo.error = null;
  } catch (err) {
    shopInfo.error = err.message;
    logger.warn(`[shopify] Connexion à la boutique impossible : ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// App & middlewares
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** CSRF defense: JSON + custom header required for writes. */
function requireJsonRequest(req, res, next) {
  if (!req.is('application/json') || req.get('X-Requested-With') !== CSRF_HEADER_VALUE) {
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  next();
}

function cookieOptions(req) {
  const secure = config.cookieSecure === 'true' ? true : config.cookieSecure === 'false' ? false : req.secure;
  return { httpOnly: true, secure, sameSite: 'strict', path: '/' };
}

function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'Veuillez vous connecter.', code: 'UNAUTHENTICATED' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const email = String(payload.email || '').toLowerCase();
    const authorizedUsers = parseAuthorizedUsers(process.env.AUTHORIZED_USERS);
    if (!authorizedUsers.has(email)) {
      clearSession(req, res);
      return res.status(403).json({
        error: `Accès refusé : votre adresse email (${email}) n'est plus autorisée à utiliser cet outil.`,
        code: 'FORBIDDEN',
      });
    }
    req.user = { email };
    next();
  } catch {
    clearSession(req, res);
    return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.', code: 'UNAUTHENTICATED' });
  }
}

// Rate limiter for login
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 10 * 60_000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > 25) {
    return res.status(429).json({ error: 'Trop de tentatives de connexion. Réessayez dans 10 minutes.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) if (entry.resetAt < now) loginAttempts.delete(key);
}, 10 * 60_000).unref();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    forceDryRun: process.env.DRY_RUN === 'true',
    minDiscount: MIN_DISCOUNT,
    maxDiscount: MAX_DISCOUNT,
  });
});

app.post(
  '/api/auth/login',
  loginRateLimit,
  requireJsonRequest,
  asyncHandler(async (req, res) => {
    const rawEmail = req.body?.email;
    const rawCode = req.body?.code;

    if (typeof rawEmail !== 'string' || typeof rawCode !== 'string') {
      return res.status(400).json({ error: 'Veuillez saisir votre email et votre code secret.' });
    }

    const email = rawEmail.trim().toLowerCase();
    const code = rawCode.trim();

    const authorizedUsers = parseAuthorizedUsers(process.env.AUTHORIZED_USERS);
    const expectedCode = authorizedUsers.get(email);

    if (!expectedCode || expectedCode !== code) {
      await promo.audit('login_denied', email, { ip: req.ip });
      return res.status(401).json({ error: 'Email non autorisé ou code secret incorrect.' });
    }

    const user = { email };
    const token = jwt.sign(user, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: SESSION_TTL_SECONDS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: email,
    });

    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_SECONDS * 1000 });
    await promo.audit('login', email, { ip: req.ip });
    res.json({ user, email });
  })
);

app.post('/api/auth/logout', requireJsonRequest, (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user, email: req.user.email });
});

app.get(
  '/api/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    await refreshShopInfo();
    res.json({
      user: req.user,
      email: req.user.email,
      shop: {
        domain: shopify.domain,
        name: shopInfo.data?.name ?? null,
        currencyCode: shopInfo.data?.currencyCode ?? 'EUR',
        connectionError: shopInfo.data ? null : shopInfo.error,
      },
      config: {
        minDiscount: MIN_DISCOUNT,
        maxDiscount: MAX_DISCOUNT,
        neverIncreasePrice: config.neverIncreasePrice,
        forceDryRun: process.env.DRY_RUN === 'true',
      },
      ...promo.getStatus(),
    });
  })
);

app.get(
  '/api/audit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 15));
    res.json({ entries: await promo.readAudit({ limit, promoOnly: true }) });
  })
);

app.post(
  '/api/promo/start',
  requireAuth,
  requireJsonRequest,
  asyncHandler(async (req, res) => {
    const forceDry = process.env.DRY_RUN === 'true';
    const dryRun = forceDry || Boolean(req.body?.dryRun);

    const status = await promo.startPromo({
      discountPercentage: req.body?.discountPercentage,
      dryRun,
      user: req.user,
    });
    res.status(202).json(status);
  })
);

app.post(
  '/api/promo/stop',
  requireAuth,
  requireJsonRequest,
  asyncHandler(async (req, res) => {
    const status = await promo.stopPromo({ user: req.user });
    res.status(202).json(status);
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use(express.static(path.join(ROOT_DIR, 'public'), { index: 'index.html', extensions: ['html'] }));

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof PromoError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Corps de requête JSON invalide.' });
  }
  logger.error('[server] Erreur non gérée :', err);
  res.status(500).json({ error: 'Erreur interne du serveur. Consultez les logs.' });
});

// ---------------------------------------------------------------------------
// Boot & graceful shutdown
// ---------------------------------------------------------------------------

await promo.init();

const server = app.listen(config.port, () => {
  const usersCount = parseAuthorizedUsers(process.env.AUTHORIZED_USERS).size;
  logger.log(`🚀 Shopify Promo Switcher démarré sur http://localhost:${config.port}`);
  logger.log(
    `   Stockage : ${config.databaseUrl ? '🐘 Neon PostgreSQL (Cloud)' : '📁 Disque local (./data)'}`
  );
  logger.log(
    `   Boutique : ${shopify.domain} (API ${shopify.apiVersion}) — Mode Dry-Run forcé : ${config.forceDryRun ? 'OUI (Simulation)' : 'NON (Mode Réel)'}`
  );
  logger.log(`   Utilisateurs autorisés : ${usersCount} compte(s) avec code secret personnel`);

  refreshShopInfo({ force: true }).then(() => {
    if (shopInfo.data) logger.log(`   ✅ Connecté à la boutique « ${shopInfo.data.name} » (${shopInfo.data.currencyCode})`);
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`[server] ${signal} reçu, arrêt en cours…`);
  server.close();
  if (promo.isBusy()) {
    logger.log('[server] Une opération Shopify est en cours : attente de sa fin avant arrêt…');
    await promo.waitForIdle();
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
