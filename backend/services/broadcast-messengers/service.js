'use strict';
// Сервис разовых рассылок через мессенджеры клиники (спека 2026-11-01 §6): валидация тела запроса,
// создание, прогноз, тест на свой номер, монитор, таблица получателей, пауза/продолжение, «новая по
// пропущенным». Роуты (routes/broadcasts.js) только разбирают HTTP; правила — здесь, чтобы их можно было
// проверить без Express. Ошибки пользователя — Error со status 400/404 (текст безопасен для клиента).
const { db, pool } = require('../../db');
const audience = require('./audience');
const { forecast } = require('./forecast');
const { renderText } = require('./render');
const sender = require('./sender');
const scheduler = require('./scheduler');
const worker = require('./worker');
const accounts = require('../messaging/accounts');
const { canonPhone } = require('../notifications/cascade');
const { createLogger } = require('../../logger');

const log = createLogger('BroadcastMessengers');

const CHANNELS = scheduler.CHANNELS;
const MAX_LIST = 5000;
const IMAGE_URL_RE = /^\/uploads\/broadcast_\d+_\d+\.(jpg|jpeg|png|webp)$/;
const CHUNK = 500;
const FORECAST_TTL_MS = 120000;
const FORECAST_CACHE_MAX = 20;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const sumSkipped = (s) => Object.values(s || {}).reduce((a, n) => a + (Number(n) || 0), 0);

/** Чистая валидация тела POST / (и /forecast, /test). Клиенту не верим: номера канонизируем повторно. */
function parseCreateBody(body) {
  const b = body || {};
  const fail = (error) => ({ ok: false, error });
  if (b.transport !== 'messengers') return fail('transport должен быть messengers');
  if (b.audienceSource !== 'filters' && b.audienceSource !== 'list') return fail('Источник получателей: по фильтрам или по списку');

  let filters = {};
  let list = [];
  if (b.audienceSource === 'list') {
    if (!Array.isArray(b.list) || !b.list.length) return fail('Список получателей пуст');
    if (b.list.length > MAX_LIST) return fail(`В списке больше ${MAX_LIST} получателей`);
    const seen = new Set();
    for (const it of b.list) {
      const phone = canonPhone(it && it.phone);
      if (!phone) return fail('В списке есть строка с некорректным номером');
      if (seen.has(phone)) continue;
      seen.add(phone);
      list.push({ name: it && it.name != null ? String(it.name).trim().slice(0, 120) : '', phone });
    }
  } else if (b.filters != null) {
    if (typeof b.filters !== 'object' || Array.isArray(b.filters)) return fail('Фильтры должны быть объектом');
    filters = b.filters;
  }

  if (typeof b.messageTemplate !== 'string' || !b.messageTemplate.trim()) return fail('Введите текст сообщения');
  if (b.messageTemplate.length > 4000) return fail('Сообщение слишком длинное (макс 4000 символов)');

  let imageUrl = null;
  if (b.imageUrl != null && b.imageUrl !== '') {
    if (typeof b.imageUrl !== 'string' || !IMAGE_URL_RE.test(b.imageUrl)) return fail('Некорректный адрес картинки');
    imageUrl = b.imageUrl;
  }

  const raw = b.channelSettings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Не заданы настройки мессенджеров');
  const channelSettings = {};
  for (const ch of CHANNELS) {
    const c = raw[ch];
    if (c == null) { channelSettings[ch] = { enabled: false, delay_sec: 60, limit: null }; continue; }
    if (typeof c !== 'object' || typeof c.enabled !== 'boolean') return fail(`${ch}: enabled должен быть true/false`);
    const delay = typeof c.delay_sec === 'string' && /^\d+$/.test(c.delay_sec) ? Number(c.delay_sec) : c.delay_sec;
    if (!Number.isInteger(delay) || delay < 0 || delay > 3600) return fail(`${ch}: пауза между сообщениями — целое 0–3600 секунд`);
    let limit = null;
    if (c.limit != null && c.limit !== '') {
      limit = typeof c.limit === 'string' && /^\d+$/.test(c.limit) ? Number(c.limit) : c.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) return fail(`${ch}: лимит — целое 1–10000 или пусто`);
    }
    channelSettings[ch] = { enabled: c.enabled, delay_sec: delay, limit };
  }
  if (!CHANNELS.some((ch) => channelSettings[ch].enabled)) return fail('Включите хотя бы один мессенджер');

  const onLimit = b.onLimit == null ? 'next_channel' : b.onLimit;
  if (onLimit !== 'next_channel' && onLimit !== 'skip') return fail('onLimit: next_channel или skip');
  if (b.cascadeEnabled != null && typeof b.cascadeEnabled !== 'boolean') return fail('cascadeEnabled должен быть true/false');
  const cascadeEnabled = b.cascadeEnabled == null ? true : b.cascadeEnabled;

  return { ok: true, value: {
    transport: 'messengers', audienceSource: b.audienceSource, filters, list,
    messageTemplate: b.messageTemplate, imageUrl, channelSettings, onLimit, cascadeEnabled,
  } };
}

function audOpts(v) {
  return { source: v.audienceSource, filters: v.filters, list: v.list, channelSettings: v.channelSettings, cascadeEnabled: v.cascadeEnabled };
}

// ── Кэш базы аудитории для прогноза ───────────────────────────────────────────────────────────
// База (люди + переписка) дорогая и от пауз/лимитов/галочек не зависит; форма зовёт прогноз на каждую
// правку, поэтому на правку настроек пересчитывается только каскад. createBroadcast кэш не использует.
const baseCache = new Map(); // key → {at, promise}

function cacheKey(salonId, v) {
  return `${salonId}|${v.audienceSource}|${v.audienceSource === 'list' ? JSON.stringify(v.list) : JSON.stringify(v.filters)}`;
}

function cachedBase(salonId, v) {
  const key = cacheKey(salonId, v);
  const hit = baseCache.get(key);
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.promise;
  baseCache.delete(key);
  const promise = audience.loadAudienceBase(salonId, { source: v.audienceSource, filters: v.filters, list: v.list });
  baseCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (baseCache.get(key) && baseCache.get(key).promise === promise) baseCache.delete(key); });
  while (baseCache.size > FORECAST_CACHE_MAX) baseCache.delete(baseCache.keys().next().value);
  return promise;
}

function clearForecastCache() { baseCache.clear(); }

async function forecastBroadcast(salonId, v) {
  const base = await cachedBase(salonId, v);
  const { recipients, skipped } = audience.applyCascade(base, { channelSettings: v.channelSettings, cascadeEnabled: v.cascadeEnabled });
  const f = forecast({ firstSteps: recipients, settings: v.channelSettings, onLimit: v.onLimit, nowMs: Date.now() });
  return { ...f, total: recipients.length, skipped: sumSkipped(skipped), skippedBy: skipped };
}

function assertOwnImage(salonId, imageUrl) {
  if (imageUrl && (!IMAGE_URL_RE.test(imageUrl) || !imageUrl.startsWith(`/uploads/broadcast_${salonId}_`))) {
    throw httpError(400, 'Некорректный адрес картинки');
  }
}

async function createBroadcast(salonId, userId, v) {
  assertOwnImage(salonId, v.imageUrl);
  const { recipients, skipped } = await audience.resolveAudience(salonId, audOpts(v));
  if (!recipients.length) throw httpError(400, 'Нет получателей');

  const enabled = CHANNELS.filter((ch) => v.channelSettings[ch].enabled);
  let hasAccount = false;
  for (const ch of enabled) {
    if (await accounts.credentialsFor(salonId, ch)) { hasAccount = true; break; }
  }
  if (!hasAccount) throw httpError(400, 'Для выбранных мессенджеров не подключён аккаунт клиники');

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows: [b] } = await conn.query(
      `INSERT INTO broadcasts (salon_id, author_user_id, message_template, filters, total, skipped, status,
                               transport, audience_source, image_url, cascade_enabled, channel_settings, on_limit)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,'pending','messengers',$7,$8,$9,$10::jsonb,$11)
       RETURNING *`,
      [salonId, userId, v.messageTemplate, JSON.stringify(v.audienceSource === 'filters' ? v.filters : {}),
       recipients.length, sumSkipped(skipped), v.audienceSource, v.imageUrl, v.cascadeEnabled,
       JSON.stringify(v.channelSettings), v.onLimit]);
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK);
      const vals = [];
      const ph = slice.map((r, k) => {
        const o = k * 9;
        vals.push(b.id, r.client_id, (r.name || '').slice(0, 250), r.phone, r.cascade, 0, r.cascade[0],
          renderText(v.messageTemplate, r), r.sort_order);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::text[],$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
      });
      await conn.query(
        `INSERT INTO broadcast_recipients
           (broadcast_id, client_id, client_name, phone, cascade, step, channel, personalized_text, sort_order)
         VALUES ${ph.join(',')}`, vals);
    }
    await conn.query('COMMIT');
    log.info(`рассылка ${b.id} (мессенджеры): salon=${salonId}, получателей ${recipients.length}, пропущено ${sumSkipped(skipped)}`);
    return b;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Тест: первый мессенджер каскада тестового номера, без пауз и лимитов, рассылку не создаёт. */
async function testSend(salonId, v, testPhone) {
  assertOwnImage(salonId, v.imageUrl);
  const phone = canonPhone(testPhone);
  if (!phone) throw httpError(400, 'Укажите корректный номер для теста');
  const { recipients } = await audience.resolveAudience(salonId, {
    source: 'list', list: [{ name: '', phone }], channelSettings: v.channelSettings, cascadeEnabled: v.cascadeEnabled,
  });
  if (!recipients.length) throw httpError(400, 'Для этого номера нет доступного мессенджера среди включённых');
  const rec = recipients[0];
  const channel = rec.cascade[0];
  const r = await sender.sendToRecipient({ salonId, phone, channel, text: renderText(v.messageTemplate, rec), imageUrl: v.imageUrl });
  return { channel, ok: !!r.ok, kind: r.ok ? null : r.kind, error: r.ok ? null : r.error };
}

// ── Монитор и таблица ─────────────────────────────────────────────────────────────────────────
async function loadOwn(salonId, id) {
  const b = await db.oneOrNone(`SELECT * FROM broadcasts WHERE id = $1 AND salon_id = $2 AND transport = 'messengers'`, [id, salonId]);
  if (!b) throw httpError(404, 'Рассылка не найдена');
  return b;
}

async function monitor(salonId, id, nowMs = Date.now()) {
  const b = await loadOwn(salonId, id);
  const settings = worker.parseSettings(b.channel_settings);
  const stats = worker.statsFromRows(await db.any(worker.STATS_SQL, [b.id]));
  const states = scheduler.channelStates(settings, stats, nowMs);
  const counts = await db.any(
    `SELECT channel, status, delivery_status, count(*)::int AS n FROM broadcast_recipients
      WHERE broadcast_id = $1 GROUP BY 1,2,3`, [b.id]);
  const adv = await db.any(
    `SELECT e->>'from' AS ch, count(*)::int AS n FROM broadcast_recipients r, jsonb_array_elements(r.cascade_log) e
      WHERE r.broadcast_id = $1 AND e ? 'to' GROUP BY 1`, [b.id]);
  const waiting = await db.any(
    `SELECT id, client_name AS name, phone, channel FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'pending' ORDER BY sort_order, id LIMIT 20`, [b.id]);

  const channels = {};
  for (const ch of CHANNELS) {
    const byStatus = {};
    const byDelivery = {};
    for (const r of counts) {
      if (r.channel !== ch) continue;
      byStatus[r.status] = (byStatus[r.status] || 0) + r.n;
      if (r.delivery_status) byDelivery[r.delivery_status] = (byDelivery[r.delivery_status] || 0) + r.n;
    }
    const a = adv.find((x) => x.ch === ch);
    const cfg = settings[ch] || {};
    channels[ch] = {
      enabled: !!cfg.enabled, delaySec: Number(cfg.delay_sec) || 0,
      state: states[ch].state, pausedUntil: states[ch].pausedUntil, sent: states[ch].sent, limit: states[ch].limit,
      byStatus, byDelivery, advancedFrom: a ? a.n : 0,
    };
  }
  const byStatus = {};
  for (const r of counts) byStatus[r.status] = (byStatus[r.status] || 0) + r.n;
  return {
    id: b.id, status: b.status, paused: !!b.paused, pauseReason: b.pause_reason || null,
    cancelRequested: !!b.cancel_requested, inWindow: scheduler.inSendWindow(nowMs),
    total: b.total, sent: b.sent, failed: b.failed, skipped: b.skipped,
    onLimit: b.on_limit, cascadeEnabled: b.cascade_enabled, imageUrl: b.image_url, messageTemplate: b.message_template,
    createdAt: b.created_at, startedAt: b.started_at, finishedAt: b.finished_at,
    byStatus, channels, waiting,
  };
}

async function recipients(salonId, id, { status, channel, q, offset, limit } = {}) {
  await loadOwn(salonId, id);
  const params = [id];
  const where = ['broadcast_id = $1'];
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (channel) { params.push(String(channel)); where.push(`channel = $${params.length}`); }
  const digits = String(q || '').replace(/\D+/g, '');
  if (digits) { params.push(`%${digits}%`); where.push(`phone LIKE $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const total = await db.oneOrNone(`SELECT count(*)::int AS n FROM broadcast_recipients WHERE ${where.join(' AND ')}`, params);
  const items = await db.any(
    `SELECT id, client_name AS name, phone, channel, status, reason, error, delivery_status, sent_at, cascade_log
       FROM broadcast_recipients WHERE ${where.join(' AND ')}
      ORDER BY sort_order, id LIMIT ${lim} OFFSET ${off}`, params);
  return { items, total: total ? total.n : 0, offset: off, limit: lim };
}

async function pause(salonId, id) {
  await loadOwn(salonId, id);
  await db.query(`UPDATE broadcasts SET paused = TRUE, pause_reason = 'manual' WHERE id = $1 AND salon_id = $2 AND status IN ('pending','in_progress')`, [id, salonId]);
  return { ok: true };
}

async function resume(salonId, id) {
  await loadOwn(salonId, id);
  await db.query(`UPDATE broadcasts SET paused = FALSE, pause_reason = NULL WHERE id = $1 AND salon_id = $2`, [id, salonId]);
  return { ok: true };
}

/** «Новая рассылка по пропущенным»: имя+телефон тех, кому не ушло. */
async function retryDraft(salonId, id) {
  await loadOwn(salonId, id);
  const rows = await db.any(
    `SELECT client_name AS name, phone FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status IN ('skipped','failed','cancelled') AND phone IS NOT NULL ORDER BY sort_order, id`, [id]);
  return rows.map((r) => ({ name: r.name || '', phone: r.phone }));
}

module.exports = {
  parseCreateBody, createBroadcast, forecastBroadcast, testSend, monitor, recipients, pause, resume, retryDraft,
  clearForecastCache, FORECAST_TTL_MS, FORECAST_CACHE_MAX, IMAGE_URL_RE,
};
