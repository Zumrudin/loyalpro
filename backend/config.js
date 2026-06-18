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
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings', '/api/patient-portfolio', '/api/analytics/staff-dashboard'],

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

  // URL политики обработки ПДн для чекбокса согласия (152-ФЗ). Клиника указывает свой.
  CERT_REQUEST_POLICY_URL: process.env.CERT_REQUEST_POLICY_URL || '/privacy-policy.html',

  // Домены, которым разрешено встраивать публичную форму заявки в iframe (Wix и т.п.).
  // Через запятую в env CERT_REQUEST_FRAME_ANCESTORS, иначе дефолт ниже.
  CERT_REQUEST_FRAME_ANCESTORS: (process.env.CERT_REQUEST_FRAME_ANCESTORS
    ? process.env.CERT_REQUEST_FRAME_ANCESTORS.split(',').map(s => s.trim()).filter(Boolean)
    : ['https://*.wixsite.com', 'https://*.editorx.io', 'https://*.wix.com', 'https://*.filesusr.com', 'https://zumrudin.ru', 'https://www.zumrudin.ru', 'https://peri-clinic.ru', 'https://www.peri-clinic.ru']),

  // Medical Certificate КНД 1151156 — clinic defaults
  MEDICAL_CERT_CLINIC: {
    org_name: process.env.MEDCERT_ORG_NAME || 'ООО «КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ «ПЕРИ КЛИНИК»',
    org_inn:  process.env.MEDCERT_ORG_INN  || '9724060392',
    org_kpp:  process.env.MEDCERT_ORG_KPP  || '772401001',
    signer_name: process.env.MEDCERT_SIGNER || 'Гаджиева Пери Исамудиновна',
  },
};
