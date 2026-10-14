'use strict';
// ============================================================
// Уведомления YClients — чистая часть: снимок записи из вебхука, классификация
// события относительно прошлого состояния, моменты отправки. Без БД и сети.
// Всё время — unix-миллисекунды; Москва фиксируется смещением +03:00 (перевода
// часов нет), как в services/care/schedule.js.
// ============================================================
const { normalizePhoneKey } = require('../agent-gate');

const MSK_OFFSET_MS = 3 * 3600 * 1000;

const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/;
const CANON_PHONE_RE = /^7\d{10}$/;

/** Стенные часы '2026-10-20 13:30[:00]' / '2026-10-20T13:30' → ms, читая их КАК МОСКОВСКИЕ. */
function mskWallClockToMs(s) {
  const m = WALL_CLOCK_RE.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(t) ? null : t;
}

/**
 * '2026-10-20T13:30:00+03:00' | '2026-10-20 13:30:00' → ms | null.
 * Date.parse доверяем ТОЛЬКО строке со смещением (+03:00, +0300, Z): без смещения он читает
 * ЛОКАЛЬНОЕ время процесса, а дев-сервер живёт в UTC — визит съехал бы на 3 часа. Такой datetime
 * и поле date (в YClients оно салон-локальное) разбираются как московские стенные часы.
 */
function parseVisitAt(datetime, date) {
  const iso = String(datetime || '').trim();
  if (iso) {
    if (HAS_OFFSET_RE.test(iso)) { const t = Date.parse(iso); if (!Number.isNaN(t)) return t; }
    else { const t = mskWallClockToMs(iso); if (t != null) return t; }
  }
  return mskWallClockToMs(String(date || '').trim());
}

/** Телефон клиента — только канон 7XXXXXXXXXX. Мусор ('+7' → '7', 3 цифры, чужие коды) → null. */
function canonPhone(raw) {
  const p = normalizePhoneKey(raw);
  return CANON_PHONE_RE.test(p) ? p : null;
}

function recordSnapshot(payload) {
  const d = (payload && payload.data) || {};
  const status = String((payload && payload.status) || '');
  const services = (Array.isArray(d.services) ? d.services : [])
    .filter((s) => s && s.id != null).map((s) => ({ id: Number(s.id), title: s.title || '' }));
  return {
    recordId: Number(d.id),
    status,
    visitAt: parseVisitAt(d.datetime, d.date),
    seanceLength: Number(d.seance_length || d.length || 0) || 0,
    attendance: Number(d.attendance == null ? 0 : d.attendance) || 0,
    deleted: d.deleted === true || status === 'delete',
    smsBefore: Number(d.sms_before || 0) || 0,
    staffId: d.staff && d.staff.id != null ? Number(d.staff.id) : (d.staff_id != null ? Number(d.staff_id) : null),
    staffName: (d.staff && d.staff.name) || '',
    services,
    clientYcId: d.client && d.client.id != null ? Number(d.client.id) : null,
    phone: canonPhone(d.client && d.client.phone),
    clientName: (d.client && d.client.name) || '',
    createdUserId: d.created_user_id != null ? Number(d.created_user_id) : null,
    shortLink: d.short_link || '',
  };
}

/**
 * prev — прошлое состояние (строка notification_record_state, приведённая к
 * полям снимка: visitAt, attendance, deleted) или null.
 *
 * rescheduled НЕ требует, чтобы запись была живой в прошлом: запись «клиент не придёт»
 * (attendance -1) администратор переносит и ОДНИМ действием снимает отметку, то есть prev
 * {-1, визит A} → snap {0, визит B} — это перенос (в реальных вебхуках 12 случаев из 344).
 * Перенос записи, которая остаётся отменённой, переносом не считается (isCancelledNow).
 * restored — запись вернули из отмены (снята отметка «не придёт» или запись снова живая):
 * напоминания, погашенные отменой, надо поставить заново. Оба вида могут выпасть вместе.
 *
 * created НЕ требует отсутствия prev: update может прийти раньше create (в реальных вебхуках
 * 3 записи из 1 363, на 14–411 мс позже), и к приходу create состояние уже сохранено — с условием
 * «нет prev» письмо «Вы записаны» терялось бы. Дубль create тоже даст created; повтор режет
 * уникальный ключ job-а (правило, запись, момент визита), а не классификатор.
 * create никогда не бывает переносом: время в нём отличается от уже известного только когда
 * сообщения пришли не по порядку, и «перенесена на <старое время>» вдобавок к «Вы записаны» — ложь.
 */
function classifyRecordEvent(prev, snap) {
  const wasCancelled = !!(prev && (prev.deleted || Number(prev.attendance) === -1));
  const isCancelledNow = snap.deleted || snap.attendance === -1;
  const cancelled = isCancelledNow && !wasCancelled;
  const created = snap.status === 'create' && !isCancelledNow;
  const rescheduled = !!prev && snap.status !== 'create' && !isCancelledNow
    && prev.visitAt != null && snap.visitAt != null && prev.visitAt !== snap.visitAt;
  const restored = !!prev && wasCancelled && !isCancelledNow;
  const arrived = !snap.deleted && snap.attendance === 1 && !(prev && Number(prev.attendance) === 1);
  const confirmed = !snap.deleted && snap.attendance === 2 && !(prev && Number(prev.attendance) === 2);
  return { created, rescheduled, restored, cancelled, noShow: cancelled && !snap.deleted && snap.attendance === -1, arrived, confirmed };
}

function parseHm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Момент внутри тихих часов → ближайшее quiet_to (мск); иначе как есть. */
function applyQuietHours(ms, settings) {
  const from = parseHm(settings && settings.quiet_from);
  const to = parseHm(settings && settings.quiet_to);
  if (from == null || to == null || from === to) return ms;
  const local = ms + MSK_OFFSET_MS;
  const minuteOfDay = Math.floor((local % 86400000) / 60000);
  const inWindow = from < to ? (minuteOfDay >= from && minuteOfDay < to)
    : (minuteOfDay >= from || minuteOfDay < to);
  if (!inWindow) return ms;
  const dayStart = local - (local % 86400000);
  let target = dayStart + to * 60000;
  if (target <= local) target += 86400000;
  return target - MSK_OFFSET_MS;
}

/**
 * Напоминание: visitAt − hours_before правила (не задано, не число или ≤ 0 → 24 ч). Прошло → null.
 * sms_before записи НЕ участвует: в вебхуках это дефолт компании (24 или 0), а не выбор клиента, и
 * Chatpush шлёт ровно за 24 ч даже при sms_before=0. Поле остаётся в снимке — только для журнала.
 * Любое нечисло (NaN visitAt/now) → null: NaN в `new Date()` ломает INSERT и роняет остальные правила.
 */
function reminderAt(snap, rule, settings, nowMs) {
  if (snap.visitAt == null) return null;
  const h = Number(rule && rule.hours_before);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  let at = snap.visitAt - hours * 3600 * 1000;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || at <= nowMs) return null;
  at = applyQuietHours(at, settings);
  if (at >= snap.visitAt) return null;
  return at;
}

/**
 * Конец визита (или now, если «пришёл» поставлен позже) + delay минут.
 * Нечисловой или отрицательный delay → 0: NaN в моменте отправки недопустим, а «до конца визита»
 * опрос слать нельзя.
 */
function afterVisitAt(snap, delayMinutes, nowMs) {
  const delay = Number(delayMinutes);
  const delayMs = Number.isFinite(delay) && delay > 0 ? delay * 60 * 1000 : 0;
  const end = snap.visitAt != null ? snap.visitAt + (Number(snap.seanceLength) || 0) * 1000 : nowMs;
  return Math.max(end, nowMs) + delayMs;
}

module.exports = { parseVisitAt, recordSnapshot, classifyRecordEvent, applyQuietHours, reminderAt, afterVisitAt, MSK_OFFSET_MS };
