'use strict';
// ============================================================
// /api/messaging — аккаунты мессенджеров салона (owner/admin).
// Список, подключение Telegram через свой шлюз (телефон → код → пароль 2FA),
// статус, отключение, возврат канала на другой аккаунт. Chatpush-строки
// создаются сидом/руками в БД — у них авторизация на стороне Chatpush, здесь
// они только видны.
// ПЕРЕКЛЮЧЕНИЕ КАНАЛА — ОДНА ТРАНЗАКЦИЯ (activateAccount): на (salon_id, channel) активная строка
// одна (частичный уникальный индекс), порядок обязателен — сначала disable
// старой, потом activate новой, и оба шага либо проходят вместе, либо
// откатываются: иначе сбой между ними оставил бы канал БЕЗ активной строки.
// Новый аккаунт шлюза заводится 'pending' (шлюз его поднимает, отправки идут
// через прежний активный) и становится активным ТОЛЬКО на ready
// (promoteIfReady из /auth и /status); отключение активного шлюза возвращает
// канал прежнему аккаунту другого провайдера.
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

// Каналы, которые подключаются через свой шлюз. channel/displayName
// интерполируются в SQL ТОЛЬКО отсюда — пользовательский ввод туда не попадает.
const GATEWAY_CHANNELS = { tdlib: 'Telegram (свой шлюз)', whatsapp: 'WhatsApp (свой шлюз)' };

// Завести gateway-аккаунт канала (Telegram или WhatsApp) у салона. Строка
// заводится в статусе 'pending': шлюз её поднимает (active|pending), но канал НЕ
// переключается — Chatpush продолжает обслуживать канал, пока шлюз не дойдёт до
// ready (promoteIfReady). Иначе канал салона был бы мёртв от клика до принятого
// кода/QR, а при брошенном мастере — навсегда. Идемпотентно: gateway-строка
// active/pending уже есть → start по ней. Шлюз стартует ПОСЛЕ записи
// external_id; его сбой строку не удаляет (повтор кнопки идемпотентен).
async function createGatewayAccount(salonId, channel) {
  const displayName = GATEWAY_CHANNELS[channel];
  if (!displayName) throw Object.assign(new Error(`канал ${channel} через шлюз не подключается`), { status: 400 });
  // Выбор-и-вставка под advisory-локом (salon+channel): два одновременных клика
  // иначе оба увидели бы «строки нет» и завели две pending-строки. Лок транзакционный
  // (снимается на COMMIT); уникальный индекс не вводим — не проверено, что на проде
  // нет дублей.
  const created = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`gateway-account:${salonId}:${channel}`]);
    const found = await client.query(
      `SELECT id, status FROM messenger_accounts
        WHERE salon_id = $1 AND channel = $2 AND provider = 'gateway' AND status IN ('active','pending')
        ORDER BY (status = 'active') DESC, id DESC LIMIT 1`,
      [salonId, channel]);
    const existing = found.rows[0];
    if (existing) {
      // Повтор кнопки после сбоя: external_id мог остаться NULL — без него
      // входящие шлюза не резолвились бы в салон.
      await client.query(`UPDATE messenger_accounts SET external_id = COALESCE(external_id, $1) WHERE id = $2`, [String(existing.id), existing.id]);
      return { id: existing.id, status: existing.status, fresh: false };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const ins = await client.query(
      `INSERT INTO messenger_accounts (salon_id, token, provider, channel, status, auth_state, display_name)
       VALUES ($1, $2, 'gateway', '${channel}', 'pending', 'starting', '${displayName}')
       RETURNING id`,
      [salonId, token]);
    const id = ins.rows[0] && ins.rows[0].id;
    if (!id) throw new Error('строка аккаунта не вставилась');
    await client.query(`UPDATE messenger_accounts SET external_id = $1 WHERE id = $2`, [String(id), id]);
    return { id, status: 'pending', fresh: true };
  });
  if (created.fresh) accounts.invalidate();
  const st = await gw.start(created.id);
  return { id: created.id, authState: st.authState, status: created.status };
}
const createTelegramAccount = (salonId) => createGatewayAccount(salonId, 'tdlib');

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

// Шлюз дошёл до ready на pending-строке → переключить канал на неё (та же
// транзакция, что «Сделать активным»). Возвращает актуальный статус строки.
async function promoteIfReady(salonId, row, authState) {
  if (row.provider === 'gateway' && row.status === 'pending' && authState === 'ready') {
    await activateAccount(salonId, row.id, row.channel);
    logger.info(`канал ${row.channel} салона ${salonId} переключён на шлюз (аккаунт #${row.id})`);
    return 'active';
  }
  return row.status;
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
  // Проверка ДО вставки: иначе ненастроенный шлюз узнался бы только в
  // gw.start — после того как строку уже завели.
  if (!config.MESSAGING_GATEWAY.url) return res.status(503).json({ error: 'шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)' });
  try { res.json(await createTelegramAccount(req.user.salonId)); }
  catch (e) { logger.error(`create telegram: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/whatsapp', adminOnly, async (req, res) => {
  if (!config.MESSAGING_GATEWAY.url) return res.status(503).json({ error: 'шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)' });
  try { res.json(await createGatewayAccount(req.user.salonId, 'whatsapp')); }
  catch (e) { logger.error(`create whatsapp: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/auth', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  const step = parseAuthStep(req.body);
  if (!step) return res.status(400).json({ error: 'Нужен телефон, код или пароль' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row || row.provider !== 'gateway') return res.status(404).json({ error: 'Аккаунт не найден' });
    const r = await gw.auth(id, step);
    const status = await promoteIfReady(req.user.salonId, row, r && r.authState);
    res.json({ ...r, status });
  } catch (e) { logger.error(`auth #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/accounts/:id/status', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (row.provider !== 'gateway') return res.json({ authState: null, provider: row.provider, status: row.status });
    const r = await gw.status(id);
    const status = await promoteIfReady(req.user.salonId, row, r && r.authState);
    res.json({ ...r, status });
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
    // Канал остался без активной строки (отключили активный шлюз) → вернуть
    // прежний аккаунт другого провайдера (Chatpush), иначе Telegram салона молчит.
    let restored = null;
    const active = await db.oneOrNone(
      `SELECT id FROM messenger_accounts WHERE salon_id = $1 AND channel = $2 AND status = 'active' LIMIT 1`,
      [req.user.salonId, row.channel]);
    if (!active) {
      const prev = await db.oneOrNone(
        `SELECT id FROM messenger_accounts
          WHERE salon_id = $1 AND channel = $2 AND status = 'disabled' AND provider <> $3
          ORDER BY updated_at DESC LIMIT 1`,
        [req.user.salonId, row.channel, row.provider]);
      if (prev) {
        await activateAccount(req.user.salonId, prev.id, row.channel);
        restored = prev.id;
        logger.info(`шлюз #${id} отключён: канал ${row.channel} салона ${req.user.salonId} возвращён на аккаунт #${prev.id}`);
      } else {
        logger.warn(`шлюз #${id} отключён: у канала ${row.channel} салона ${req.user.salonId} нет аккаунта для возврата — канал без активной строки`);
      }
    }
    res.json({ ok: true, restored });
  } catch (e) { logger.error(`logout #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/activate', adminOnly, async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (row.provider === 'gateway') {
      // Не переключать канал на неавторизованную сессию — Telegram замолчал бы.
      await gw.start(id);   // идемпотентно: поднять сессию, если шлюз её не держит
      const st = await gw.status(id);
      if (!st || st.authState !== 'ready') return res.status(409).json({ error: 'аккаунт шлюза не авторизован' });
    }
    await activateAccount(req.user.salonId, id, row.channel);
    res.json({ ok: true });
  } catch (e) { logger.error(`activate #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.parseAuthStep = parseAuthStep;
module.exports.createTelegramAccount = createTelegramAccount;
module.exports.createGatewayAccount = createGatewayAccount;
module.exports.activateAccount = activateAccount;
module.exports.promoteIfReady = promoteIfReady;
