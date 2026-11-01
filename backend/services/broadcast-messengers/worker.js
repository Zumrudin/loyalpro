'use strict';
// ============================================================
// Воркер разовых рассылок через мессенджеры клиники (спека 2026-11-01 §5).
// ЗАЧЕМ отдельный тик, а не цикл «по всем получателям»: получатель ждёт СВОЙ мессенджер, у каждого
// мессенджера своя пауза и лимит (решение владельца), поэтому за тик уходит не больше одного сообщения
// в каждый свободный мессенджер (scheduler.js). Активна одна рассылка на салон — две параллельные
// обошли бы паузу друг друга.
//
// AT-MOST-ONCE (как notifications/worker.js): строка захватывается в `sending` ДО отправки; после
// реальной отправки ничего не возвращает её в `pending` — каждый пост-отправочный UPDATE в своём
// try/catch. Упал процесс между захватом и ответом → closeStaleSending закрывает такие строки как
// `failed: ambiguous_failure`, не переотправляет (дубль хуже пропуска).
//
// Сверка доставки — ТОЛЬКО для монитора: каскад по «не доставлено» не продолжается (повтор в другой
// мессенджер через минуты в разовой рассылке выглядел бы спамом, а у шлюза статус 5 бывает и
// «исход неизвестен» — трактовка та же, что у автоуведомлений).
//
// Каждый SQL помечен тегом /* bm:… */ — по нему тест маршрутизирует фейковую БД.
// ============================================================
const { db } = require('../../db');
const transport = require('../messaging/transport');
const sender = require('./sender');
const scheduler = require('./scheduler');
const { createLogger } = require('../../logger');

const log = createLogger('BroadcastMessengers');

const TICK_MS = 5000;
const CHECK_DELAY_S = 120;        // сверка доставки не раньше, чем через 2 мин после отправки
const CHECK_BATCH = 20;
const CHECK_REPEAT_S = 30;        // «Принято» перечитываем не чаще раза в 30 с, а не каждый тик
const ACCEPTED_MAX_AGE_MS = 10 * 60 * 1000; // дольше «Принято» — исход неизвестен (шлюз закрывает зависшие через 10 мин)
const CHECK_MAX_AGE_MS = 8 * 60 * 1000;     // статус 5, увиденный позже, не доказан (как notifications/worker.js)
const UNDELIVERABLE_STATUS_ID = 5;
const DELIVERED_STATUS_IDS = new Set([2, 3, 4]);
const UNKNOWN_OUTCOME_RE = /исход неизвестен/i;
const STALE_CHECK_EVERY_MS = 60 * 1000;
const ERR_MAX = 500;

const ACTIVE_SQL = `/* bm:active */
  SELECT DISTINCT ON (salon_id) *
    FROM broadcasts
   WHERE transport = 'messengers' AND status IN ('pending','in_progress')
   ORDER BY salon_id, (status = 'in_progress') DESC, created_at ASC, id ASC`;

const STATS_SQL = `/* bm:stats */
  SELECT channel, extract(epoch FROM max(sent_at)) * 1000 AS last_ms, count(*)::int AS n
    FROM broadcast_recipients
   WHERE broadcast_id = $1 AND status IN ('sent','sending')
   GROUP BY channel`;

const HEADS_SQL = `/* bm:heads */
  SELECT DISTINCT ON (channel) id, phone, channel, cascade, step, personalized_text
    FROM broadcast_recipients
   WHERE broadcast_id = $1 AND status = 'pending' AND channel = ANY($2::text[])
   ORDER BY channel, sort_order, id`;

const LIMIT_PENDING_SQL = `/* bm:limit-pending */
  SELECT id, cascade, step, channel
    FROM broadcast_recipients
   WHERE broadcast_id = $1 AND status = 'pending' AND channel = ANY($2::text[])`;

const CHECK_SQL = `/* bm:deliveries */
  SELECT r.id, r.channel, r.delivery_id, r.account_id, r.sent_at, b.salon_id
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
   WHERE b.transport = 'messengers'
     AND r.status = 'sent' AND r.delivery_status = 'accepted' AND r.delivery_id IS NOT NULL
     AND r.sent_at < NOW() - interval '${CHECK_DELAY_S} seconds'
     AND (r.checked_at IS NULL OR r.checked_at < NOW() - interval '${CHECK_REPEAT_S} seconds')
   ORDER BY r.checked_at NULLS FIRST, r.sent_at
   LIMIT ${CHECK_BATCH}`;

// Один запрос: закрыть зависшие `sending` и одним UPDATE прибавить их к failed рассылок.
const CLOSE_STALE_SQL = `/* bm:close-stale */
  WITH upd AS (
    UPDATE broadcast_recipients r
       SET status = 'failed', reason = 'ambiguous_failure', error = 'процесс перезапущен во время отправки'
     WHERE r.status = 'sending' AND r.sent_at < NOW() - interval '2 minutes'
       AND r.broadcast_id IN (SELECT id FROM broadcasts WHERE transport = 'messengers')
     RETURNING r.broadcast_id
  ), agg AS (
    SELECT broadcast_id, count(*)::int AS n FROM upd GROUP BY broadcast_id
  )
  UPDATE broadcasts b SET failed = b.failed + agg.n
    FROM agg
   WHERE b.id = agg.broadcast_id
  RETURNING b.id, agg.n`;

const SQL = {
  cancelPending: `/* bm:cancel-pending */ UPDATE broadcast_recipients SET status='cancelled' WHERE broadcast_id=$1 AND status='pending'`,
  cancelBroadcast: `/* bm:cancel-broadcast */ UPDATE broadcasts SET status='cancelled', finished_at=NOW() WHERE id=$1 AND status IN ('pending','in_progress')`,
  start: `/* bm:start-broadcast */ UPDATE broadcasts SET status='in_progress', started_at=COALESCE(started_at, NOW()) WHERE id=$1 AND status='pending'`,
  advance: `/* bm:advance */ UPDATE broadcast_recipients SET step=$2, channel=$3, cascade_log = cascade_log || $4::jsonb
             WHERE id=$1 AND status='pending' RETURNING id`,
  skip: `/* bm:skip */ UPDATE broadcast_recipients SET status='skipped', reason=$2, cascade_log = cascade_log || $3::jsonb
          WHERE id=$1 AND status='pending' RETURNING id`,
  incSkipped: `/* bm:inc-skipped */ UPDATE broadcasts SET skipped = skipped + 1 WHERE id=$1`,
  incSent: `/* bm:inc-sent */ UPDATE broadcasts SET sent = sent + 1 WHERE id=$1`,
  incFailed: `/* bm:inc-failed */ UPDATE broadcasts SET failed = failed + 1 WHERE id=$1`,
  claim: `/* bm:claim */ UPDATE broadcast_recipients SET status='sending', sent_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
  markSent: `/* bm:mark-sent */ UPDATE broadcast_recipients
               SET status='sent', channel=$2, delivery_id=$3, account_id=$4, delivery_status='accepted',
                   error=NULL, cascade_log = cascade_log || $5::jsonb
             WHERE id=$1 AND status='sending' RETURNING id`,
  markRetry: `/* bm:mark-retry */ UPDATE broadcast_recipients
                SET status='pending', sent_at=NULL, step=$2, channel=$3, error=$4, cascade_log = cascade_log || $5::jsonb
              WHERE id=$1 AND status='sending' RETURNING id`,
  markFailed: `/* bm:mark-failed */ UPDATE broadcast_recipients
                 SET status='failed', reason=$2, error=$3, cascade_log = cascade_log || $4::jsonb
               WHERE id=$1 AND status='sending' RETURNING id`,
  markUnreachable: `/* bm:mark-unreachable */ UPDATE broadcast_recipients
                      SET status='pending', sent_at=NULL, error=$2, cascade_log = cascade_log || $3::jsonb
                    WHERE id=$1 AND status='sending' RETURNING id`,
  pause: `/* bm:pause-broadcast */ UPDATE broadcasts SET paused=TRUE, pause_reason=$2 WHERE id=$1`,
  hasOpen: `/* bm:has-open */ SELECT 1 AS one FROM broadcast_recipients WHERE broadcast_id=$1 AND status IN ('pending','sending') LIMIT 1`,
  complete: `/* bm:complete */ UPDATE broadcasts SET status='completed', finished_at=NOW() WHERE id=$1 AND status='in_progress'`,
  deliveryStatus: `/* bm:delivery-status */ UPDATE broadcast_recipients
                     SET delivery_status = COALESCE($2, delivery_status), checked_at = NOW()
                   WHERE id=$1 AND delivery_status='accepted'`,
};

const errText = (e) => String((e && e.message) || e || '').slice(0, ERR_MAX);
const logEntry = (nowMs, obj) => JSON.stringify([{ at: new Date(nowMs).toISOString(), ...obj }]);

function parseSettings(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch (_) { return {}; } }
  return {};
}

/** Строки STATS_SQL → {ch:{lastSentAt(ms), sentCount}}; last_ms у pg — numeric строкой. */
function statsFromRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const ms = r.last_ms == null ? null : Number(r.last_ms);
    out[r.channel] = { lastSentAt: Number.isFinite(ms) ? ms : null, sentCount: Number(r.n) || 0 };
  }
  return out;
}

/** Пост-отправочный UPDATE: ошибка — только лог (строка не должна вернуться в pending). */
async function safe(label, fn) {
  try { return await fn(); } catch (e) { log.error(`${label}: ${e.message}`); return null; }
}

async function applyLimits(b, states, nowMs) {
  const limitChs = scheduler.CHANNELS.filter((ch) => states[ch].state === 'limit');
  if (!limitChs.length) return;
  const blocked = new Set(scheduler.CHANNELS.filter((ch) => ['limit', 'disabled'].includes(states[ch].state)));
  const rows = await db.any(LIMIT_PENDING_SQL, [b.id, limitChs]);
  for (const r of rows) {
    const act = scheduler.limitAction({ cascade: r.cascade, step: Number(r.step) || 0 }, b.on_limit, blocked);
    if (act.action === 'advance') {
      await db.any(SQL.advance, [r.id, act.step, act.channel, logEntry(nowMs, { from: r.channel, to: act.channel, why: 'limit' })]);
    } else {
      const done = await db.any(SQL.skip, [r.id, act.reason, logEntry(nowMs, { channel: r.channel, skipped: act.reason })]);
      if (done.length) await db.query(SQL.incSkipped, [b.id]);
    }
  }
}

/** Отправка одному получателю. Возвращает false, если цикл отправок тика надо прервать. */
async function sendOne(b, head, blocked, nowMs) {
  const claimed = await db.any(SQL.claim, [head.id]);
  if (!claimed.length) return true;

  const r = await sender.sendToRecipient({
    salonId: b.salon_id, phone: head.phone, channel: head.channel,
    text: head.personalized_text, imageUrl: b.image_url || null,
  });
  const id = head.id;
  const step = Number(head.step) || 0;

  if (r && r.ok) {
    const applied = await safe(`#${id} mark sent`, () => db.any(SQL.markSent,
      [id, head.channel, r.delivery_id, r.account_id, logEntry(nowMs, { channel: head.channel, ok: true })]));
    if (applied && applied.length) await safe(`рассылка ${b.id} sent+1`, () => db.query(SQL.incSent, [b.id]));
    return true;
  }

  const kind = r && r.kind;
  const error = errText(r && r.error);
  if (kind === 'unreachable') {
    // Шлюз лежит: получатель на тот же шаг, рассылка на паузу — иначе каскад откатил бы всех в другие мессенджеры.
    await safe(`#${id} unreachable`, () => db.any(SQL.markUnreachable,
      [id, error, logEntry(nowMs, { channel: head.channel, ok: false, why: 'unreachable', error })]));
    await safe(`рассылка ${b.id} pause`, () => db.query(SQL.pause, [b.id, 'gateway_unreachable']));
    log.warn(`рассылка ${b.id}: ${head.channel} недоступен (${error}) — рассылка на паузе`);
    return false;
  }
  if (kind === 'rejected') {
    const n = scheduler.nextStep(head.cascade, step, blocked);
    if (n) {
      await safe(`#${id} next step`, () => db.any(SQL.markRetry,
        [id, n.step, n.channel, error, logEntry(nowMs, { from: head.channel, to: n.channel, why: 'rejected', error })]));
      return true;
    }
    const applied = await safe(`#${id} all rejected`, () => db.any(SQL.markFailed,
      [id, 'all_rejected', error, logEntry(nowMs, { channel: head.channel, ok: false, why: 'rejected', error })]));
    if (applied && applied.length) await safe(`рассылка ${b.id} failed+1`, () => db.query(SQL.incFailed, [b.id]));
    return true;
  }
  // ambiguous и всё непредвиденное: сообщение могло уйти — без отката на другой шаг.
  const applied = await safe(`#${id} ambiguous`, () => db.any(SQL.markFailed,
    [id, 'ambiguous_failure', error, logEntry(nowMs, { channel: head.channel, ok: false, why: 'ambiguous', error })]));
  if (applied && applied.length) await safe(`рассылка ${b.id} failed+1`, () => db.query(SQL.incFailed, [b.id]));
  return true;
}

async function processBroadcast(b, nowMs = Date.now()) {
  // 1. Отмена — в любое время суток и на паузе.
  if (b.cancel_requested) {
    await db.query(SQL.cancelPending, [b.id]);
    await db.query(SQL.cancelBroadcast, [b.id]);
    log.info(`рассылка ${b.id}: отменена`);
    return;
  }
  // 2. Старт.
  if (b.status === 'pending') await db.query(SQL.start, [b.id]);

  // 3–7. Отправки — только в окне и без паузы.
  if (!b.paused && scheduler.inSendWindow(nowMs)) {
    const stats = statsFromRows(await db.any(STATS_SQL, [b.id]));
    const states = scheduler.channelStates(parseSettings(b.channel_settings), stats, nowMs);
    await applyLimits(b, states, nowMs);

    const free = scheduler.CHANNELS.filter((ch) => states[ch].state === 'free');
    if (free.length) {
      const blocked = new Set(scheduler.CHANNELS.filter((ch) => ['limit', 'disabled'].includes(states[ch].state)));
      const headRows = await db.any(HEADS_SQL, [b.id, free]);
      const heads = {};
      for (const h of headRows) heads[h.channel] = h;
      const sends = scheduler.pickSends(states, heads);
      for (const s of sends) {
        const ok = await sendOne(b, heads[s.channel], blocked, nowMs);
        if (!ok) break;
      }
    }
  }

  // 8. Завершение (и вне окна: последний получатель мог закрыться сверкой зависших).
  const open = await db.any(SQL.hasOpen, [b.id]);
  if (!open.length) {
    await db.query(SQL.complete, [b.id]);
    log.info(`рассылка ${b.id}: завершена`);
  }
}

/** Закрыть получателей, зависших в sending дольше 2 мин. Возвращает число закрытых, не бросает. */
async function closeStaleSending() {
  try {
    const rows = await db.any(CLOSE_STALE_SQL);
    const n = rows.reduce((s, r) => s + (Number(r.n) || 0), 0);
    if (n) log.warn(`закрыто зависших отправок: ${n} (failed: ambiguous_failure, не переотправляются)`);
    return n;
  } catch (e) {
    log.error(`closeStaleSending: ${e.message}`);
    return 0;
  }
}

/**
 * Трактовка статуса доставки для монитора: 'delivered' | 'undeliverable' | 'unknown' | null (пока «Принято»).
 * Статус 5 — «не доставлено» только при доказанном исходе: без «исход неизвестен» и не позже CHECK_MAX_AGE_MS.
 */
function deliveryVerdict(st, ageMs) {
  if (!st || !st.status) return 'unknown';
  const sid = Number(st.status.status_id);
  if (sid === UNDELIVERABLE_STATUS_ID) {
    if (UNKNOWN_OUTCOME_RE.test(`${st.error || ''} ${st.status.description || ''}`)) return 'unknown';
    if (!(ageMs <= CHECK_MAX_AGE_MS)) return 'unknown';
    return 'undeliverable';
  }
  if (DELIVERED_STATUS_IDS.has(sid)) return 'delivered';
  return ageMs > ACCEPTED_MAX_AGE_MS ? 'unknown' : null;
}

async function checkDeliveries(nowMs = Date.now()) {
  const rows = await db.any(CHECK_SQL);
  for (const r of rows) {
    try {
      let verdict;
      try {
        const st = await transport.getDeliveryStatus(r.salon_id, r.channel, r.delivery_id, { accountId: r.account_id });
        const ageMs = r.sent_at ? nowMs - new Date(r.sent_at).getTime() : NaN;
        verdict = deliveryVerdict(st, ageMs);
      } catch (e) {
        log.warn(`#${r.id} сверка доставки: ${e.message}`);
        verdict = 'unknown';
      }
      await db.query(SQL.deliveryStatus, [r.id, verdict]);
    } catch (e) {
      log.error(`#${r.id} delivery status: ${e.message}`);
    }
  }
}

let _inFlight = false;
let _lastStaleCheck = 0;

async function tick(nowMs = Date.now()) {
  if (_inFlight) return;
  _inFlight = true;
  try {
    // Строка, захваченная перед падением процесса, иначе держала бы паузу/лимит и не давала завершиться.
    if (nowMs - _lastStaleCheck >= STALE_CHECK_EVERY_MS) {
      _lastStaleCheck = nowMs;
      await closeStaleSending();
    }
    const list = await db.any(ACTIVE_SQL);
    for (const b of list) {
      try { await processBroadcast(b, nowMs); } catch (e) { log.error(`рассылка ${b.id}: ${e.message}`); }
    }
    await checkDeliveries(nowMs).catch((e) => log.error(`delivery checks: ${e.message}`));
  } catch (e) {
    log.error(`tick: ${e.message}`);
  } finally {
    _inFlight = false;
  }
}

let _running = false;
function start() {
  if (_running) return;
  if (process.env.BROADCAST_MESSENGERS === 'false') {
    log.warn('BROADCAST_MESSENGERS=false — воркер рассылок через мессенджеры не запущен');
    return;
  }
  if (!transport.configured()) {
    log.warn('ни CHATPUSH_INSTANCE_TOKEN, ни MESSAGING_GATEWAY_URL не заданы — воркер рассылок через мессенджеры не запущен');
    return;
  }
  _running = true;
  _lastStaleCheck = Date.now();
  closeStaleSending().catch(() => {});
  setInterval(() => { tick().catch((e) => log.error(`tick: ${e.message}`)); }, TICK_MS);
  log.info(`Broadcast messengers worker started (tick=${TICK_MS}ms)`);
}

module.exports = {
  start, tick, processBroadcast, closeStaleSending, checkDeliveries, deliveryVerdict, statsFromRows,
  ACTIVE_SQL, STATS_SQL, HEADS_SQL, LIMIT_PENDING_SQL, CHECK_SQL, CLOSE_STALE_SQL, parseSettings,
};
