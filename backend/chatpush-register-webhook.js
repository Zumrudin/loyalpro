// ============================================================
// Регистрация webhook в Chatpush (запускать ОДИН раз)
// ------------------------------------------------------------
// Требует в .env (для ОДНОГО аккаунта api_key НЕ нужен — подтверждено поддержкой):
//   CHATPUSH_INSTANCE_TOKEN — Bearer-токен инстанса (он же для отправки)
//   CHATPUSH_WEBHOOK_SECRET — секрет для ?key= (уже сгенерирован)
// Опционально:
//   CHATPUSH_WEBHOOK_BASE   — базовый https-хост (по умолчанию dev.zumrudin.ru)
//
// Запуск:  node chatpush-register-webhook.js
//          node chatpush-register-webhook.js --list     (только показать текущие)
//          node chatpush-register-webhook.js --delete=57 (удалить запись по id)
// ============================================================
require('dotenv').config();
const config = require('./config');
const chatpush = require('./services/chatpush');

const BASE = process.env.CHATPUSH_WEBHOOK_BASE || 'https://dev.zumrudin.ru';
const URL = `${BASE}/chatpush/webhook?key=${config.CHATPUSH.webhookSecret}`;

// Все события переписки + статусы + авторизация. Убери лишнее при желании.
const EVENTS = [
  'whatsapp_incoming_msg',
  'tdlib_incoming_msg',
  'telegram_bot_incoming_msg',
  'max_incoming_msg',
  'max_bot_incoming_msg',
  'whatsapp_status_msg',
  'whatsapp_log_in',
  'whatsapp_log_out',
];

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

(async () => {
  if (!config.CHATPUSH.instanceToken) fail('CHATPUSH_INSTANCE_TOKEN не задан в .env (Bearer-токен инстанса)');

  const arg = process.argv[2] || '';

  try {
    if (arg === '--list') {
      const all = await chatpush.listWebhooks();
      console.log('Текущие webhooks:\n' + JSON.stringify(all, null, 2));
      return;
    }
    if (arg.startsWith('--delete=')) {
      const id = arg.split('=')[1];
      const meta = await chatpush.deleteWebhook(id);
      console.log(`Удалён webhook ${id}:`, JSON.stringify(meta));
      return;
    }

    if (!config.CHATPUSH.webhookSecret) fail('CHATPUSH_WEBHOOK_SECRET не задан в .env');
    console.log('Регистрирую webhook →', URL);
    console.log('События:', EVENTS.join(', '));
    const wh = await chatpush.createWebhook(URL, EVENTS);
    console.log('\n✅ Создан webhook:\n' + JSON.stringify(wh, null, 2));

    const all = await chatpush.listWebhooks();
    console.log('\nВсе webhooks сейчас:\n' + JSON.stringify(all, null, 2));
  } catch (e) {
    const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    fail('Ошибка запроса к Chatpush: ' + body);
  }
})();
