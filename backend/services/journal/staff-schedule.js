'use strict';
// Local-first employee schedule changes. Saving uses only the journal's local
// view. Dispatch re-reads YClients, refuses stale/conflicting changes and uses
// journal_operations for the same uncertain-result protection as record writes.
const crypto = require('crypto');
const { db, pool } = require('../../db');
const m = require('./model');
const yc = require('./yclients');
const sources = require('./sources');
const recordOverlay = require('./overlay');
const scheduleOverlay = require('./schedule-overlay');
const { mergeRanges, subtractRanges } = require('../agent/equipment');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['break', 'add', 'remove']);
const MAX_BREAKS = 20;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const mins = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const hhmm = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const shiftDate = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

function time(value, label) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) m.fail(`Укажите ${label} в формате ЧЧ:ММ.`);
  return value;
}
function addBreaks(value, shiftStart, shiftEnd) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BREAKS) m.fail(`Укажите не больше ${MAX_BREAKS} перерывов.`);
  const breaks = value.map((item, index) => {
    if (!isObject(item)) m.fail(`Некорректный перерыв №${index + 1}.`);
    const start = time(item.start, `начало перерыва №${index + 1}`);
    const end = time(item.end, `окончание перерыва №${index + 1}`);
    if (mins(start) >= mins(end)) m.fail(`Окончание перерыва №${index + 1} должно быть позже начала.`);
    if (mins(start) <= mins(shiftStart) || mins(end) >= mins(shiftEnd)) {
      m.fail(`Перерыв №${index + 1} должен быть строго внутри рабочего времени.`);
    }
    return { start, end };
  }).sort((a, b) => mins(a.start) - mins(b.start) || mins(a.end) - mins(b.end));
  for (let i = 1; i < breaks.length; i++) {
    if (mins(breaks[i].start) < mins(breaks[i - 1].end)) m.fail('Перерывы не должны пересекаться.');
  }
  return breaks;
}
function parse(body) {
  if (!isObject(body) || !UUID.test(body.sessionId || '')) m.fail('Некорректный ключ формы.');
  if (!ACTIONS.has(body.action)) m.fail('Неизвестное изменение графика.');
  const out = { sessionId: body.sessionId, action: body.action, staffId: m.positiveId(body.staffId), date: m.dateKey(body.date) };
  if (body.action !== 'remove') {
    out.start = time(body.start, 'начало');
    out.end = time(body.end, 'окончание');
    if (mins(out.start) >= mins(out.end)) m.fail('Окончание должно быть позже начала.');
  }
  if (body.action === 'add' && body.breaks !== undefined) out.breaks = addBreaks(body.breaks, out.start, out.end);
  else if (body.breaks !== undefined) m.fail('Перерывы можно задать только при добавлении рабочего дня.');
  return out;
}
function rangesOf(schedule, date) {
  const list = Array.isArray(schedule) ? schedule : [];
  const day = list.find(d => String(d.date).slice(0, 10) === date);
  // The current /company/staff/schedule schema has slots and no is_working.
  // The legacy/cache representation has is_working and goes through the same
  // validator as the rest of the journal.
  if (day && day.is_working === undefined) {
    if (!Array.isArray(day.slots)) m.fail('Не удалось проверить график.', 502);
    return mergeRanges(day.slots.map(s => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.from || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.to || '') || mins(s.from) >= mins(s.to)) {
        m.fail('Некорректный график.', 502);
      }
      return { start: mins(s.from), end: mins(s.to) };
    }));
  }
  return m.staffSchedule(list, date).workRanges;
}
function workingOf(schedule, date) {
  const list = Array.isArray(schedule) ? schedule : [];
  const day = list.find(d => String(d.date).slice(0, 10) === date);
  return day?.is_working === undefined ? rangesOf(list, date).length > 0 : m.staffSchedule(list, date).working;
}
function slotsOf(ranges) {
  return mergeRanges(ranges).map(r => ({ from: hhmm(r.start), to: hhmm(r.end) }));
}
function canonicalDay(staffId, date, schedule) {
  return { staffId: Number(staffId), date, slots: slotsOf(rangesOf(schedule, date)) };
}
function versionOf(day) {
  return m.fingerprint({ staffId: Number(day.staffId), date: day.date, slots: day.slots });
}
// A newly added split shift has no base ranges. Treat the span from its first
// to last work interval as the conflict base so appointments inside a proposed
// break are protected both when saving locally and immediately before PUT.
// A legacy add without breaks stays one interval and does not acquire this
// extra check.
function conflictBase(baseSlots, targetSlots) {
  if (baseSlots.length || targetSlots.length < 2) return baseSlots;
  return [{ from: targetSlots[0].from, to: targetSlots[targetSlots.length - 1].to }];
}
function applyAction(session, schedule) {
  const ranges = rangesOf(schedule, session.date);
  const working = workingOf(schedule, session.date);
  let target;
  if (session.action === 'remove') {
    if (!working) m.fail('Сотрудник уже не работает в этот день.', 409, 'schedule_stale');
    target = [];
  } else if (session.action === 'add') {
    if (working) m.fail('Рабочий день уже добавлен. Обновите журнал.', 409, 'schedule_stale');
    const shift = [{ start: mins(session.start), end: mins(session.end) }];
    const breaks = addBreaks(session.breaks, session.start, session.end).map(r => ({ start: mins(r.start), end: mins(r.end) }));
    target = subtractRanges(shift, breaks);
  } else {
    const start = mins(session.start), end = mins(session.end);
    // A break is strictly inside one work interval; it cannot erase a shift or
    // silently span an existing break. Adjacent work intervals are merged first.
    if (!ranges.some(r => start > r.start && end < r.end)) m.fail('Перерыв должен быть строго внутри одного рабочего интервала.', 409);
    target = subtractRanges(ranges, [{ start, end }]);
  }
  const base = { staffId: session.staffId, date: session.date, slots: slotsOf(ranges) };
  return { baseVersion: versionOf(base), slots: slotsOf(target) };
}
function busyMinutes(value) {
  const match = /^(\d\d):(\d\d)(?::(\d\d))?$/.exec(String(value || ''));
  if (!match) return null;
  const h = Number(match[1]), min = Number(match[2]), sec = Number(match[3] || 0);
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 60 + min + sec / 60;
}
function overlapsRemoved(start, end, removed, date) {
  const dayStart = Date.parse(date + 'T00:00:00+03:00');
  const from = (start - dayStart) / 60000, to = (end - dayStart) / 60000;
  return removed.some(r => from < r.end && to > r.start);
}
function assertNoConflicts(records, staffId, date, baseSlots, targetSlots, busyIntervals = []) {
  const base = baseSlots.map(s => ({ start: mins(s.from), end: mins(s.to) }));
  const target = targetSlots.map(s => ({ start: mins(s.from), end: mins(s.to) }));
  const removed = subtractRanges(base, target);
  if (!removed.length) return;
  const dayStart = Date.parse(date + 'T00:00:00+03:00'), dayEnd = dayStart + 86400000;
  for (const r of records || []) {
    if (!r || r.deleted || Number(r.staff_id || r.staff?.id) !== Number(staffId)) continue;
    const at = m.moscowParts(r.datetime || r.date);
    const length = Number(r.seance_length) / 60;
    if (!at || !(length > 0)) m.fail('Не удалось проверить записи сотрудника. График не изменён.', 502, 'schedule_conflict');
    const end = at.ms + (length + m.nonNegSeconds(r.technical_break_duration) / 60) * 60000;
    if (end <= dayStart || at.ms >= dayEnd) continue;
    if (overlapsRemoved(at.ms, end, removed, date)) m.fail('Новый график пересекается с записью или её техническим перерывом. Запись не изменена.', 409, 'schedule_conflict');
  }
  // The current schedule endpoint also exposes activities and other busy
  // intervals. They are checked in addition to full records and technical breaks.
  for (const interval of busyIntervals || []) {
    const from = busyMinutes(interval.from), to = busyMinutes(interval.to);
    if (from == null || to == null || to <= from) m.fail('Не удалось проверить занятость сотрудника. График не изменён.', 502, 'schedule_conflict');
    if (overlapsRemoved(dayStart + from * 60000, dayStart + to * 60000, removed, date)) {
      m.fail('Новый график пересекается с активной записью или событием сотрудника.', 409, 'schedule_conflict');
    }
  }
}
async function salonFor(salonId) {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id) m.fail('Журнал записи не подключён для салона.', 409);
  return salon;
}
const BY_SESSION = 'SELECT id, request_hash, status FROM journal_outbox WHERE salon_id=$1 AND session_id=$2';
function replay(row, session, hash) {
  if (row.request_hash !== hash) m.fail('Ключ формы уже использован.', 409, 'session_used');
  return { outboxId: Number(row.id), staffId: session.staffId, date: session.date, status: row.status, duplicate: true };
}
async function enqueueLocked(salonId, userId, session) {
  const hash = m.fingerprint(session);
  try {
    const prior = await db.oneOrNone(BY_SESSION, [salonId, session.sessionId]);
    if (prior) return replay(prior, session, hash);
    const salon = await salonFor(salonId);
    const src = await sources.forSalon(salon);
    const [staff, records, open] = await Promise.all([
      src.staff(), src.records(shiftDate(session.date, -1), shiftDate(session.date, 1)), sources.openOutbox(salonId),
    ]);
    if (!staff.some(s => Number(s.id) === session.staffId && !s.fired && !m.isAdministrator(s))) m.fail('Сотрудник недоступен.', 404);
    let schedule = await src.schedule(session.staffId, session.date);
    let localRecords = records;
    if (src.kind !== 'local') {
      schedule = scheduleOverlay.applyOne(schedule, open, session.staffId, session.date);
      localRecords = recordOverlay.applyOverlay(records, open);
    }
    if (open.some(row => row.schedule_key === scheduleOverlay.keyOf(session.staffId, session.date) && ['failed', 'running'].includes(row.status))) {
      m.fail('Сначала завершите или уберите предыдущее изменение графика.', 409, 'schedule_pending');
    }
    const change = applyAction(session, schedule);
    const baseSlots = canonicalDay(session.staffId, session.date, schedule).slots;
    assertNoConflicts(localRecords, session.staffId, session.date, conflictBase(baseSlots, change.slots), change.slots);
    const overlay = { kind: 'schedule', staffId: session.staffId, date: session.date, slots: change.slots, baseVersion: change.baseVersion };
    const steps = [{ kind: 'schedule', opId: crypto.randomUUID(), state: 'pending', params: {
      staffId: session.staffId, date: session.date, slots: change.slots, baseVersion: change.baseVersion,
    } }];
    const uid = Number(userId), owner = Number.isSafeInteger(uid) && uid > 0 ? uid : null;
    const row = await db.oneOrNone(`INSERT INTO journal_outbox(
      salon_id,session_id,user_id,request_hash,status,steps,overlay,schedule_key)
      VALUES($1,$2,$3,$4,'queued',$5,$6,$7) ON CONFLICT (salon_id,session_id) DO NOTHING RETURNING id,status`, [
      salonId, session.sessionId, owner, hash, JSON.stringify(steps), JSON.stringify(overlay), scheduleOverlay.keyOf(session.staffId, session.date),
    ]);
    if (!row) {
      const raced = await db.oneOrNone(BY_SESSION, [salonId, session.sessionId]);
      if (!raced) m.fail('Не удалось сохранить изменения. Повторите.', 409);
      return replay(raced, session, hash);
    }
    return { outboxId: Number(row.id), staffId: session.staffId, date: session.date, status: row.status };
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') m.fail('Журнал ещё не подготовлен: требуется миграция базы.', 503);
    throw e;
  }
}
function sameDay(actual, expected) {
  return JSON.stringify(canonicalDay(expected.staffId, expected.date, actual).slots) === JSON.stringify(expected.slots);
}
async function liveDay(salon, staffId, date) {
  return yc.getStaffSchedule(salon, staffId, date);
}
async function mutate(salonId, userId, draft) {
  const conn = await pool.connect();
  let locked = false, broken = false;
  const requestHash = m.fingerprint(draft);
  try {
    locked = !!(await conn.query('SELECT pg_try_advisory_lock(17291, $1) AS locked', [salonId])).rows[0]?.locked;
    if (!locked) m.fail('Сохраняется другое изменение. Повторите через несколько секунд.', 409, 'busy');
    const prior = (await conn.query('SELECT request_hash,state,result FROM journal_operations WHERE salon_id=$1 AND operation_id=$2', [salonId, draft.operationId])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) m.fail('Ключ операции уже использован для других данных.', 409);
      if (prior.state === 'reviewed') m.fail('Операция сверена вручную. Для нового действия откройте новую форму.', 409, 'reviewed');
      if (prior.state === 'rejected') m.fail('YClients отклонил операцию. Обновите данные и повторите.', 409, 'rejected');
      if (prior.state === 'done') return { ...prior.result, duplicate: true };
      m.fail('Результат операции ещё не подтверждён. Проверьте график в YClients перед новой попыткой.', 409, 'uncertain');
    }
    const uncertain = (await conn.query("SELECT operation_id FROM journal_operations WHERE salon_id=$1 AND state='pending' LIMIT 1", [salonId])).rows[0];
    if (uncertain) m.fail('Есть операция с неподтверждённым результатом. Требуется сверка с YClients.', 409, 'blocked_pending');
    const salon = await salonFor(salonId);
    const expected = { staffId: draft.staffId, date: draft.date, slots: draft.slots };
    let live = await liveDay(salon, draft.staffId, draft.date);
    const current = canonicalDay(draft.staffId, draft.date, live);
    if (versionOf(current) !== draft.baseVersion) m.fail('График изменился в YClients. Обновите журнал и сохраните изменение заново.', 409, 'schedule_stale');
    const staff = await yc.list(salon, `/staff/${salon.yclients_company_id}`);
    if (!staff.some(s => Number(s.id) === draft.staffId && !s.fired && !m.isAdministrator(s))) m.fail('Сотрудник недоступен.', 404);
    const records = await yc.records(salon, shiftDate(draft.date, -1), shiftDate(draft.date, 1));
    // Recheck the schedule after the records read as well. There is no external
    // compare-and-swap; this narrows the race but cannot eliminate it.
    live = await liveDay(salon, draft.staffId, draft.date);
    if (versionOf(canonicalDay(draft.staffId, draft.date, live)) !== draft.baseVersion) {
      m.fail('График изменился в YClients. Обновите журнал и сохраните изменение заново.', 409, 'schedule_stale');
    }
    const busy = (live || []).filter(d => String(d.date).slice(0, 10) === draft.date && Number(d.staff_id) === Number(draft.staffId))
      .flatMap(d => Array.isArray(d.busy_intervals) ? d.busy_intervals : []);
    const conflictSlots = conflictBase(current.slots, draft.slots);
    assertNoConflicts(records, draft.staffId, draft.date, conflictSlots, draft.slots, busy);
    const pending = await sources.openOutbox(salonId);
    // Check both views: a pending move/delete must not hide a live appointment.
    assertNoConflicts(recordOverlay.applyOverlay(records, pending), draft.staffId, draft.date, conflictSlots, draft.slots);
    await conn.query(`INSERT INTO journal_operations(salon_id,operation_id,user_id,action,record_id,request_hash,state)
      VALUES($1,$2,$3,'schedule',NULL,$4,'pending')`, [salonId, draft.operationId, userId, requestHash]);
    let result, writeConfirmed = false;
    try {
      await yc.setStaffSchedule(salon, expected);
      writeConfirmed = true;
      const confirmed = await liveDay(salon, draft.staffId, draft.date);
      if (!sameDay(confirmed, expected)) m.fail('Не удалось подтвердить результат. Проверьте график в YClients; повторная отправка заблокирована.', 409, 'uncertain');
      result = { schedule: expected };
      await conn.query("UPDATE journal_operations SET state='done',result=$3,updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2",
        [salonId, draft.operationId, JSON.stringify(result)]);
    } catch (error) {
      if (error instanceof m.JournalError && error.code === 'uncertain') throw error;
      if (!writeConfirmed && [400, 401, 403, 404, 422, 429].includes(error.response?.status || error.status)) {
        await conn.query("UPDATE journal_operations SET state='rejected',updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2", [salonId, draft.operationId]);
        m.fail('YClients отклонил изменение графика. Проверьте доступ и данные.', 409, 'rejected');
      }
      m.fail('Не удалось подтвердить результат. Проверьте график в YClients; повторная отправка заблокирована.', 409, 'uncertain');
    }
    return result;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') m.fail('Журнал ещё не подготовлен: требуется миграция базы.', 503);
    throw e;
  } finally {
    if (locked) {
      try { await conn.query('SELECT pg_advisory_unlock(17291, $1)', [salonId]); }
      catch (_) { broken = true; }
    }
    conn.release(broken);
  }
}
// Serialize local schedule edits with external journal mutations. Failed
// requests release the session lock too; a broken connection is discarded.
async function locked(salonId, fn) {
  const conn = await pool.connect();
  let acquired = false, broken = false;
  try {
    acquired = !!(await conn.query('SELECT pg_try_advisory_lock(17291, $1) AS locked', [salonId])).rows[0]?.locked;
    if (!acquired) m.fail('График сейчас изменяется. Повторите через несколько секунд.', 409, 'busy');
    return await fn();
  } finally {
    if (acquired) try { await conn.query('SELECT pg_advisory_unlock(17291, $1)', [salonId]); } catch (_) { broken = true; }
    conn.release(broken);
  }
}
const enqueue = (salonId, userId, session) => locked(salonId, () => enqueueLocked(salonId, userId, session));
async function changes(salonId) {
  const rows = await db.any(`SELECT id,status,released_at,error_text,error_code,overlay FROM journal_outbox
    WHERE salon_id=$1 AND schedule_key IS NOT NULL AND status IN ('queued','running','failed') ORDER BY id`, [salonId]);
  return rows.map(row => ({ outboxId: Number(row.id), staffId: Number(row.overlay.staffId), date: row.overlay.date,
    status: row.status, released: row.released_at != null, errorText: row.error_text || null, errorCode: row.error_code || null }));
}
async function recover(salonId, outboxId, action) {
  return locked(salonId, async () => {
    const row = await db.oneOrNone(`SELECT * FROM journal_outbox WHERE salon_id=$1 AND id=$2 AND schedule_key IS NOT NULL`, [salonId, outboxId]);
    if (!row) m.fail('Изменение графика не найдено.', 404);
    if (row.status !== 'failed') m.fail('Изменение уже обрабатывается. Обновите список.', 409);
    if (action === 'retry') return require('./sessions').retry(salonId, outboxId);
    if (row.error_code === 'uncertain' || row.steps.some(s => s.state === 'uncertain')) {
      const uncertainSteps = row.steps.filter(s => s.state === 'uncertain');
      if (!uncertainSteps.length) m.fail('Не удалось проверить результат операции. Требуется сверка.', 409, 'uncertain');
      for (const step of uncertainSteps) {
        const op = await db.oneOrNone('SELECT state FROM journal_operations WHERE salon_id=$1 AND operation_id=$2', [salonId, step.opId]);
        if (op?.state !== 'reviewed') m.fail('Сначала владелец должен сверить результат в YClients.', 409, 'uncertain');
      }
    }
    // A stale refusal must not leave the old cache as the basis of a new edit.
    const salon = await salonFor(salonId), o = row.overlay;
    const actual = canonicalDay(o.staffId, o.date, await liveDay(salon, o.staffId, o.date));
    await require('./reference-cache').storeSchedule(salonId, actual);
    return require('./sessions').dismiss(salonId, outboxId);
  });
}
module.exports = { changes, recover, parse, applyAction, canonicalDay, versionOf, assertNoConflicts, enqueue, mutate, rangesOf, slotsOf };
