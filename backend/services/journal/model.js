'use strict';
const crypto = require('crypto');
const pricing = require('./pricing');
const config = require('../../config');
const { mergeRanges, subtractRanges } = require('../agent/equipment');

class JournalError extends Error {
  constructor(status, message, code = 'invalid') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status = 400, code) => { throw new JournalError(status, message, code); };
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Укажите дату.');
  const d = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) fail('Некорректная дата.');
  return value;
}
function positiveId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail('Некорректный идентификатор.');
  return n;
}
// Journal record ids: positive = YClients record, negative = queued outbox package.
function nonZeroId(value) {
  const n = Number(value);
  if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n === 0) fail('Некорректный идентификатор.');
  return n;
}
function fingerprint(value) {
  return crypto.createHmac('sha256', config.JWT_SECRET).update(JSON.stringify(value)).digest('hex');
}
function revision(r) {
  return fingerprint([r.id, r.datetime, r.staff_id, r.seance_length, r.services, r.client,
    r.attendance, r.deleted, r.paid_full, r.paid_amount, r.comment, r.resource_instance_ids]);
}
function editRevision(r) {
  return fingerprint([Number(r.id), moscowParts(r.datetime)?.ms, Number(r.staff_id || r.staff?.id), Number(r.seance_length),
    (r.services || []).map(s => [Number(s.id), Number(s.amount) || 1, Number(s.cost) || 0,
      Number(s.cost_per_unit ?? Number(s.first_cost ?? s.cost) / (Number(s.amount) || 1)) || 0,
      Number(s.discount) || 0]).sort((a,b) => a[0]-b[0]),
    Number(r.client?.id) || null, Number(r.attendance) || 0, !!r.deleted,
    Number(r.paid_full) > 0, Number(r.paid_amount) || 0, r.comment || '',
    (r.resource_instance_ids || []).map(Number).sort((a,b)=>a-b)]);
}
// Fingerprint of the visit's service lines only. An edit of services is
// compared against it; status, time, payments and the user's own earlier
// packages do not make a services edit «stale».
function servicesRevision(r) {
  return fingerprint((r.services || []).map(s => [Number(s.id), Number(s.amount) || 1, Number(s.cost) || 0,
    Number(s.cost_per_unit ?? Number(s.first_cost ?? s.cost) / (Number(s.amount) || 1)) || 0,
    Number(s.discount) || 0]).sort((a, b) => a[0] - b[0]));
}
function moscowParts(value) {
  let s = String(value || '').replace(' ', 'T');
  if (!s) return null;
  if (!/(Z|[+-]\d\d:\d\d)$/.test(s)) s += '+03:00';
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + 3 * 3600000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16), ms };
}
// YClients colour: «F4A0A0» or «#f4a0a0» — the format of custom_color in
// upstream answers is not confirmed on dev data, both are accepted.
function normColor(v) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}
// record_labels arrive as objects in GET /record, as plain ids in our own
// overlay (we send ids in PUT). A plain id has no title: the UI resolves it
// from the salon's label list (GET /day → labels).
function normalizeLabels(list) {
  return (Array.isArray(list) ? list : []).map(l => (l && typeof l === 'object')
    ? { id: Number(l.id), title: String(l.title || ''), color: normColor(l.color) || '' }
    : (typeof l === 'number' || (typeof l === 'string' && /^\d+$/.test(l.trim())))
      ? { id: Number(l), title: '', color: '' } : null)
    .filter(Boolean)
    .filter(l => Number.isSafeInteger(l.id) && l.id > 0);
}
// Seconds that must be a real non-negative number («Infinity» would make a
// visit occupy the whole day and break the slot search).
function nonNegSeconds(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
const countOf = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const truthy = v => v === true || v === 1 || v === '1';
function normalizeRecord(r, opts = {}) {
  const at = moscowParts(r.datetime || r.date);
  return {
    id: Number(r.id), staffId: Number(r.staff_id || r.staff?.id),
    staffName: String(r.staff?.name || 'Сотрудник'), date: at?.date, time: at?.time,
    duration: Number(r.seance_length) / 60 || 0,
    clientName: String(r.client?.name || 'Без имени'),
    services: (Array.isArray(r.services) ? r.services : []).map(s => ({ id: Number(s.id), title: String(s.title || ''), cost: Number(s.cost) || 0, quantity: Number(s.amount) || 1, unitPrice: Number(s.cost_per_unit ?? (Number(s.first_cost ?? s.cost) / (Number(s.amount) || 1))) || 0 })),
    attendance: Number(r.attendance) || 0, deleted: !!r.deleted,
    paid: !!r.paid_full || Number(r.paid_amount) > 0,
    // YClients colours a came visit orange only when it is paid in full (paid_full=1), yellow otherwise.
    paidFull: Number(r.paid_full) === 1,
    // Parity fields (12.11.2026).
    online: truthy(r.online), isNew: truthy(r.client?.is_new),
    comment: String(r.comment || ''),
    customColor: normColor(r.custom_color), fontColor: normColor(r.custom_font_color),
    labels: normalizeLabels(r.record_labels),
    technicalBreak: nonNegSeconds(r.technical_break_duration),
    visitCounts: { success: countOf(r.client?.success_visits_count), fail: countOf(r.client?.fail_visits_count) },
    // The phone is for the card only (owner/admin router); the day grid never carries it.
    ...(opts.withPhone ? { clientPhone: String(r.client?.phone || '') } : {}),
    version: revision(r), editVersion: editRevision(r), servicesVersion: servicesRevision(r),
    sync: r._sync || null,
  };
}
// YClients may cut calendar days in the company's own timezone. The caller
// fetches neighbouring dates; display and collision checks use Moscow instants.
function recordsForDay(records, date) {
  const start = Date.parse(date + 'T00:00:00+03:00'), end = start + 86400000;
  return records.filter(r => !r.deleted).flatMap(r => {
    const at = moscowParts(r.datetime || r.date);
    if (!at) fail('В YClients есть запись без корректного времени. Проверьте журнал источника.', 502);
    const length = Number(r.seance_length) / 60 || 0;
    const finish = at.ms + Math.max(length, 1) * 60000;
    if (at.ms >= end || finish <= start) return [];
    const normalized = normalizeRecord(r);
    if (at.ms < start) {
      normalized.date = date; normalized.time = '00:00';
      normalized.duration = (Math.min(finish, end) - start) / 60000;
      normalized.continued = true;
    }
    return [normalized];
  });
}
function parseDraft(body, action) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Некорректные данные.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId || '')) fail('Некорректный ключ операции.');
  const out = { operationId: body.operationId, action };
  if (action !== 'create') {
    out.recordId = positiveId(body.recordId);
    if (!/^[a-f0-9]{64}$/.test(body.version || '')) fail('Обновите карточку записи.');
    out.version = body.version;
  }
  if (action === 'create' || action === 'move') {
    out.date = dateKey(body.date);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '')) fail('Укажите время.');
    out.time = body.time;
    out.staffId = positiveId(body.staffId);
    if (action === 'create') {
      if (!Array.isArray(body.serviceIds) || !body.serviceIds.length || body.serviceIds.length > 10) fail('Выберите от 1 до 10 услуг.');
      out.serviceIds = [...new Set(body.serviceIds.map(positiveId))];
      if (body.serviceSource !== undefined) {
        if (body.serviceSource !== 'internal') fail('Неизвестный источник услуг.');
        out.serviceSource = 'internal';
      }
      if (body.lines !== undefined) {
        if (out.serviceSource !== 'internal') fail('Расчёт стоимости доступен для внутреннего каталога.');
        try { out.lines = pricing.quote(body.lines, out.serviceIds).lines; }
        catch (e) { fail(e.message); }
      }
      out.clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
      if (!out.clientName || out.clientName.length > 120) fail('Укажите имя клиента (до 120 символов).');
      out.clientPhone = String(body.clientPhone || '').replace(/[\s()+-]/g, '');
      if (!/^\d{11,15}$/.test(out.clientPhone)) fail('Укажите телефон с кодом страны.');
      if (out.clientPhone.length === 11 && out.clientPhone[0] === '8') out.clientPhone = '7' + out.clientPhone.slice(1);
      out.comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      if (out.comment.length > 1000) fail('Комментарий слишком длинный.');
      if (body.notifyClient !== undefined) {
        if (typeof body.notifyClient !== 'boolean') fail('Некорректный флаг уведомления.');
        out.notifyClient = body.notifyClient;
      }
    }
  }
  return out;
}
// What a full PUT /record must carry back so that a move or a status change
// does not wipe colour, labels and the technical break set in YClients.
function recordExtras(r) {
  const out = {};
  if (typeof r.custom_color === 'string' && r.custom_color) out.custom_color = r.custom_color;
  if (Array.isArray(r.record_labels)) out.record_labels = normalizeLabels(r.record_labels).map(l => l.id);
  if (nonNegSeconds(r.technical_break_duration) > 0) out.technical_break_duration = nonNegSeconds(r.technical_break_duration);
  return out;
}
const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function isAdministrator(staff) {
  // Position/specialization are explicit role metadata. Never infer a role
  // from a person's name or the online-booking hidden/bookable flags.
  const title = typeof staff.position === 'string' ? staff.position : staff.position?.title;
  return /администратор|administrator|receptionist/i.test([title, staff.specialization].filter(Boolean).join(' '));
}
function staffSchedule(schedule, date) {
  const day = schedule.find(d => String(d.date).slice(0, 10) === date);
  return { working: !!day && [true, 1, '1'].includes(day.is_working), workRanges: workRanges(schedule, date) };
}
function workRanges(schedule, date) {
  const day = schedule.find(d => String(d.date).slice(0, 10) === date);
  if (!day || ![true, 1, '1'].includes(day.is_working)) return [];
  if (!Array.isArray(day.slots)) fail('Не удалось проверить график.', 502);
  return mergeRanges(day.slots.map(s => {
    if (!/^\d\d:\d\d/.test(s.from) || !/^\d\d:\d\d/.test(s.to)) fail('Некорректный график.', 502);
    return { start: mins(s.from), end: mins(s.to) };
  }));
}
function slotsFor({ date, staffId, duration, breakMinutes = 0, schedule, records, resourceIds, resources, excludeId, now = Date.now() }) {
  // The visit's own technical break (12.11.2026) is occupied time after it.
  const span = duration + nonNegSeconds(breakMinutes);
  const relevant = records.filter(r => !r.deleted && Number(r.id) !== Number(excludeId));
  const windows = relevant.map(r => {
    const at = moscowParts(r.datetime || r.date);
    const length = Number(r.seance_length) / 60;
    // Unknown intervals cannot be treated as free time.
    if (!at || !(length > 0)) fail('Не удалось проверить длительность записей. Откройте YClients.', 502);
    const dayStart = Date.parse(date + 'T00:00:00+03:00');
    // A technical break after the visit is occupied time too (12.11.2026).
    const pause = nonNegSeconds(r.technical_break_duration) / 60;
    return { r, start: (at.ms - dayStart) / 60000, end: (at.ms - dayStart) / 60000 + length + pause };
  });
  const free = subtractRanges(workRanges(schedule, date), windows.filter(x => Number(x.r.staff_id || x.r.staff?.id) === staffId));
  const groups = resourceIds.map(id => {
    const r = resources.find(x => String(x.id) === String(id));
    if (!r || !Array.isArray(r.instances) || !r.instances.length) fail('Не удалось проверить оборудование.', 502);
    return r.instances.map(i => String(i.id));
  });
  const result = [];
  for (const range of free) for (let t = Math.ceil(range.start / 5) * 5; t + span <= range.end && t + span <= 1440; t += 5) {
    if (Date.parse(date + 'T00:00:00+03:00') + t * 60000 <= now) continue;
    const busy = new Set();
    for (const w of windows) if (t < w.end && t + span > w.start) {
      for (const id of (w.r.resource_instance_ids || [])) busy.add(String(id));
      // Older records may omit instance ids. Conservatively reserve every
      // instance of any required group shared by their service list.
      for (const g of (w.r._journalResourceIds || [])) {
        const index = resourceIds.findIndex(id => String(id) === String(g));
        if (index >= 0 && !(w.r.resource_instance_ids || []).length) groups[index].forEach(id => busy.add(id));
      }
    }
    if (!groups.every(ids => ids.some(id => !busy.has(id)))) continue;
    result.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return result;
}
module.exports = { JournalError, fail, nonNegSeconds, dateKey, positiveId, nonZeroId, fingerprint, revision, editRevision, servicesRevision, normalizeRecord, normColor, normalizeLabels, recordsForDay, parseDraft, moscowParts, slotsFor, recordExtras, isAdministrator, staffSchedule };
