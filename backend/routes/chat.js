'use strict';
// ============================================================
// Chat (read-only) — просмотр переписок chatpush.
// ------------------------------------------------------------
// Диалоги неявно группируются по (salon_id, phone|chat_id) поверх таблицы
// chatpush_messages (её наполняет routes/chatpush-webhook.js). Только чтение:
// ни отправки, ни записи в БД. Доступ — owner/admin.
// ============================================================
const router = require('express').Router();
const { db } = require('../db');
const multer = require('multer');
const config = require('../config');
const { auth, requireRole, authOrQuery } = require('../middleware/auth');
const chatpush = require('../services/chatpush');
const { messagePreview, isGroupKey, recipientParams, DIALOG_KEY_SQL, dialogKey, phoneMatchCandidates } = require('../services/chat');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');

const chatEvents = require('../services/chat-events');

// admin_cashier — «Администратор-кассир»: полный доступ к чату наравне с owner/admin.
const adminOnly = [auth, requireRole('owner', 'admin', 'admin_cashier')];
// Для SSE: EventSource не умеет заголовки, токен едет в ?token= —
// route-уровневый auth должен принимать query (authOrQuery), не только Bearer.
const adminOnlyQuery = [authOrQuery, requireRole('owner', 'admin', 'admin_cashier')];

// GET /api/chat/stream — SSE-поток событий чата салона. JWT через ?token=.
// Соединение держим открытым, heartbeat — в chat-events.
router.get('/stream', adminOnlyQuery, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx: не буферизовать SSE
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  chatEvents.subscribe(req.user.salonId, res);
});

// GET /api/chat/dialogs — список диалогов салона (последнее сообщение + счётчик).
// Ключ v2: группы (chat_id с «-») — один тред 'g:'+chat_id, личные — по номеру.
// Имя/канал/идентификаторы берём из последнего ВХОДЯЩЕГО (иначе диалог
// назывался бы аккаунтом клиники, когда последнее сообщение исходящее).
router.get('/dialogs', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const { rows } = await db.query(`
      WITH msgs AS (
        SELECT *, ${DIALOG_KEY_SQL} AS dialog_key
        FROM chatpush_messages
        WHERE salon_id = $1
      ),
      last_msg AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, direction, msg_type, text, msg_ts, channel
        FROM msgs ORDER BY dialog_key, msg_ts DESC NULLS LAST
      ),
      last_in AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, channel AS in_channel, sender_name AS in_sender,
               phone AS in_phone, chat_id AS in_chat_id, client_id
        FROM msgs WHERE direction = 'incoming'
        ORDER BY dialog_key, msg_ts DESC NULLS LAST
      ),
      agg AS (
        SELECT dialog_key, COUNT(*) AS cnt,
               array_agg(DISTINCT channel) AS channels
        FROM msgs GROUP BY dialog_key
      )
      SELECT m.dialog_key, m.direction AS last_direction, m.msg_type AS last_msg_type,
             m.text AS last_text, m.msg_ts AS last_ts, m.channel AS last_channel,
             i.in_channel, i.in_sender, i.in_phone, i.in_chat_id, i.client_id,
             cl.name AS client_name,
             a.cnt AS messages_count, a.channels
      FROM last_msg m
      JOIN agg a ON a.dialog_key = m.dialog_key
      LEFT JOIN last_in i ON i.dialog_key = m.dialog_key
      LEFT JOIN clients cl ON cl.id = i.client_id AND cl.salon_id = $1
      ORDER BY m.msg_ts DESC NULLS LAST
    `, [salonId]);

    const dialogs = rows.map(r => {
      const isGroup = isGroupKey(r.dialog_key);
      return {
        key:           r.dialog_key,
        isGroup,
        channel:       r.in_channel || r.last_channel,
        senderName:    r.in_sender,
        phone:         r.in_phone || (!isGroup && /^\d+$/.test(r.dialog_key) ? r.dialog_key : null),
        chatId:        r.in_chat_id || null,
        lastDirection: r.last_direction,
        lastText:      messagePreview({ msg_type: r.last_msg_type, text: r.last_text }),
        lastTs:        r.last_ts,
        messagesCount: Number(r.messages_count) || 0,
        channels:      r.channels || [],
        defaultChannel: r.in_channel || (r.channels && r.channels[0]) || null,
        client:        r.client_id ? { id: r.client_id, name: r.client_name } : null,
      };
    });
    res.json({ dialogs });
  } catch (e) {
    logger.error(`dialogs failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить диалоги' });
  }
});

// GET /api/chat/dialogs/:key/messages — история одного диалога (по возрастанию).
// ?after=<msg_ts> — инкрементальная выборка для фонового доопроса.
router.get('/dialogs/:key/messages', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    const after = Number(req.query.after);
    const { rows } = await db.query(`
      SELECT id, direction, channel, msg_type, text, file_url, mime_type,
             sender_name, msg_ts
      FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND ($3::bigint IS NULL OR msg_ts > $3)
      ORDER BY msg_ts ASC NULLS FIRST, id ASC
    `, [salonId, key, Number.isFinite(after) && after > 0 ? after : null]);
    res.json({ messages: rows });
  } catch (e) {
    logger.error(`messages failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить сообщения' });
  }
});

// GET /api/chat/dialogs/:key/agent — статус агента по диалогу (для баннера).
router.get('/dialogs/:key/agent', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    const row = await db.oneOrNone(
      `SELECT status, escalated_reason FROM agent_dialogs
        WHERE salon_id = $1 AND dialog_key = $2`,
      [salonId, key]);
    // Нет строки → агент этим диалогом ещё не занимался: считаем 'bot'.
    res.json({ status: row ? row.status : 'bot', escalatedReason: row ? row.escalated_reason : null });
  } catch (e) {
    logger.error(`agent status failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить статус агента' });
  }
});

// POST /api/chat/dialogs/:key/agent — переключить бот ↔ оператор.
// body: { status: 'bot' | 'escalated' }. 'bot' = вернуть управление боту.
router.post('/dialogs/:key/agent', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    const status = req.body && req.body.status === 'escalated' ? 'escalated' : 'bot';
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    // Upsert: диалога может ещё не быть в agent_dialogs, если бот не отвечал.
    await db.query(
      `INSERT INTO agent_dialogs (salon_id, dialog_key, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (salon_id, dialog_key)
         DO UPDATE SET status = $3, updated_at = now()`,
      [salonId, key, status]);
    res.json({ status });
  } catch (e) {
    logger.error(`agent toggle failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось переключить режим' });
  }
});

// ── Отправка ответов оператора ──────────────────────────────────

// Ручной ответ ставит бота на паузу (кнопка «Вернуть боту» уже есть в шапке).
// Группы пропускаем: agent_dialogs живёт на ключе phone||chat_id, в группах бот не работает.
async function pauseAgent(salonId, key) {
  if (isGroupKey(key)) return;
  await db.query(
    `INSERT INTO agent_dialogs (salon_id, dialog_key, status, escalated_reason)
     VALUES ($1, $2, 'escalated', 'operator_reply')
     ON CONFLICT (salon_id, dialog_key)
       DO UPDATE SET status='escalated', escalated_reason='operator_reply', updated_at=now()`,
    [salonId, key]);
}

// Идентификаторы получателя: последнее ВХОДЯЩЕЕ выбранного канала (самый
// достоверный chat_id). Фолбэк — последнее входящее любого канала, но берём
// только phone: chat_id одного канала бессмысленен (и опасен как max_user_id)
// для другого. Это ветка для WhatsApp/MAX по номеру, когда в этот канал клиент
// ещё не писал; Telegram без своего chat_id так не адресуется (recipientParams
// вернёт null → 422), что и правильно — «холодный» tdlib инициировать нельзя.
async function resolveRecipient(salonId, key, channel) {
  const q = (extra, params) => db.oneOrNone(`
    SELECT phone, chat_id FROM chatpush_messages
    WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'incoming' ${extra}
    ORDER BY msg_ts DESC NULLS LAST LIMIT 1`, params);
  const exact = await q('AND channel = $3', [salonId, key, channel]);
  if (exact) return exact;
  const any = await q('', [salonId, key]);
  return any ? { phone: any.phone, chat_id: null } : null;
}

// Сохранить исходящее в WhatsApp СРАЗУ при отправке + запушить в SSE.
// Chatpush перестал слать эхо наших WhatsApp-отправок (см. services/chatpush) —
// без этого сообщение живёт лишь оптимистичным пузырём и пропадает после
// перезагрузки. tdlib/max эхо шлют исправно, их сохраняет вебхук — не трогаем.
// external_message_id = api:<delivery_id>: если эхо вернётся, вебхук дедупит по
// нему (chatpush.deliveryIdFromWhatsappEchoId). ON CONFLICT — на случай гонки.
async function persistWhatsappOutgoing(salonId, { delivery, phone, chatId, text, msgType, fileUrl, mimeType }) {
  if (!salonId || !delivery || delivery.id == null) return;
  let clientId = null;
  try {
    const cands = phoneMatchCandidates(phone);
    if (cands.length) {
      const row = await db.oneOrNone(
        'SELECT id FROM clients WHERE salon_id=$1 AND phone = ANY($2) LIMIT 1', [salonId, cands]);
      clientId = row?.id || null;
    }
  } catch (e) { logger.warn(`client match failed for ${phone}: ${e.message}`); }

  const ts = Math.floor(Date.now() / 1000);
  const externalId = chatpush.ownOutgoingExternalId(delivery.id);
  const ins = await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, client_id, customer_id, channel, direction, external_message_id,
        msg_type, text, file_url, mime_type, phone, chat_id, msg_ts)
     VALUES ($1,$2,$3,'whatsapp','outgoing',$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING
     RETURNING id`,
    [salonId, clientId, config.CHATPUSH.customerId, externalId,
     msgType, text || '', fileUrl, mimeType, phone, chatId, ts]
  );
  if (ins.rowCount > 0) {
    chatEvents.emit(salonId, {
      type: 'message',
      dialogKey: dialogKey({ phone, chat_id: chatId }),
      message: {
        id: ins.rows[0].id, direction: 'outgoing', channel: 'whatsapp',
        msg_type: msgType, text: text || '',
        file_url: fileUrl, mime_type: mimeType, sender_name: null, msg_ts: ts,
      },
    });
  }
}

// POST /api/chat/dialogs/:key/send — ручной ответ оператора. body: {text, channel}.
// Сообщение НЕ пишем в chatpush_messages сами: Chatpush пришлёт эхо в вебхук
// (как с ответами бота) — единый источник правды, без дедупа.
router.post('/dialogs/:key/send', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    const text = String((req.body && req.body.text) || '').trim();
    const channel = String((req.body && req.body.channel) || '').trim();
    if (!key)  return res.status(400).json({ error: 'Пустой ключ диалога' });
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    if (text.length > 3500) return res.status(400).json({ error: 'Слишком длинное сообщение (макс. 3500)' });
    if (!channel) return res.status(400).json({ error: 'Не выбран канал' });

    const rcp = await resolveRecipient(salonId, key, channel);
    const params = rcp && recipientParams(channel, { ...rcp, isGroup: isGroupKey(key) });
    if (!params) return res.status(422).json({ error: 'Не найден получатель для этого канала' });

    const delivery = await chatpush.sendMessage(config.CHATPUSH.instanceToken, { text, ...params });
    await pauseAgent(salonId, key);
    logger.info(`operator sent ${channel} to ${key}: ${text.slice(0, 60)}`);
    if (channel === 'whatsapp') {
      try {
        await persistWhatsappOutgoing(salonId, {
          delivery, phone: params.phone, chatId: rcp.chat_id || null,
          text, msgType: 'text', fileUrl: null, mimeType: null,
        });
      } catch (e) { logger.error(`persist whatsapp outgoing failed: ${e.message}`); }
    }
    res.json({ ok: true, deliveryId: delivery.id, status: delivery.status_description });
  } catch (e) {
    logger.error(`send failed: ${e.message}`);
    res.status(502).json({ error: 'Не удалось отправить: ' + e.message });
  }
});

// Форматы из доки Chatpush send_file. Всё прочее режем до отправки.
const CHAT_FILE_MIMES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip', 'application/x-7z-compressed',
  'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/aac', 'audio/mp4',
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4',
]);
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, CHAT_FILE_MIMES.has(file.mimetype)),
});

// Каналы, в которые Chatpush умеет файлы (send_file: whatsapp | tdlib | max).
const FILE_CHANNELS = new Set(['whatsapp', 'tdlib', 'max']);

// POST /api/chat/dialogs/:key/send-file — multipart: file (обязателен),
// text (подпись, опционально), channel. Персист — эхом вебхука, как у /send.
router.post('/dialogs/:key/send-file', adminOnly, chatUpload.single('file'), async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    const caption = String((req.body && req.body.text) || '').trim() || undefined;
    let channel = String((req.body && req.body.channel) || '').trim();
    if (channel === 'telegram_bot') channel = 'tdlib';
    if (channel === 'max_bot') channel = 'max';
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран или формат не поддерживается' });
    if (!FILE_CHANNELS.has(channel)) return res.status(400).json({ error: 'Файлы можно отправить только в WhatsApp, Telegram или MAX' });

    const rcp = await resolveRecipient(salonId, key, channel);
    const params = rcp && recipientParams(channel, { ...rcp, isGroup: isGroupKey(key) });
    if (!params) return res.status(422).json({ error: 'Не найден получатель для этого канала' });

    const isImage = /^image\/(jpeg|png|webp)$/.test(req.file.mimetype) && req.file.size < 10 * 1024 * 1024;
    // Имя обязано содержать расширение (требование Chatpush); кириллицу не шлём.
    const ext = (req.file.originalname.match(/\.[A-Za-z0-9]+$/) || [''])[0] || '';
    const fileName = `file_${Date.now()}${ext}`;
    const delivery = await chatpush.sendFile(config.CHATPUSH.instanceToken, {
      fileName, caption, type: isImage ? 'image' : 'document', ...params,
    }, req.file.buffer, req.file.mimetype);
    await pauseAgent(salonId, key);
    logger.info(`operator sent file ${channel} to ${key}: ${req.file.originalname} (${req.file.size} b)`);
    if (channel === 'whatsapp') {
      try {
        // file_url null: ссылку на медиа Chatpush отдаёт только в эхе (которого
        // для WhatsApp нет) — сохраняем подпись/имя, чтобы сообщение не пропадало.
        await persistWhatsappOutgoing(salonId, {
          delivery, phone: params.phone, chatId: rcp.chat_id || null,
          text: caption || ('📎 ' + req.file.originalname),
          msgType: isImage ? 'image' : 'document', fileUrl: null, mimeType: req.file.mimetype,
        });
      } catch (e) { logger.error(`persist whatsapp outgoing file failed: ${e.message}`); }
    }
    res.json({ ok: true, deliveryId: delivery.id, status: delivery.status_description });
  } catch (e) {
    logger.error(`send-file failed: ${e.message}`);
    res.status(502).json({ error: 'Не удалось отправить файл: ' + e.message });
  }
});

module.exports = router;
