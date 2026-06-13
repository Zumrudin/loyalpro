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

module.exports = { pool, db, botDb };
