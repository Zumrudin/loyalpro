// ============================================================
// Telegram Broadcast Service
// ============================================================
//
// Шлёт сообщения подписчикам Telegram-бота. Подписчики живут в отдельной
// базе бота (n8n_db.clients_peri.tg_id IS NOT NULL). Сопоставление с
// клиентами LoyalPro идёт по yclients_id (надёжно) либо по phone (fallback).
//
// Очередь:
//   broadcasts             — задание (1 строка на рассылку)
//   broadcast_recipients   — получатели с персонализированным текстом
//
// Воркер запускается через startBroadcastWorker() в server.js — он каждые
// WORKER_TICK_MS опрашивает БД, берёт первую рассылку в статусе pending или
// in_progress, шлёт пачку сообщений и обновляет счётчики. Между сообщениями
// — задержка SEND_INTERVAL_MS, чтобы не упереться в лимит Telegram
// (~30 msg/sec для одного бота).
//
// На 429 — респектим retry_after из ответа Telegram. На остальные ошибки
// (403 = user blocked bot, 400 = bad chat_id и т.п.) — помечаем получателя
// failed и идём дальше.

const axios = require('axios');
const { db, botDb } = require('../db');
const { createLogger } = require('../logger');

const log = createLogger('Broadcast');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API   = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

const SEND_INTERVAL_MS = 60;   // ~16 msg/sec — комфортно ниже лимита Telegram (30/sec)
const WORKER_TICK_MS   = 2500; // как часто воркер опрашивает БД на новые задания
const BATCH_SIZE       = 50;   // сколько сообщений за один tick

// ── normalization helpers ──────────────────────────────────────

// «+7 (905) 597-07-87» → «79055970787»; ведущий 8 трактуется как 7.
function normPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('8')) return '7' + digits.slice(1);
  return digits;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── subscriber lookup ──────────────────────────────────────────
//
// Возвращает Map<key, {tg_id, name, phone, birthday, yclients_id}>
// где key — это yclients_id (если есть) или 'phone:<normPhone>'.
async function loadBotSubscribers() {
  const rows = await botDb.many(
    `SELECT tg_id, phone, name, birthday, yclients_id
       FROM clients_peri
      WHERE tg_id IS NOT NULL`
  );
  const byYc    = new Map();
  const byPhone = new Map();
  for (const r of rows) {
    if (r.yclients_id != null) byYc.set(Number(r.yclients_id), r);
    const np = normPhone(r.phone);
    if (np) byPhone.set(np, r);
  }
  return { byYc, byPhone, rows };
}

// ── target audience ────────────────────────────────────────────
//
// Возвращает массив получателей рассылки для салона salonId с применёнными
// фильтрами. Каждая строка содержит client_id + telegram_chat_id + поля
// для подстановки в шаблон сообщения.
//
// Фильтры (все опциональны, комбинируются И):
//   segments        ['champion', 'sleeping_growing', ...]   — segment_key из client_segments
//   bonusMin        число (>=)
//   bonusMax        число (<=)
//   lastVisitDays   { gte?: N, lte?: N }   — дней с последнего визита
//   birthMonth      1..12 — месяц ДР
//   gender          'male' | 'female'
async function resolveAudience(salonId, filters = {}) {
  const subs = await loadBotSubscribers();
  if (!subs.rows.length) return [];

  // Подтягиваем всех клиентов салона с потенциальной связкой по yclients_id
  // или phone. Запрос ограничен ровно теми клиентами, чьи ID или телефоны
  // встречаются среди подписчиков — это исключает «утечку» чужих клиентов.
  const ycIds  = Array.from(subs.byYc.keys());
  const phones = Array.from(subs.byPhone.keys());

  if (!ycIds.length && !phones.length) return [];

  const whereParts = [];
  const params = [salonId];
  if (ycIds.length) {
    params.push(ycIds);
    whereParts.push(`c.yclients_client_id = ANY($${params.length}::bigint[])`);
  }
  if (phones.length) {
    params.push(phones);
    whereParts.push(`regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') = ANY($${params.length}::text[])`);
  }

  const segKeys = Array.isArray(filters.segments) ? filters.segments.filter(Boolean) : [];

  const sql = `
    SELECT c.id                  AS client_id,
           c.name                AS name,
           c.phone               AS phone,
           c.yclients_client_id  AS yclients_client_id,
           c.bonus_balance       AS bonus_balance,
           c.birthday            AS birthday,
           c.gender              AS gender,
           c.is_blacklisted      AS is_blacklisted,
           c.last_visit_at       AS last_visit_at,
           EXTRACT(EPOCH FROM (NOW() - c.last_visit_at))/86400 AS days_since_visit,
           cs.segment_key        AS segment_key,
           COALESCE(NULLIF(s.template_logo_line1,''), s.name) AS salon_name
      FROM clients c
      LEFT JOIN client_segments cs
        ON cs.client_id = c.id AND cs.salon_id = c.salon_id
      LEFT JOIN salons s ON s.id = c.salon_id
     WHERE c.salon_id = $1
       AND (${whereParts.join(' OR ')})
       AND COALESCE(c.is_blacklisted, FALSE) = FALSE
  `;
  const { rows: clients } = await db.query(sql, params);

  const out = [];
  for (const c of clients) {
    // Связка с подписчиком: сначала по yclients_client_id, потом по нормализованному телефону.
    let sub = null;
    if (c.yclients_client_id != null) sub = subs.byYc.get(Number(c.yclients_client_id));
    if (!sub) {
      const np = normPhone(c.phone);
      if (np) sub = subs.byPhone.get(np);
    }
    if (!sub || !sub.tg_id) continue;

    // ── фильтры ─────────────────────────────────────────────
    if (segKeys.length && (!c.segment_key || !segKeys.includes(c.segment_key))) continue;

    if (filters.bonusMin != null && Number(c.bonus_balance || 0) < Number(filters.bonusMin)) continue;
    if (filters.bonusMax != null && Number(c.bonus_balance || 0) > Number(filters.bonusMax)) continue;

    if (filters.lastVisitDays && typeof filters.lastVisitDays === 'object') {
      const d = c.days_since_visit;
      const { gte, lte } = filters.lastVisitDays;
      if (gte != null && (d == null || d < Number(gte))) continue;
      if (lte != null && (d == null || d > Number(lte))) continue;
    }

    if (filters.birthMonth) {
      const m = c.birthday ? new Date(c.birthday).getUTCMonth() + 1 : null;
      if (m !== Number(filters.birthMonth)) continue;
    }

    if (filters.gender && c.gender && String(c.gender).toLowerCase() !== String(filters.gender).toLowerCase()) continue;

    out.push({
      client_id:        c.client_id,
      telegram_chat_id: String(sub.tg_id),  // bigint → string безопаснее для JS
      name:             c.name || sub.name || '',
      phone:            c.phone || sub.phone || '',
      bonus_balance:    Number(c.bonus_balance || 0),
      segment_key:      c.segment_key || null,
      last_visit_at:    c.last_visit_at,
      salon_name:       c.salon_name || '',
    });
  }
  // Дедуп по chat_id (на случай если один Telegram привязан к нескольким clients)
  const seen = new Set();
  return out.filter(r => {
    if (seen.has(r.telegram_chat_id)) return false;
    seen.add(r.telegram_chat_id);
    return true;
  });
}

// ── template rendering ─────────────────────────────────────────
//
// Подстановки: {name}, {first_name}, {bonuses}, {salon}, {phone}
function renderTemplate(text, ctx) {
  if (!text) return '';
  const firstName = (ctx.name || '').trim().split(/\s+/)[0] || '';
  return String(text)
    .replace(/\{name\}/g,       ctx.name || '')
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{bonuses\}/g,    String(Math.round(ctx.bonus_balance || 0)))
    .replace(/\{salon\}/g,      ctx.salon_name || '')
    .replace(/\{phone\}/g,      ctx.phone || '');
}

// ── public API ─────────────────────────────────────────────────

async function previewAudience(salonId, filters) {
  const audience = await resolveAudience(salonId, filters || {});
  return {
    total: audience.length,
    sample: audience.slice(0, 30).map(a => ({
      client_id:    a.client_id,
      name:         a.name,
      phone:        a.phone,
      bonus_balance: a.bonus_balance,
      segment_key:  a.segment_key,
    })),
  };
}

async function createBroadcast({ salonId, authorUserId, messageTemplate, filters }) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  if (!messageTemplate || !messageTemplate.trim()) throw new Error('Текст сообщения пуст');

  const audience = await resolveAudience(salonId, filters || {});
  if (!audience.length) throw new Error('Нет получателей — никто не подписан или фильтры пустые');

  // Нужен реальный client из пула для транзакции (db.query сам берёт-возвращает).
  const { pool } = require('../db');
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows: [b] } = await conn.query(
      `INSERT INTO broadcasts (salon_id, author_user_id, message_template, filters, total, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
       RETURNING *`,
      [salonId, authorUserId, messageTemplate, JSON.stringify(filters || {}), audience.length]
    );

    // bulk insert получателей — небольшими пачками
    const CHUNK = 500;
    for (let i = 0; i < audience.length; i += CHUNK) {
      const slice = audience.slice(i, i + CHUNK);
      const values = [];
      const ph = [];
      slice.forEach((a, idx) => {
        const base = idx * 5;
        ph.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
        values.push(
          b.id,
          a.client_id,
          a.telegram_chat_id,
          (a.name || '').slice(0, 250),
          renderTemplate(messageTemplate, a),
        );
      });
      await conn.query(
        `INSERT INTO broadcast_recipients
           (broadcast_id, client_id, telegram_chat_id, client_name, personalized_text)
         VALUES ${ph.join(',')}
         ON CONFLICT (broadcast_id, telegram_chat_id) DO NOTHING`,
        values
      );
    }
    await conn.query('COMMIT');
    log.info(`Created broadcast #${b.id} (salon=${salonId}, total=${audience.length})`);
    return b;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function listBroadcasts(salonId, { limit = 30, offset = 0 } = {}) {
  return await db.many(
    `SELECT b.*, u.name AS author_name
       FROM broadcasts b
       LEFT JOIN users u ON u.id = b.author_user_id
      WHERE b.salon_id = $1
      ORDER BY b.created_at DESC
      LIMIT $2 OFFSET $3`,
    [salonId, limit, offset]
  );
}

async function getBroadcast(salonId, id) {
  const b = await db.oneOrNone(
    `SELECT b.*, u.name AS author_name
       FROM broadcasts b
       LEFT JOIN users u ON u.id = b.author_user_id
      WHERE b.id = $1 AND b.salon_id = $2`,
    [id, salonId]
  );
  if (!b) return null;
  // Несколько последних ошибок — помогают понять, почему какой-то процент не доехал.
  const errorSamples = await db.many(
    `SELECT telegram_chat_id, client_name, error
       FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'failed'
      ORDER BY id DESC
      LIMIT 5`,
    [id]
  );
  return { ...b, errorSamples };
}

async function cancelBroadcast(salonId, id) {
  const r = await db.query(
    `UPDATE broadcasts
        SET cancel_requested = TRUE
      WHERE id = $1 AND salon_id = $2
        AND status IN ('pending','in_progress')`,
    [id, salonId]
  );
  return r.rowCount > 0;
}

// ── worker ─────────────────────────────────────────────────────

async function sendOne(chatId, text) {
  // Telegram принимает chat_id числом или строкой; шлём числом если влезает в Number.
  const id = /^-?\d+$/.test(String(chatId)) ? Number(chatId) : chatId;
  const { data } = await axios.post(
    `${API}/sendMessage`,
    { chat_id: id, text, disable_web_page_preview: true, parse_mode: 'HTML' },
    { timeout: 15000, validateStatus: () => true }
  );
  if (data && data.ok) return { ok: true };
  // 429 → respect retry_after
  if (data && data.error_code === 429) {
    const retry = (data.parameters && data.parameters.retry_after) || 1;
    return { ok: false, retryAfter: retry, error: `429 retry_after=${retry}` };
  }
  return { ok: false, error: (data && data.description) || 'unknown' };
}

async function processOneTick() {
  if (!API) return;
  // Атомарно «арендуем» одну рассылку: pending → in_progress (с проставлением started_at).
  // Если уже есть in_progress — берём её. Cancel_requested = bail.
  let broadcast = await db.oneOrNone(`
    UPDATE broadcasts
       SET status     = 'in_progress',
           started_at = COALESCE(started_at, NOW())
     WHERE id = (
       SELECT id FROM broadcasts
        WHERE status IN ('pending','in_progress')
          AND cancel_requested = FALSE
        ORDER BY status DESC, created_at ASC  -- in_progress сначала (продолжаем), потом pending
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  if (!broadcast) return;

  // Проверка на отмену перед каждой пачкой
  const fresh = await db.oneOrNone('SELECT cancel_requested FROM broadcasts WHERE id=$1', [broadcast.id]);
  if (fresh && fresh.cancel_requested) {
    await db.query(
      `UPDATE broadcasts SET status='cancelled', finished_at=NOW() WHERE id=$1`,
      [broadcast.id]
    );
    log.info(`Broadcast #${broadcast.id} cancelled`);
    return;
  }

  const pending = await db.many(
    `SELECT id, telegram_chat_id, personalized_text
       FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'pending'
      ORDER BY id ASC
      LIMIT $2`,
    [broadcast.id, BATCH_SIZE]
  );

  if (!pending.length) {
    // Очередь пуста → финализируем
    await db.query(
      `UPDATE broadcasts SET status='completed', finished_at=NOW() WHERE id=$1`,
      [broadcast.id]
    );
    log.info(`Broadcast #${broadcast.id} completed (sent=${broadcast.sent}, failed=${broadcast.failed})`);
    return;
  }

  for (const r of pending) {
    try {
      const res = await sendOne(r.telegram_chat_id, r.personalized_text);
      if (res.ok) {
        await db.query(
          `UPDATE broadcast_recipients SET status='sent', sent_at=NOW(), error=NULL WHERE id=$1`,
          [r.id]
        );
        await db.query(`UPDATE broadcasts SET sent = sent + 1 WHERE id=$1`, [broadcast.id]);
      } else if (res.retryAfter) {
        log.warn(`Broadcast #${broadcast.id} rate-limited, sleeping ${res.retryAfter}s`);
        await sleep(res.retryAfter * 1000);
        // не помечаем failed — попробуем в следующем tick
      } else {
        await db.query(
          `UPDATE broadcast_recipients SET status='failed', error=$2 WHERE id=$1`,
          [r.id, String(res.error || '').slice(0, 500)]
        );
        await db.query(`UPDATE broadcasts SET failed = failed + 1 WHERE id=$1`, [broadcast.id]);
      }
    } catch (e) {
      await db.query(
        `UPDATE broadcast_recipients SET status='failed', error=$2 WHERE id=$1`,
        [r.id, String(e.message || e).slice(0, 500)]
      ).catch(() => {});
      await db.query(`UPDATE broadcasts SET failed = failed + 1 WHERE id=$1`, [broadcast.id]).catch(() => {});
    }
    await sleep(SEND_INTERVAL_MS);
  }
}

let _workerRunning = false;
function startBroadcastWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  if (!API) {
    log.warn('TELEGRAM_BOT_TOKEN is not set — broadcast worker disabled');
    return;
  }
  // На старте: если что-то «застряло» в in_progress после рестарта — оно
  // продолжится автоматически, потому что processOneTick подбирает in_progress.
  setInterval(() => {
    processOneTick().catch(e => log.error(`worker tick: ${e.message}`));
  }, WORKER_TICK_MS);
  log.info(`Broadcast worker started (tick=${WORKER_TICK_MS}ms, send_gap=${SEND_INTERVAL_MS}ms)`);
}

module.exports = {
  // public
  previewAudience,
  createBroadcast,
  listBroadcasts,
  getBroadcast,
  cancelBroadcast,
  startBroadcastWorker,
  // exposed for tests
  _resolveAudience: resolveAudience,
  _renderTemplate:  renderTemplate,
  _normPhone:       normPhone,
};
