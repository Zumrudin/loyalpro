'use strict';
// ============================================================
// /api/messaging — аккаунты мессенджеров салона (owner/admin).
// Список, подключение Telegram через свой шлюз (телефон → код → пароль 2FA),
// статус, отключение, возврат канала на другой аккаунт. Chatpush-строки
// создаются сидом/руками в БД — у них авторизация на стороне Chatpush, здесь
// они только видны.
// ПЕРЕКЛЮЧЕНИЕ КАНАЛА — ОДНА ТРАНЗАКЦИЯ (db.withTransaction): на (salon_id, channel) активная строка
// одна (частичный уникальный индекс), порядок обязателен — сначала disable
// старой, потом insert/activate новой, и оба шага либо проходят вместе, либо
// откатываются: иначе сбой между ними оставил бы канал БЕЗ активной строки
// (Telegram салона молчит до вмешательства человека), а между INSERT и
// UPDATE external_id входящее событие шлюза не резолвилось бы в салон.
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const { db, withTransaction } = require('../db');
const config = require('../config');
const { auth, requireRole } = require('../middleware/auth');
const accounts = require('../services/messaging/accounts');
const gw = require('../services/messaging/gateway-client');
const { createLogger } = require('../logger');
const logger = createLogger('MessagingAccounts');

const adminOnly = [auth, requireRole('owner', 'admin')];

// Шаг авторизации из тела запроса → {phone}|{code}|{password} | null.
function parseAuthStep(body) {
  const b = body || {};
  if (typeof b.phone === 'string' && b.phone.trim()) {
    let d = b.phone.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d.length >= 10 && d.length <= 15 ? { phone: d } : null;
  }
  if (typeof b.code === 'string') {
    const c = b.code.replace(/\D/g, '');
    return c.length >= 4 && c.length <= 6 ? { code: c } : null;
  }
  if (typeof b.password === 'string' && b.password.length) return { password: b.password };
  return null;
}

// Завести gateway-аккаунт Telegram у салона (идемпотентно: активная
// gateway-строка уже есть → просто start по ней). Прежний провайдер tdlib
// гасится В ТОЙ ЖЕ транзакции — подключение Telegram к шлюзу = переключение
// канала. Шлюз стартует ПОСЛЕ коммита — иначе он прочитал бы строку, которой
// ещё не видно; его сбой строку не откатывает (повтор кнопки идемпотентен).
async function createTelegramAccount(salonId) {
  const existing = await db.oneOrNone(
    `SELECT id FROM messenger_accounts WHERE salon_id = $1 AND channel = 'tdlib' AND provider = 'gateway' AND status = 'active'`,
    [salonId]);
  if (existing) {
    const st = await gw.start(existing.id);
    return { id: existing.id, authState: st.authState };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const id = await withTransaction(async (client) => {
    await client.query(
      `UPDATE messenger_accounts SET status = 'disabled', updated_at = NOW()
        WHERE salon_id = $1 AND channel = $2 AND status = 'active'`,
      [salonId, 'tdlib']);
    const ins = await client.query(
      `INSERT INTO messenger_accounts (salon_id, token, provider, channel, status, auth_state, display_name)
       VALUES ($1, $2, 'gateway', 'tdlib', 'active', 'starting', 'Telegram (свой шлюз)')
       RETURNING id`,
      [salonId, token]);
    const newId = ins.rows && ins.rows[0] && ins.rows[0].id;
    if (!newId) throw new Error('строка аккаунта не вставилась');
    await client.query(`UPDATE messenger_accounts SET external_id = $1 WHERE id = $2`, [String(newId), newId]);
    return newId;
  });
  accounts.invalidate();
  const st = await gw.start(id);
  return { id, authState: st.authState };
}

// Сделать строку активной для её канала (откат на Chatpush и обратно).
async function activateAccount(salonId, id, channel) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE messenger_accounts SET status = 'disabled', updated_at = NOW()
        WHERE salon_id = $1 AND channel = $2 AND status = 'active' AND id <> $3`,
      [salonId, channel, id]);
    await client.query(
      `UPDATE messenger_accounts SET status = 'active', updated_at = NOW() WHERE id = $1 AND salon_id = $2`,
      [id, salonId]);
  });
  accounts.invalidate();
}

async function ownRow(salonId, id) {
  return db.oneOrNone(
    `SELECT id, provider, channel, status, auth_state FROM messenger_accounts WHERE id = $1 AND salon_id = $2`,
    [id, salonId]);
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Неверный id' }); return null; }
  return id;
}

router.get('/accounts', adminOnly, async (req, res) => {
  try {
    res.json({ accounts: await accounts.listForSalon(req.user.salonId), gatewayConfigured: !!config.MESSAGING_GATEWAY.url });
  } catch (e) { logger.error(`list: ${e.message}`); res.status(500).json({ error: 'Не удалось загрузить аккаунты' }); }
});

router.post('/accounts/telegram', adminOnly, async (req, res) => {
  // Проверка ДО транзакции: иначе ненастроенный шлюз узнался бы только в
  // gw.start ПОСЛЕ коммита — tdlib-канал салона уже переключён на строку,
  // которую обслуживать некому.
  if (!config.MESSAGING_GATEWAY.url) return res.status(503).json({ error: 'шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)' });
  try { res.json(await createTelegramAccount(req.user.salonId)); }
  catch (e) { logger.error(`create telegram: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/auth', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  const step = parseAuthStep(req.body);
  if (!step) return res.status(400).json({ error: 'Нужен телефон, код или пароль' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row || row.provider !== 'gateway') return res.status(404).json({ error: 'Аккаунт не найден' });
    res.json(await gw.auth(id, step));
  } catch (e) { logger.error(`auth #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/accounts/:id/status', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (row.provider !== 'gateway') return res.json({ authState: null, provider: row.provider, status: row.status });
    res.json(await gw.status(id));
  } catch (e) { logger.error(`status #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/logout', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row || row.provider !== 'gateway') return res.status(404).json({ error: 'Аккаунт не найден' });
    await gw.logout(id);
    await db.query(`UPDATE messenger_accounts SET status = 'disabled', auth_state = 'logged_out', updated_at = NOW() WHERE id = $1 AND salon_id = $2`,
      [id, req.user.salonId]);
    accounts.invalidate();
    res.json({ ok: true });
  } catch (e) { logger.error(`logout #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/activate', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    await activateAccount(req.user.salonId, id, row.channel);
    res.json({ ok: true });
  } catch (e) { logger.error(`activate #${id}: ${e.message}`); res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.parseAuthStep = parseAuthStep;
module.exports.createTelegramAccount = createTelegramAccount;
module.exports.activateAccount = activateAccount;
