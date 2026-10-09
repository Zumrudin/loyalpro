// ============================================================
// Database Pool & Helpers
// ============================================================
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DB_SSL,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// Secondary pool — Beget (Telegram bot DB)
const botPool = new Pool({
  host:     process.env.BOT_DB_HOST,
  port:     parseInt(process.env.BOT_DB_PORT || '5432'),
  database: process.env.BOT_DB_NAME,
  user:     process.env.BOT_DB_USER,
  password: process.env.BOT_DB_PASSWORD,
  ssl:      false,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

const db = {
  query:      (sql, p) => pool.query(sql, p),
  one:        async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  oneOrNone:  async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many:       async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
  any:        async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

const botDb = {
  query:     (sql, p) => botPool.query(sql, p),
  one:       async (sql, p) => { const r = await botPool.query(sql, p); return r.rows[0] || null; },
  oneOrNone: async (sql, p) => { const r = await botPool.query(sql, p); return r.rows[0] || null; },
  many:      async (sql, p) => { const r = await botPool.query(sql, p); return r.rows; },
  any:       async (sql, p) => { const r = await botPool.query(sql, p); return r.rows; },
};

// Транзакция на выделенном клиенте пула: fn(client) → результат. Коммит при
// успехе, откат при исключении, клиент возвращается в пул всегда. ЗАЧЕМ: смена
// активного аккаунта мессенджера — два UPDATE/INSERT под частичным UNIQUE
// (salon_id, channel) WHERE status='active': между ними канал не должен
// остаться без активной строки, а упавший второй шаг — откатить первый.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* соединение могло умереть */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, db, botDb, withTransaction };
