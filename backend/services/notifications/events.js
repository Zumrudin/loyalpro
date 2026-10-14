'use strict';
// ============================================================
// Уведомления YClients — чистая часть: снимок записи из вебхука, классификация
// события относительно прошлого состояния, моменты отправки. Без БД и сети.
// Всё время — unix-миллисекунды; Москва фиксируется смещением +03:00 (перевода
// часов нет), как в services/care/schedule.js.
// ============================================================
const { normalizePhoneKey } = require('../agent-gate');

const MSK_OFFSET_MS = 3 * 3600 * 1000;

/** '2026-10-20T13:30:00+03:00' | '2026-10-20 13:30:00' → ms | null */
function parseVisitAt(datetime, date) {
  const iso = String(datetime || '').trim();
  if (iso) { const t = Date.parse(iso); if (!Number.isNaN(t)) return t; }
  const m = String(date || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(t) ? null : t;
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
    phone: normalizePhoneKey(d.client && d.client.phone) || null,
    clientName: (d.client && d.client.name) || '',
    createdUserId: d.created_user_id != null ? Number(d.created_user_id) : null,
    shortLink: d.short_link || '',
  };
}

/**
 * prev — прошлое состояние (строка notification_record_state, приведённая к
 * полям снимка: visitAt, attendance, deleted) или null.
 */
function classifyRecordEvent(prev, snap) {
  const wasCancelled = !!(prev && (prev.deleted || Number(prev.attendance) === -1));
  const isCancelledNow = snap.deleted || snap.attendance === -1;
  const cancelled = isCancelledNow && !wasCancelled;
  const created = !prev && snap.status === 'create' && !isCancelledNow;
  const rescheduled = !!prev && !isCancelledNow && !wasCancelled
    && prev.visitAt != null && snap.visitAt != null && prev.visitAt !== snap.visitAt;
  const arrived = !snap.deleted && snap.attendance === 1 && !(prev && Number(prev.attendance) === 1);
  const confirmed = !snap.deleted && snap.attendance === 2 && !(prev && Number(prev.attendance) === 2);
  return { created, rescheduled, cancelled, noShow: cancelled && !snap.deleted && snap.attendance === -1, arrived, confirmed };
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

/** Напоминание: visitAt − часы; sms_before записи главнее правила. Прошло → null. */
function reminderAt(snap, rule, settings, nowMs) {
  if (snap.visitAt == null) return null;
  const hours = snap.smsBefore > 0 ? snap.smsBefore : Number((rule && rule.hours_before) || 24);
  let at = snap.visitAt - hours * 3600 * 1000;
  if (at <= nowMs) return null;
  at = applyQuietHours(at, settings);
  if (at >= snap.visitAt) return null;
  return at;
}

/** Конец визита (или now, если «пришёл» поставлен позже) + delay минут. */
function afterVisitAt(snap, delayMinutes, nowMs) {
  const end = snap.visitAt != null ? snap.visitAt + snap.seanceLength * 1000 : nowMs;
  return Math.max(end, nowMs) + Number(delayMinutes || 0) * 60 * 1000;
}

module.exports = { parseVisitAt, recordSnapshot, classifyRecordEvent, applyQuietHours, reminderAt, afterVisitAt, MSK_OFFSET_MS };
