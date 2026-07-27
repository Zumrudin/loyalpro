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
const { auth, requireRole } = require('../middleware/auth');
const { messagePreview, isGroupKey, DIALOG_KEY_SQL } = require('../services/chat');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');

const adminOnly = [auth, requireRole('owner', 'admin')];

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

module.exports = router;
