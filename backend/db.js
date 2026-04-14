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

const db = {
  query:      (sql, p) => pool.query(sql, p),
  one:        async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  oneOrNone:  async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many:       async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
  any:        async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

module.exports = { pool, db };
