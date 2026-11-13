'use strict';
// History of a journal record (spec 2026-11-12 §4.2): YClients record webhooks
// (diffed one against the previous) merged with our outbox packages. No new
// table. Never returns the client's phone or email: only listed fields are
// compared, and of a package only step kind/state leave this module (steps
// hold drafts with the phone).
const { db } = require('../../db');
const m = require('./model');

const CAP = 200;
const STATUS = { '-1': 'Не пришёл', 0: 'Ожидание', 1: 'Пришёл', 2: 'Подтвердил' };
const STEP = { create: 'создание', move: 'перенос', edit: 'изменение', confirm: 'подтверждение', cancel: 'отмена',
  delete: 'удаление', pay: 'оплата', remove_payment: 'удаление оплаты', drop_payment: 'удаление неотправленной оплаты' };
const PACKAGE = { queued: 'ждёт отправки', running: 'передаётся', done: 'отправлено', failed: 'ошибка', cancelled: 'отменено' };
const TITLE = { create: 'Запись создана', update: 'Запись изменена', delete: 'Запись удалена' };

const when = v => { const p = m.moscowParts(v); return p ? `${p.date.slice(8, 10)}.${p.date.slice(5, 7)} ${p.time}` : null; };
const servicesText = list => (Array.isArray(list) ? list : [])
  .map(s => `${String(s.title || 'Услуга')}${Number(s.amount) > 1 ? ' ×' + Number(s.amount) : ''} — ${Number(s.cost) || 0} ₽`)
  .sort().join('; ') || null;
const labelsText = list => m.normalizeLabels(list).map(l => l.title || '#' + l.id).sort().join(', ') || null;
const FIELDS = [
  ['datetime', 'Время', d => when(d.datetime || d.date)],
  ['staff', 'Специалист', d => d.staff?.name ? String(d.staff.name) : (d.staff_id != null ? '#' + Number(d.staff_id) : null)],
  ['services', 'Услуги', d => servicesText(d.services)],
  ['seance_length', 'Длительность', d => Number(d.seance_length) > 0 ? Math.round(Number(d.seance_length) / 60) + ' мин' : null],
  ['attendance', 'Статус', d => STATUS[Number(d.attendance) || 0] || null],
  ['comment', 'Комментарий', d => String(d.comment || '').trim() || null],
  ['custom_color', 'Цвет', d => m.normColor(d.custom_color)],
  ['record_labels', 'Метки', d => labelsText(d.record_labels)],
  ['paid_full', 'Оплата', d => Number(d.paid_full) === 1 ? 'оплачено' : Number(d.paid_full) === 2 ? 'частично' : 'не оплачено'],
  ['deleted', 'Удалена', d => d.deleted ? 'да' : 'нет'],
];
function diffRecords(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  for (const [field, label, read] of FIELDS) {
    const from = read(prev) ?? null, to = read(next) ?? null;
    if (from !== to) out.push({ field, label, from, to });
  }
  return out;
}
const iso = v => (v instanceof Date ? v : new Date(v)).toISOString();
// webhookRows must be OLDEST FIRST (each is diffed against the previous one).
function mergeHistory(webhookRows, outboxRows, users = new Map()) {
  const events = [];
  let prev = null;
  for (const w of webhookRows || []) {
    const data = w.data && typeof w.data === 'object' ? w.data : null;
    const status = TITLE[w.status] ? w.status : 'update';
    const changes = diffRecords(prev, data);
    if (data) {
      // A repeated/irrelevant update (nothing we show changed) is noise.
      if (!(status === 'update' && prev && !changes.length)) events.push({ at: iso(w.created_at), source: 'yclients', author: 'Синхронизация', title: TITLE[status], changes });
      prev = data;
    }
  }
  // Outbox rows arrive newest-first from SQL: walk them oldest-first so the tie-break above holds.
  for (const o of [...(outboxRows || [])].reverse()) {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => ({ kind: String(s?.kind || ''), state: String(s?.state || '') }));
    const name = users.get(Number(o.user_id));
    events.push({ at: iso(o.created_at), source: 'journal', author: 'LoyalPro' + (name ? ': ' + name : ''),
      title: o.status === 'cancelled' && !steps.length ? 'Удалена до отправки'
        : steps.length && steps.every(s => s.kind === 'drop_payment') ? 'Неотправленная оплата удалена'
        : `${steps.map(s => STEP[s.kind] || s.kind).join(', ') || 'изменения'} — ${PACKAGE[o.status] || String(o.status)}`,
      changes: [], status: String(o.status), steps,
      error: o.status === 'failed' ? String(o.error_text || 'причина неизвестна') : null,
      errorCode: o.error_code || null });
  }
  // Equal time: newer on top. Events are pushed oldest → newest (webhooks), so the later index wins.
  return events.map((e, i) => ({ e, i }))
    .sort((a, b) => (Date.parse(b.e.at) - Date.parse(a.e.at)) || (b.i - a.i)).map(x => x.e).slice(0, CAP);
}
const WEBHOOK_SQL = `SELECT created_at, payload->>'status' AS status, payload->'data' AS data FROM webhook_logs
  WHERE salon_id=$1 AND event_type='record' AND resource_id=$2
    AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
  ORDER BY created_at DESC, id DESC LIMIT ${CAP}`;
const OUTBOX_SQL = `SELECT id, user_id, status, steps, error_code, error_text, created_at FROM journal_outbox
  WHERE salon_id=$1 AND (yclients_record_id=$2 OR id=$3 OR create_outbox_id=$3)
  ORDER BY id DESC LIMIT ${CAP}`;
const USERS_SQL = 'SELECT id, name FROM users WHERE salon_id=$1 AND id = ANY($2::int[])';
// Record creation date from the mirror: no webhook exists before it, so it bounds the (salon_id, created_at) index range.
const CREATED_SQL = "SELECT raw_payload->>'create_date' AS create_date FROM records WHERE salon_id=$1 AND yclients_record_id=$2";
const CREATE_SQL = 'SELECT yclients_record_id FROM journal_outbox WHERE salon_id=$1 AND id=$2';
async function load(salonId, recordId) {
  let ycId = recordId > 0 ? Number(recordId) : null;
  const createId = recordId < 0 ? -Number(recordId) : null;
  if (createId) {
    const row = await db.oneOrNone(CREATE_SQL, [salonId, createId]);
    if (!row) m.fail('Запись не найдена.', 404);
    if (row.yclients_record_id != null) ycId = Number(row.yclients_record_id);
  }
  let since = null;
  if (ycId) {
    try {
      const rec = await db.oneOrNone(CREATED_SQL, [salonId, ycId]);
      const p = rec?.create_date ? m.moscowParts(String(rec.create_date).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null;
      if (p) since = new Date(p.ms - 86400000);
    } catch (_) { /* no bound: slower, still correct */ }
  }
  const [hooks, outbox] = await Promise.all([
    ycId ? db.any(WEBHOOK_SQL, [salonId, String(ycId), since]) : Promise.resolve([]),
    db.any(OUTBOX_SQL, [salonId, ycId, createId]),
  ]);
  const ids = [...new Set((outbox || []).map(o => Number(o.user_id)).filter(n => Number.isSafeInteger(n) && n > 0))];
  const users = new Map((ids.length ? await db.any(USERS_SQL, [salonId, ids]) : []).map(u => [Number(u.id), String(u.name || '')]));
  return { recordId, events: mergeHistory([...(hooks || [])].reverse(), outbox, users) };
}
module.exports = { diffRecords, mergeHistory, load, WEBHOOK_SQL, OUTBOX_SQL, CREATED_SQL, CAP };
