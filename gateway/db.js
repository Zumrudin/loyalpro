'use strict';
const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.DATABASE_URL, ssl: config.DB_SSL, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
const db = {
  query: (sql, p) => pool.query(sql, p),
  oneOrNone: async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  any: async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};
module.exports = { pool, db };
