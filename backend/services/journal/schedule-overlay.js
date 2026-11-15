'use strict';
// Full-day schedule packages laid over the YClients schedule cache. Rows are
// already tenant-scoped by the caller; schedule_key prevents a malformed row
// from leaking into another employee/day.
const RECENT_DONE_MS = 5 * 60000;
const keyOf = (staffId, date) => `${Number(staffId)}:${date}`;
const ms = value => Date.parse(value instanceof Date ? value.toISOString() : String(value || '').replace(' ', 'T'));

function visible(row, now) {
  if (['queued', 'running', 'failed'].includes(row.status)) return true;
  if (row.status !== 'done') return false;
  const at = ms(row.updated_at);
  return Number.isFinite(at) && now - at < RECENT_DONE_MS;
}
function change(row) {
  const o = row.overlay || {};
  if (o.kind !== 'schedule') return null;
  const staffId = Number(o.staffId), date = String(o.date || '');
  if (!Number.isSafeInteger(staffId) || staffId < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(o.slots)) return null;
  if (row.schedule_key !== keyOf(staffId, date)) return null;
  return { staffId, date, slots: o.slots.map(s => ({ from: String(s.from), to: String(s.to) })) };
}
function applyMany(baseDays, rows, now = Date.now()) {
  const map = new Map();
  for (const day of baseDays || []) {
    const staffId = Number(day.staff_id || day.staffId), date = String(day.date || '').slice(0, 10);
    if (staffId > 0 && date) map.set(keyOf(staffId, date), { ...day, staff_id: staffId, date });
  }
  const ordered = [...(rows || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const changes = new Map();
  for (const row of ordered) {
    if (!visible(row, now)) continue;
    const o = change(row);
    if (!o) continue;
    const key = keyOf(o.staffId, o.date);
    if (!changes.has(key)) changes.set(key, []);
    changes.get(key).push({ row, o });
  }
  for (const [key, list] of changes) {
    const [staffId, date] = key.split(':');
    let day = map.get(key) || { staff_id: Number(staffId), date, is_working: false, slots: [] };
    for (const { row, o } of list) {
      day = { ...day, is_working: o.slots.length > 0, slots: o.slots, _sync: {
        outboxId: Number(row.id), status: row.status, released: row.released_at != null,
        errorText: row.error_text || null, errorCode: row.error_code || null,
      } };
    }
    map.set(key, day);
  }
  return [...map.values()];
}
function applyOne(schedule, rows, staffId, date, now = Date.now()) {
  const base = (schedule || []).filter(d => String(d.date).slice(0, 10) === date)
    .map(d => ({ ...d, staff_id: Number(staffId), date }));
  const hadBase = base.length > 0;
  const out = applyMany(base, rows, now).filter(d => Number(d.staff_id) === Number(staffId) && d.date === date);
  if (!out.length) return hadBase ? schedule : null;
  const day = out[0];
  return [{ date, is_working: day.is_working ? 1 : 0, slots: day.slots, ...(day._sync ? { _sync: day._sync } : {}) }];
}
module.exports = { applyMany, applyOne, keyOf, RECENT_DONE_MS };
