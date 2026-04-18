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
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.warn('[SECURITY WARNING] JWT_SECRET env var is not set — using insecure default. Set JWT_SECRET in production!');
      return 'loyalpro_dev_secret_change_in_production';
    }
    return secret;
  })(),

  // YClients API
  YC: 'https://api.yclients.com/api/v1',
  FRONTEND_URL: process.env.FRONTEND_URL || '*',

  // CORS — comma-separated list of allowed origins, e.g.:
  // ALLOWED_ORIGINS=http://89.22.233.73,http://89.22.233.73:8081
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : null,

  // API Access Control
  API_PUBLIC: ['/api/auth/login', '/api/auth/register', '/api/app-settings'],
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings'],

  // Sync
  SYNC_DAYS: 365,
};
