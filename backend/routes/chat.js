'use strict';
// ============================================================
// Chat — просмотр переписок chatpush и ручные ответы оператора.
// ------------------------------------------------------------
// Диалоги неявно группируются по (salon_id, phone|chat_id) поверх таблицы
// chatpush_messages (её наполняет routes/chatpush-webhook.js).
// Доступ — owner/admin/admin_cashier.
// ============================================================
const router = require('express').Router();
const { db } = require('../db');
const multer = require('multer');
const config = require('../config');
const { auth, requireRole } = require('../middleware/auth');
const transport = require('../services/messaging/transport');
const accessTickets = require('../services/access-tickets');
const { messagePreview, isGroupKey, recipientParams, DIALOG_KEY_SQL } = require('../services/chat');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');
const { safeErrorCode } = require('../utils/safe-error');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const gatewayAttachmentSource = require('../services/gateway-attachment-source');

const chatEvents = require('../services/chat-events');
const { persistWhatsappOutgoing } = require('../services/chat-persist');
const authorship = require('../services/outgoing-authorship');
const dialogState = require('../services/agent/dialog-state');
const followupQueue = require('../services/agent/followup-queue');

const CHAT_DIALOGS_LIMIT = 500;
const GATEWAY_UPLOAD_ROOT = path.resolve(__dirname, '../../frontend/uploads/gateway');
const INLINE_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a',
  'video/mp4', 'video/quicktime', 'text/plain',
]);

// admin_cashier — «Администратор-кассир»: полный доступ к чату наравне с owner/admin.
const adminOnly = [auth, requireRole('owner', 'admin', 'admin_cashier')];

function privateAttachmentUrl(row) {
  return row && /^\/uploads\/gateway\//.test(String(row.file_url || ''))
    ? `/api/chat/attachments/${row.id}` : row?.file_url;
}

function gatewayAttachmentPath(fileUrl, accountId) {
  const prefix = `/uploads/gateway/${accountId}/`;
  const value = String(fileUrl || '');
  if (!value.startsWith(prefix)) return null;
  const name = value.slice(prefix.length);
  if (!name || name !== path.basename(name) || name === '.' || name === '..') return null;
  const absolute = path.resolve(GATEWAY_UPLOAD_ROOT, String(accountId), name);
  const accountRoot = path.resolve(GATEWAY_UPLOAD_ROOT, String(accountId));
  return absolute.startsWith(accountRoot + path.sep) ? absolute : null;
}

async function resolveGatewayAttachment(fileUrl, accountId) {
  const candidate = gatewayAttachmentPath(fileUrl, accountId);
  if (!candidate) return null;
  try {
    const [realAccountRoot, realFile] = await Promise.all([
      fs.promises.realpath(path.join(GATEWAY_UPLOAD_ROOT, String(accountId))),
      fs.promises.realpath(candidate),
    ]);
    return realFile.startsWith(realAccountRoot + path.sep) ? realFile : null;
  } catch {
    return null;
  }
}

async function streamAuth(req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try {
    const staff = await accessTickets.consume(req.query.ticket, accessTickets.CHAT_STREAM_SCOPE);
    if (!staff) return res.status(401).json({ error: 'Stream ticket expired or invalid' });
    req.user = staff;
    next();
  } catch (_) {
    logger.error('stream ticket validation failed');
    res.status(503).json({ error: 'Chat stream is temporarily unavailable' });
  }
}

router.post('/stream-ticket', adminOnly, async (req, res) => {
  try {
    const grant = await accessTickets.issue(req.user, accessTickets.CHAT_STREAM_SCOPE);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.json(grant);
  } catch (_) {
    logger.error('stream ticket issuance failed');
    res.status(503).json({ error: 'Chat stream is temporarily unavailable' });
  }
});

router.get('/stream', streamAuth, requireRole('owner', 'admin', 'admin_cashier'), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
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
      WITH latest AS (
        SELECT DISTINCT ON (${DIALOG_KEY_SQL})
               ${DIALOG_KEY_SQL} AS dialog_key, msg_ts
        FROM chatpush_messages
        WHERE salon_id = $1
        ORDER BY ${DIALOG_KEY_SQL}, msg_ts DESC NULLS LAST, id DESC
      ),
      picked AS (
        SELECT dialog_key
        FROM latest
        ORDER BY msg_ts DESC NULLS LAST
        LIMIT $2
      ),
      msgs AS (
        SELECT cm.*, ${DIALOG_KEY_SQL} AS dialog_key
        FROM chatpush_messages cm
        JOIN picked p ON p.dialog_key = ${DIALOG_KEY_SQL}
        WHERE cm.salon_id = $1
      ),
      last_msg AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, direction, msg_type, text, msg_ts, channel
        FROM msgs ORDER BY dialog_key, msg_ts DESC NULLS LAST, id DESC
      ),
      last_in AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, channel AS in_channel, sender_name AS in_sender,
               phone AS in_phone, chat_id AS in_chat_id, client_id
        FROM msgs WHERE direction = 'incoming'
        ORDER BY dialog_key, msg_ts DESC NULLS LAST, id DESC
      ),
      agg AS (
        SELECT dialog_key, COUNT(*) AS cnt,
               array_agg(DISTINCT channel) AS channels
        FROM msgs GROUP BY dialog_key
      ),
      fu AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, status AS fu_status, stage AS fu_stage
        FROM agent_followups WHERE salon_id = $1
        ORDER BY dialog_key, created_at DESC
      )
      SELECT m.dialog_key, m.direction AS last_direction, m.msg_type AS last_msg_type,
             m.text AS last_text, m.msg_ts AS last_ts, m.channel AS last_channel,
             i.in_channel, i.in_sender, i.in_phone, i.in_chat_id, i.client_id,
             cl.name AS client_name,
             a.cnt AS messages_count, a.channels,
             ad.status AS agent_status, ad.escalated_reason,
             fu.fu_status, fu.fu_stage
      FROM last_msg m
      JOIN agg a ON a.dialog_key = m.dialog_key
      LEFT JOIN last_in i ON i.dialog_key = m.dialog_key
      LEFT JOIN clients cl ON cl.id = i.client_id AND cl.salon_id = $1
      LEFT JOIN agent_dialogs ad ON ad.salon_id = $1 AND ad.dialog_key = m.dialog_key
      LEFT JOIN fu ON fu.dialog_key = m.dialog_key
      ORDER BY m.msg_ts DESC NULLS LAST
    `, [salonId, CHAT_DIALOGS_LIMIT]);

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
        // Нет строки в agent_dialogs → бот этим диалогом не занимался (в т.ч. все группы).
        agentStatus:     r.agent_status || 'bot',
        escalatedReason: r.escalated_reason || null,
        // Статус переписки («ждём ответа», «напомнили» …) отдельным полем не
        // хранится — выводится фронтом (chat-wait-status.js) из этой пары полей
        // строки очереди agent_followups + agentStatus выше.
        followupStatus: r.fu_status || null,
        followupStage:  r.fu_stage == null ? null : Number(r.fu_stage),
      };
    });
    res.json({ dialogs, limit: CHAT_DIALOGS_LIMIT });
  } catch (e) {
    logger.error(`dialogs failed: ${safeErrorCode(e)}`);
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
    res.json({ messages: rows.map(row => ({ ...row, file_url: privateAttachmentUrl(row) })) });
  } catch (e) {
    logger.error(`messages failed: ${safeErrorCode(e)}`);
    res.status(500).json({ error: 'Не удалось загрузить сообщения' });
  }
});

// GET /api/chat/attachments/:messageId — private gateway media. Ownership is
// derived from the authenticated session and both persisted message/account
// rows; disabled accounts retain their salon's historical attachments.
router.get('/attachments/:messageId', adminOnly, async (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return res.status(404).end();
  try {
    const row = await db.oneOrNone(`
      SELECT cm.file_url, cm.mime_type, cm.customer_id AS account_id
      FROM chatpush_messages cm
      JOIN messenger_accounts ma
       ON ma.external_id = cm.customer_id::text
       AND ma.provider = 'gateway'
       AND ma.salon_id = cm.salon_id
      WHERE cm.id = $1 AND cm.salon_id = $2 AND cm.provider = 'gateway'
      LIMIT 1
    `, [messageId, req.user.salonId]);
    if (!row || !gatewayAttachmentPath(row.file_url, row.account_id)) return res.status(404).end();
    let remote = null;
    let filePath = null;
    if (config.GATEWAY_FILES_ORIGIN) {
      remote = await gatewayAttachmentSource.openRemoteAttachment(
        config.GATEWAY_FILES_ORIGIN, row.file_url, row.account_id);
      if (remote.status === 'missing') return res.status(404).end();
      if (remote.status !== 'ok') return res.status(503).json({ error: 'Вложение временно недоступно' });
    } else {
      filePath = await resolveGatewayAttachment(row.file_url, row.account_id);
      if (!filePath) return res.status(404).end();
    }
    const mimeType = String(row.mime_type || '').toLowerCase().split(';')[0].trim();
    const inline = INLINE_ATTACHMENT_MIMES.has(mimeType);
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': inline ? mimeType : 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : 'attachment',
    });
    if (remote) {
      try {
        await pipeline(remote.stream, res);
      } catch (_) {
        // pipeline destroys its destination on failure. Do not attempt a
        // second response with attachment MIME headers already selected.
        if (!res.destroyed) res.destroy();
      } finally {
        remote.close();
      }
      return;
    }
    return res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).end();
    });
  } catch (e) {
    logger.error(`attachment download failed: ${safeErrorCode(e)}`);
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    return res.status(500).json({ error: 'Не удалось загрузить вложение' });
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
    logger.error(`agent status failed: ${safeErrorCode(e)}`);
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
    // «Вернуть боту» ОБЯЗАН гасить escalated_reason: оркестратор читает его как
    // «диалог вернул тебе администратор ПОСЛЕ КОНФЛИКТА» (resumedFromEscalation)
    // и дописывает Миле соответствующий блок промпта. Без этого на проде осело
    // 21 диалог в состоянии status='bot' + reason='operator_reply', и каждый
    // ход Мила получала разбор конфликта, которого не было.
    await db.query(
      `INSERT INTO agent_dialogs (salon_id, dialog_key, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (salon_id, dialog_key)
         DO UPDATE SET status = $3,
           escalated_reason = CASE WHEN $3 = 'bot' THEN NULL
                                   ELSE agent_dialogs.escalated_reason END,
           updated_at = now()`,
      [salonId, key, status]);
    // Красная подсветка в списке диалогов у всех открытых вкладок — сразу.
    chatEvents.emitAgentStatus(salonId, key, status, status === 'escalated' ? 'operator_takeover' : null);
    if (status === 'escalated') {
      await followupQueue.close(salonId, key, 'cancelled', 'operator')
        .catch(e => logger.warn(`followup close failed: ${safeErrorCode(e)}`));
    }
    res.json({ status });
  } catch (e) {
    logger.error(`agent toggle failed: ${safeErrorCode(e)}`);
    res.status(500).json({ error: 'Не удалось переключить режим' });
  }
});

// ── Отправка ответов оператора ──────────────────────────────────

// Ручной ответ ставит бота на паузу (кнопка «Вернуть боту» уже есть в шапке).
// Группы пропускаем: agent_dialogs живёт на ключе phone||chat_id, в группах бот не работает.
// Сам upsert + SSE — в services/agent/dialog-state.pauseForOperator: тот же
// механизм нужен вебхуку, когда оператор отвечает мимо админки, прямо из
// приложения Chatpush. Двух копий правила быть не должно.
async function pauseAgent(salonId, key) {
  if (isGroupKey(key)) return;
  await dialogState.pauseForOperator(salonId, key);
}

// Идентификаторы получателя: последнее ВХОДЯЩЕЕ выбранного канала (самый
// достоверный chat_id). Фолбэк — последнее входящее любого канала, но берём
// только phone: chat_id одного канала бессмысленен (и опасен как max_user_id)
// для другого. Это ветка для WhatsApp/MAX по номеру, когда в этот канал клиент
// ещё не писал; Telegram без своего chat_id так не адресуется (recipientParams
// вернёт null → 422), что и правильно — «холодный» tdlib инициировать нельзя.
// reply_to — id последнего ВХОДЯЩЕГО в этом канале: отправка уходит ответом на
// него, ровно как реплика Милы (dispatcher.defaultSend всегда шлёт
// replyToMessageId входящего). Инцидент 2026-09-18 (tdlib 5245186003, номер
// скрыт, не в контактах): отправка по одному tdlib_user_id без reply_to
// получила от Chatpush «Невозможно доставить», повтор того же текста с reply_to
// дошёл. Механизм НЕ ДОКАЗАН (в тестовый чат, где собеседник в контактах, обе
// формы доходят; 13.08 в чужой чат без reply_to дошло через 7 мин после
// входящего) — рабочая версия: tdlib теряет peer собеседника со скрытым
// номером спустя часы, а ответ на его сообщение находит peer заново. Поэтому
// reply_to берётся ТОЛЬКО из того же канала: id сообщения WhatsApp в tdlib
// бессмысленен, фолбэк по номеру идёт без него.
async function resolveRecipient(salonId, key, channel) {
  const q = (extra, params) => db.oneOrNone(`
    SELECT phone, chat_id, external_message_id AS reply_to FROM chatpush_messages
    WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'incoming' ${extra}
    ORDER BY msg_ts DESC NULLS LAST LIMIT 1`, params);
  const exact = await q('AND channel = $3', [salonId, key, channel]);
  if (exact) return { phone: exact.phone, chat_id: exact.chat_id, reply_to: exact.reply_to || null };
  const any = await q('', [salonId, key]);
  return any ? { phone: any.phone, chat_id: null, reply_to: null } : null;
}

// Судьба ручной отправки: `delivery.status_description = Принято` — это очередь,
// а не доставка. Сторож `agent_reply_deliveries` ручные отправки не покрывает
// (повторять чужой текст автоматически нельзя), поэтому хотя бы ОДНА отложенная
// проверка `GET /api/v1/delivery/:id` с WARN в лог: инцидент 2026-09-18 разбирался
// по delivery id из HTTP-ответа, который нигде не сохранялся. Таймер unref —
// не держит процесс; deps — для тестов (jest fake timers + стаб статуса).
const DELIVERY_CHECK_MS = 30 * 1000;
const DELIVERY_STATUS_UNDELIVERABLE = 5;          // «Невозможно доставить» (проверено живьём 18.09)
const DELIVERY_FAILED_RE = /невозможно|ошибк|не доставлен|failed|error/i;
// salonId/accountId: статус спрашиваем у ТОГО аккаунта, которым ушло сообщение
// (transport кладёт accountId в delivery), иначе — у текущего аккаунта канала.
function scheduleDeliveryCheck(deliveryId, { key, channel, kind = 'message', salonId, accountId } = {}, deps = {}) {
  if (!deliveryId) return null;
  const get = deps.getDeliveryStatus
    || ((id) => transport.getDeliveryStatus(salonId, channel, id, { accountId }));
  const delay = deps.delayMs != null ? deps.delayMs : DELIVERY_CHECK_MS;
  const t = setTimeout(async () => {
    try {
      const d = await get(deliveryId);
      const st = (d && d.status) || {};
      const failed = Number(st.status_id) === DELIVERY_STATUS_UNDELIVERABLE
        || DELIVERY_FAILED_RE.test(String(st.description || ''));
      if (failed) {
        logger.warn(`operator ${kind} ${channel}: delivery=${deliveryId} status=${Number(st.status_id) || 0} НЕ ДОСТАВЛЕНО`);
      } else {
        logger.info(`operator ${kind} ${channel}: delivery=${deliveryId} status=${Number(st.status_id) || 0}`);
      }
    } catch (_) {
      logger.warn(`operator ${kind} ${channel}: delivery=${deliveryId} статус не получен`);
    }
  }, delay);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

// Delivery diagnostics use numeric provider statuses, never recipient/message text.

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

    // Эхо этой отправки придёт как обычное outgoing — пометим автора заранее,
    // чтобы в транскрипте Милы оно не выглядело её собственной репликой. ДО
    // отправки: эхо шлюза может прийти раньше, чем вернётся sendMessage; запись
    // от упавшей отправки безвредна (TTL, совпадения по тексту нет).
    await authorship.remember(salonId, key, text, 'operator');
    const delivery = await transport.sendMessage(salonId, {
      text, ...params, replyToMessageId: rcp.reply_to || undefined,
    });
    await pauseAgent(salonId, key);
    logger.info(`operator sent ${channel}: delivery=${delivery && delivery.id}`);
    scheduleDeliveryCheck(delivery && delivery.id, { key, channel, salonId, accountId: delivery && delivery.accountId });
    if (channel === 'whatsapp') {
      try {
        await persistWhatsappOutgoing(salonId, {
          delivery, phone: params.phone, chatId: rcp.chat_id || null,
          text, msgType: 'text', fileUrl: null, mimeType: null, authoredBy: 'operator',
        });
      } catch (e) { logger.error(`persist whatsapp outgoing failed: ${safeErrorCode(e)}`); }
    }
    res.json({ ok: true, deliveryId: delivery.id, status: delivery.status_description });
  } catch (e) {
    logger.error('send failed');
    res.status(502).json({ error: 'Не удалось отправить сообщение' });
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
    // Подпись к файлу приедет эхом отдельным текстом — помечаем её автором так же,
    // как обычную отправку оператора (до отправки: эхо шлюза может обогнать ответ).
    if (caption) await authorship.remember(salonId, key, caption, 'operator');
    const delivery = await transport.sendFile(salonId, {
      fileName, caption, type: isImage ? 'image' : 'document', ...params,
    }, req.file.buffer, req.file.mimetype);
    await pauseAgent(salonId, key);
    // reply_to сюда не идёт: у send_file в доке Chatpush параметра reply_to_message_id нет.
    logger.info(`operator sent file ${channel}: delivery=${delivery && delivery.id} bytes=${req.file.size}`);
    scheduleDeliveryCheck(delivery && delivery.id, { key, channel, kind: 'file', salonId, accountId: delivery && delivery.accountId });
    if (channel === 'whatsapp') {
      try {
        // file_url null: ссылку на медиа Chatpush отдаёт только в эхе (которого
        // для WhatsApp нет) — сохраняем подпись/имя, чтобы сообщение не пропадало.
        await persistWhatsappOutgoing(salonId, {
          delivery, phone: params.phone, chatId: rcp.chat_id || null,
          text: caption || ('📎 ' + req.file.originalname),
          msgType: isImage ? 'image' : 'document', fileUrl: null, mimeType: req.file.mimetype, authoredBy: 'operator',
        });
      } catch (e) { logger.error(`persist whatsapp outgoing file failed: ${safeErrorCode(e)}`); }
    }
    res.json({ ok: true, deliveryId: delivery.id, status: delivery.status_description });
  } catch (e) {
    logger.error('send-file failed');
    res.status(502).json({ error: 'Не удалось отправить файл' });
  }
});

module.exports = router;
// Для юнит-тестов (chat-route-send.test.js): адресация и проверка доставки без HTTP.
module.exports._internals = { resolveRecipient, scheduleDeliveryCheck, DELIVERY_STATUS_UNDELIVERABLE,
  privateAttachmentUrl, gatewayAttachmentPath, resolveGatewayAttachment };
