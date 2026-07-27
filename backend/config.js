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

  // Knowledge-base AI assistant (Gemini). Dual-key: free первым, paid по fallback на 429.
  // Внимание: как только на Google-проекте включён биллинг, бесплатный тариф на нём
  // исчезает — поэтому нужны ДВА ключа из двух разных проектов.
  KB_GEMINI_KEY_FREE: process.env.KB_GEMINI_KEY_FREE || '',   // проект без биллинга (основной)
  KB_GEMINI_KEY_PAID: process.env.KB_GEMINI_KEY_PAID || '',   // ключ periaiassistent (резерв)
  // gemini-*-latest — алиасы на актуальную модель; gemini-2.5-flash отдаёт 404 новым ключам.
  KB_LLM_MODEL:       process.env.KB_LLM_MODEL       || 'gemini-flash-lite-latest',
  // Эмбеддинги для RAG. text-embedding-004 = 768 значений. Через тот же relay, что и чат.
  KB_EMBED_MODEL: process.env.KB_EMBED_MODEL || 'text-embedding-004',
  // Relay: регион прод-сервера гео-заблокирован Gemini free API ("User location is not
  // supported"). Прод шлёт промпт на dev (в поддерживаемом регионе), тот вызывает Gemini
  // и возвращает ответ. Пусто на dev → прямой вызов Google. Секрет защищает /api/kb/relay.
  KB_GEMINI_RELAY_URL:    process.env.KB_GEMINI_RELAY_URL    || '',
  KB_GEMINI_RELAY_SECRET: process.env.KB_GEMINI_RELAY_SECRET || '',

  // Chatpush — мессенджер-платформа (WhatsApp/Telegram/MAX/SMS) для двустороннего
  // диалогового агента. instanceToken — Bearer token инстанса: отправка, приём И
  // регистрация webhooks (для ОДНОГО аккаунта api_key НЕ нужен — подтверждено
  // поддержкой). apiKey — девелоперский мастер-токен, нужен лишь для управления
  // НЕСКОЛЬКИМИ аккаунтами (/developer/v1/*).
  // webhookSecret — свой секрет: регистрируем URL как
  //   https://<host>/chatpush/webhook?key=<secret>  и сверяем ?key= (timing-safe).
  CHATPUSH: {
    apiBase:       process.env.CHATPUSH_API_BASE       || 'https://api.chatpush.ru',
    apiKey:        process.env.CHATPUSH_API_KEY        || '',
    instanceToken: process.env.CHATPUSH_INSTANCE_TOKEN || '',
    webhookSecret: process.env.CHATPUSH_WEBHOOK_SECRET || '',
    // Фаза 1: приём ВСЕХ входящих без авто-ответа. Агент включается флагом.
    agentEnabled:  process.env.CHATPUSH_AGENT_ENABLED === 'true',
    // Single-tenant мэппинг инстанс→салон: customer_id инстанса → salon_id.
    // Позже заменится колонкой salons.chatpush_customer_id.
    customerId:    process.env.CHATPUSH_CUSTOMER_ID ? parseInt(process.env.CHATPUSH_CUSTOMER_ID, 10) : null,
    salonId:       process.env.CHATPUSH_SALON_ID ? parseInt(process.env.CHATPUSH_SALON_ID, 10) : null,
  },

  // ── ИИ-агент-администратор (диалог + запись). Движок — Claude tool-calling. ──
  // Ключ Anthropic. Claude не гео-блокируется на dev (Финляндия) — прямой вызов.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  AGENT_LLM_MODEL:   process.env.AGENT_LLM_MODEL   || 'claude-opus-4-8',
  AGENT_MAX_TOKENS:  process.env.AGENT_MAX_TOKENS ? parseInt(process.env.AGENT_MAX_TOKENS, 10) : 4096,
  // Дебаунс серии сообщений (мс) — используется диспетчером в Фазе 2b.
  AGENT_DEBOUNCE_MS: process.env.AGENT_DEBOUNCE_MS ? parseInt(process.env.AGENT_DEBOUNCE_MS, 10) : 5000,
  // User-токен приложения-интеграции LoyalPRO — используется ТОЛЬКО для СОЗДАНИЯ
  // записей, чтобы автор в YClients был «LoyalPRO», а не личная УЗ владельца
  // (иначе created_user_id = владелец yclients_user_token). Чтения слотов/каталога
  // это не трогает. Пусто → запись создаётся под salons.yclients_user_token (как раньше).
  YCLIENTS_INTEGRATION_USER_TOKEN: process.env.YCLIENTS_INTEGRATION_USER_TOKEN || '',

  // ── aitunnel.ru — OpenAI-совместимый агрегатор (обход геоблока, оплата ₽). ──
  // Единая точка для агента (Gemini 3.1 Flash Lite) и базы знаний (чат + эмбеддинги).
  AITUNNEL_API_KEY:     process.env.AITUNNEL_API_KEY     || '',
  AITUNNEL_BASE:        process.env.AITUNNEL_BASE        || 'https://api.aitunnel.ru/v1',
  AITUNNEL_CHAT_MODEL:  process.env.AITUNNEL_CHAT_MODEL  || 'gemini-3.1-flash-lite',
  // Аварийная модель: если основная (обычно Gemini Flash Lite) флапает транзиентно
  // подряд (421 «нет usage», таймаут, 5xx), тот же запрос добивается через неё.
  // Claude тем же ключом всегда отдаёт usage → биллинг-прокси aitunnel не рубит 421.
  // Sonnet, не Haiku: пилот показал Haiku ненадёжным на booking (ложный успех,
  // битые tool-id); fallback редок, цена Sonnet в агрегате пренебрежима. Пусто = выкл.
  AITUNNEL_FALLBACK_MODEL:      process.env.AITUNNEL_FALLBACK_MODEL      || 'claude-sonnet-4.6',
  AITUNNEL_FALLBACK_TIMEOUT_MS: process.env.AITUNNEL_FALLBACK_TIMEOUT_MS
    ? parseInt(process.env.AITUNNEL_FALLBACK_TIMEOUT_MS, 10) : 30000,
  AITUNNEL_EMBED_MODEL: process.env.AITUNNEL_EMBED_MODEL || 'gemini-embedding-001',
  AITUNNEL_EMBED_DIM:   process.env.AITUNNEL_EMBED_DIM ? parseInt(process.env.AITUNNEL_EMBED_DIM, 10) : 3072,

  // ── polza.ai — OpenAI-совместимый агрегатор (наценка ~6%, оплата картой РФ). ──
  // Модели по id вида `anthropic/claude-sonnet-4.6`. Уход с aitunnel после
  // инцидентов 402/421 (план миграции 2026-07-25). usage.cost_rub в ответе есть.
  POLZA_API_KEY:        process.env.POLZA_API_KEY        || '',
  POLZA_BASE:           process.env.POLZA_BASE           || 'https://api.polza.ai/api/v1',
  POLZA_CHAT_MODEL:     process.env.POLZA_CHAT_MODEL     || 'anthropic/claude-sonnet-4.6',
  // Аварийная модель при персистентном транзиентном сбое основной (429/5xx/сеть).
  // Sonnet 5: tool-calling проверен live 2026-07-26. Пусто = выкл.
  POLZA_FALLBACK_MODEL:      process.env.POLZA_FALLBACK_MODEL      || 'anthropic/claude-sonnet-5',
  POLZA_FALLBACK_TIMEOUT_MS: process.env.POLZA_FALLBACK_TIMEOUT_MS
    ? parseInt(process.env.POLZA_FALLBACK_TIMEOUT_MS, 10) : 30000,

  // Провайдер диалогового агента: 'aitunnel' (Gemini) | 'polza' (Claude) | 'anthropic' (прямой, откат).
  AGENT_PROVIDER:       process.env.AGENT_PROVIDER       || 'aitunnel',
  // Каталог услуг в системном промпте вместо инструмента list_services
  // (кэшируемый префикс, ~5× меньше токенов). Откат: убрать env + рестарт.
  AGENT_CATALOG_IN_PROMPT: process.env.AGENT_CATALOG_IN_PROMPT === 'true',
  // Провайдер базы знаний: 'aitunnel' | 'gemini' (старый релей/прямой вызов, откат).
  KB_PROVIDER:          process.env.KB_PROVIDER          || 'aitunnel',

  // CORS — comma-separated list of allowed origins, e.g.:
  // ALLOWED_ORIGINS=http://89.22.233.73,http://89.22.233.73:8081
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : null,

  // API Access Control
  API_PUBLIC: ['/api/auth/login', '/api/auth/register', '/api/app-settings', '/api/salon/logo', '/api/kb/relay', '/api/kb/relay/embed'],
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings', '/api/patient-portfolio', '/api/analytics/staff-dashboard', '/api/medical-cert', '/api/kb'],

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
