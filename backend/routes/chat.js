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
const { messagePreview } = require('../services/chat');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');

const adminOnly = [auth, requireRole('owner', 'admin')];

// GET /api/chat/dialogs — список диалогов салона (последнее сообщение + счётчик).
// NB: chatpush-webhook пока не заполняет client_id, поэтому LEFT JOIN clients
// сейчас всегда даёт NULL, а фронт откатывается на senderName/key. Джойн готов
// к матчингу клиента по номеру — включится, когда вебхук начнёт писать client_id.
router.get('/dialogs', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const { rows } = await db.query(`
      SELECT d.dialog_key, d.channel, d.sender_name, d.phone,
             d.direction  AS last_direction,
             d.msg_type   AS last_msg_type,
             d.text       AS last_text,
             d.msg_ts     AS last_ts,
             d.client_id, cl.name AS client_name,
             c.cnt        AS messages_count
      FROM (
        SELECT DISTINCT ON (COALESCE(NULLIF(phone,''), chat_id))
               COALESCE(NULLIF(phone,''), chat_id) AS dialog_key,
               NULLIF(phone,'') AS phone,
               channel, sender_name, direction, msg_type, text, msg_ts, client_id
        FROM chatpush_messages
        WHERE salon_id = $1
        ORDER BY COALESCE(NULLIF(phone,''), chat_id), msg_ts DESC
      ) d
      JOIN (
        SELECT COALESCE(NULLIF(phone,''), chat_id) AS dialog_key, COUNT(*) AS cnt
        FROM chatpush_messages
        WHERE salon_id = $1
        GROUP BY COALESCE(NULLIF(phone,''), chat_id)
      ) c ON c.dialog_key = d.dialog_key
      LEFT JOIN clients cl ON cl.id = d.client_id AND cl.salon_id = $1
      ORDER BY d.msg_ts DESC
    `, [salonId]);

    const dialogs = rows.map(r => ({
      key:           r.dialog_key,
      channel:       r.channel,
      senderName:    r.sender_name,
      phone:         r.phone || null,
      lastDirection: r.last_direction,
      lastText:      messagePreview({ msg_type: r.last_msg_type, text: r.last_text }),
      lastTs:        r.last_ts,
      messagesCount: Number(r.messages_count) || 0,
      client:        r.client_id ? { id: r.client_id, name: r.client_name } : null,
    }));
    res.json({ dialogs });
  } catch (e) {
    logger.error(`dialogs failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить диалоги' });
  }
});

// GET /api/chat/dialogs/:key/messages — история одного диалога (по возрастанию).
router.get('/dialogs/:key/messages', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    const { rows } = await db.query(`
      SELECT id, direction, channel, msg_type, text, file_url, mime_type,
             sender_name, msg_ts
      FROM chatpush_messages
      WHERE salon_id = $1 AND COALESCE(NULLIF(phone,''), chat_id) = $2
      ORDER BY msg_ts ASC
    `, [salonId, key]);
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
