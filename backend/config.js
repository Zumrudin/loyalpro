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

  // Security — JWT_SECRET MUST be set. Fail fast instead of using an insecure default.
  // A leaked default would let an attacker forge tokens for any user/role.
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('JWT_SECRET env var is required and must be at least 32 chars. Refusing to start.');
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
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings', '/api/patient-portfolio'],

  // S3 (patient photo cases — Yandex Object Storage / S3-compatible)
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION || 'ru-central1',
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
  S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true',
  S3_URL_TTL_SECONDS: parseInt(process.env.S3_URL_TTL_SECONDS, 10) || 900,

  // Sync
  SYNC_DAYS: 365,
};
