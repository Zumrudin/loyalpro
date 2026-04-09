// ============================================================
// Configuration & Constants
// ============================================================
require('dotenv').config();

module.exports = {
  // Server
  PORT: process.env.PORT || 3001,

  // Database
  DATABASE_URL: process.env.DATABASE_URL,
  DB_SSL: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Security
  JWT_SECRET: process.env.JWT_SECRET || 'loyalpro_dev_secret_change_in_production',

  // YClients API
  YC: 'https://api.yclients.com/api/v1',
  FRONTEND_URL: process.env.FRONTEND_URL || '*',

  // API Access Control
  API_PUBLIC: ['/api/auth/login', '/api/auth/register'],
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings'],

  // Sync
  SYNC_DAYS: 365,
};
