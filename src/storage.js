import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

/**
 * Creates a unified Storage adapter:
 * - If process.env.DATABASE_URL is provided: uses Neon PostgreSQL.
 * - Otherwise: seamlessly falls back to the local ./data filesystem.
 */
export function createStorage({ dataDir, databaseUrl = process.env.DATABASE_URL, logger = console }) {
  const isPostgres = Boolean(databaseUrl && databaseUrl.trim().startsWith('postgres'));

  let pool = null;
  if (isPostgres) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false }, // Neon requires SSL
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  const files = {
    state: path.join(dataDir, 'state.json'),
    backup: path.join(dataDir, 'price-backup.json'),
    simulation: path.join(dataDir, 'last-simulation.json'),
    audit: path.join(dataDir, 'audit.log'),
    historyDir: path.join(dataDir, 'history'),
  };

  async function init() {
    if (isPostgres) {
      logger.log('[storage] 🐘 Connexion à la base de données Neon PostgreSQL…');
      try {
        const client = await pool.connect();
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS promo_state (
              id VARCHAR(64) PRIMARY KEY,
              data JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS price_backups (
              id VARCHAR(64) PRIMARY KEY,
              data JSONB NOT NULL,
              is_active BOOLEAN NOT NULL DEFAULT TRUE,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              archived_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
              id SERIAL PRIMARY KEY,
              timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              user_email VARCHAR(255),
              event VARCHAR(100) NOT NULL,
              details JSONB
            );
          `);
          logger.log('[storage] ✅ Tables Neon PostgreSQL prêtes (promo_state, price_backups, audit_logs).');
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error(`[storage] ❌ Erreur de connexion Neon : ${err.message}`);
        throw err;
      }
    } else {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(files.historyDir, { recursive: true });
      logger.log('[storage] 📁 Utilisation du stockage local sur disque (./data).');
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async function readState(fallback = {}) {
    if (isPostgres) {
      try {
        const res = await pool.query('SELECT data FROM promo_state WHERE id = $1', ['current']);
        if (res.rows.length && res.rows[0].data) {
          return res.rows[0].data;
        }
        return fallback;
      } catch (err) {
        logger.warn(`[storage] Échec lecture état Postgres : ${err.message}`);
        return fallback;
      }
    }

    try {
      const raw = await fs.readFile(files.state, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  async function writeState(state) {
    if (isPostgres) {
      await pool.query(
        `INSERT INTO promo_state (id, data, updated_at)
         VALUES ('current', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [state]
      );
      return;
    }

    const tmp = `${files.state}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, files.state);
  }

  // -------------------------------------------------------------------------
  // Price Backups
  // -------------------------------------------------------------------------

  async function readBackup() {
    if (isPostgres) {
      const res = await pool.query(
        'SELECT data FROM price_backups WHERE id = $1 AND is_active = TRUE',
        ['active']
      );
      return res.rows.length ? res.rows[0].data : null;
    }

    try {
      const raw = await fs.readFile(files.backup, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeBackup(backupData) {
    if (isPostgres) {
      await pool.query(
        `INSERT INTO price_backups (id, data, is_active, created_at)
         VALUES ('active', $1, TRUE, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, is_active = TRUE, created_at = NOW(), archived_at = NULL`,
        [backupData]
      );
      return;
    }

    const tmp = `${files.backup}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(backupData, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, files.backup);
  }

  async function archiveBackup(label) {
    if (isPostgres) {
      const archiveId = `backup_${Date.now()}_${label}`;
      await pool.query(
        `INSERT INTO price_backups (id, data, is_active, created_at, archived_at)
         SELECT $1, data, FALSE, created_at, NOW()
         FROM price_backups WHERE id = 'active'`,
        [archiveId]
      );
      await pool.query("UPDATE price_backups SET is_active = FALSE WHERE id = 'active'");
      return archiveId;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(files.historyDir, `price-backup-${stamp}-${label}.json`);
    await fs.mkdir(files.historyDir, { recursive: true });
    try {
      await fs.rename(files.backup, target);
      return target;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Simulations
  // -------------------------------------------------------------------------

  async function writeSimulation(simData) {
    if (isPostgres) {
      await pool.query(
        `INSERT INTO promo_state (id, data, updated_at)
         VALUES ('last_simulation', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [simData]
      );
      return;
    }

    const tmp = `${files.simulation}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(simData, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, files.simulation);
  }

  // -------------------------------------------------------------------------
  // Audit Logs (Avec horodatage précis de chaque action)
  // -------------------------------------------------------------------------

  async function appendAudit(event, userEmail = null, details = {}) {
    const timestamp = new Date().toISOString();
    if (isPostgres) {
      try {
        await pool.query(
          'INSERT INTO audit_logs (timestamp, user_email, event, details) VALUES (NOW(), $1, $2, $3)',
          [userEmail, event, details]
        );
      } catch (err) {
        logger.warn(`[storage] Échec enregistrement audit Postgres : ${err.message}`);
      }
      return;
    }

    const entry = { ts: timestamp, event, email: userEmail, details };
    try {
      await fs.appendFile(files.audit, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      logger.warn(`[storage] Échec enregistrement audit fichier : ${err.message}`);
    }
  }

  async function readAudit({ limit = 50, promoOnly = false } = {}) {
    if (isPostgres) {
      try {
        const query = promoOnly
          ? "SELECT timestamp, user_email, event, details FROM audit_logs WHERE event LIKE 'promo_%' OR event LIKE 'recovery_%' ORDER BY id DESC LIMIT $1"
          : "SELECT timestamp, user_email, event, details FROM audit_logs ORDER BY id DESC LIMIT $1";
        const res = await pool.query(query, [limit]);
        return res.rows.map((r) => ({
          ts: r.timestamp.toISOString(),
          event: r.event,
          email: r.user_email,
          details: r.details,
        }));
      } catch (err) {
        logger.warn(`[storage] Échec lecture audit Postgres : ${err.message}`);
        return [];
      }
    }

    try {
      const raw = await fs.readFile(files.audit, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const entries = [];
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (promoOnly && !parsed.event.startsWith('promo_') && !parsed.event.startsWith('recovery_')) {
            continue;
          }
          entries.push(parsed);
        } catch {
          // ignore corrupted lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  return {
    isPostgres,
    init,
    readState,
    writeState,
    readBackup,
    writeBackup,
    archiveBackup,
    writeSimulation,
    appendAudit,
    readAudit,
  };
}
