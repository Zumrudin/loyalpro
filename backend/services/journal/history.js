'use strict';
// Local audit is persisted with the outbox row in the same transaction as a
// journal form. Raw webhook/outbox payloads are deliberately never returned.
const { db } = require('../../db');
const m = require('./model');

const CAP = 200;
const STATUS = { '-1': 'Не пришёл', 0: 'Ожидание', 1: 'Пришёл', 2: 'Подтвердил' };
const STEP = { create: 'создание', move: 'перенос', edit: 'изменение', confirm: 'подтверждение', cancel: 'отмена', delete: 'удаление', pay: 'оплата', payment: 'оплата', remove_payment: 'удаление оплаты', drop_payment: 'удаление неотправленной оплаты' };
const PACKAGE = { queued: 'сохранено', running: 'передаётся', done: 'передано', failed: 'ошибка передачи', uncertain: 'результат не подтверждён', cancelled: 'отменено' };
const TITLE = { create: 'Запись создана', update: 'Запись изменена', delete: 'Запись удалена' };
const OPERATION_TITLE = { create: 'Запись создана', move: 'Запись перенесена', edit: 'Запись изменена', confirm: 'Визит подтверждён', cancel: 'Визит отменён', delete: 'Запись удалена' };
const FINANCE_TITLE = { visit_payment: 'Оплата проведена', payment_reversal: 'Оплата удалена', bonus_redemption: 'Бонусы списаны', bonus_accrual: 'Бонусы начислены', bonus_adjustment: 'Бонусы скорректированы', bonus_opening: 'Начислен начальный баланс бонусов' };
// Keep this in lockstep with services/journal/audit.js.  In particular, do
// not broaden it to client objects, phone, email or arbitrary detail keys.
const SAFE_AUDIT_FIELDS = new Set(['datetime', 'staff', 'services', 'total', 'discount', 'duration', 'technical_break', 'attendance', 'comment', 'client', 'color', 'labels', 'notify', 'deleted', 'payment', 'bonus_payment']);

const when = v => { const p = m.moscowParts(v); return p ? `${p.date.slice(8, 10)}.${p.date.slice(5, 7)} ${p.time}` : null; };
const servicesText = list => (Array.isArray(list) ? list : []).map(s => {
  const qty = Number(s.amount) || 1, unit = Number(s.cost_per_unit), discount = Number(s.discount) || 0;
  return `${String(s.title || 'Услуга')}${qty > 1 ? ' ×' + qty : ''}${Number.isFinite(unit) ? `, ${unit} ₽ за ед.` : ''}${discount ? `, скидка ${discount}%` : ''} — ${Number(s.cost) || 0} ₽`;
}).sort().join('; ') || null;
const labelsText = list => m.normalizeLabels(list).map(l => l.title || '#' + l.id).sort().join(', ') || null;
const FIELDS = [
  ['datetime', 'Время', d => when(d.datetime || d.date)], ['staff', 'Специалист', d => d.staff?.name ? String(d.staff.name) : (d.staff_id != null ? '#' + Number(d.staff_id) : null)],
  ['services', 'Услуги, количество, цена и скидка', d => servicesText(d.services)], ['seance_length', 'Длительность', d => Number(d.seance_length) > 0 ? Math.round(Number(d.seance_length) / 60) + ' мин' : null],
  ['attendance', 'Статус', d => STATUS[Number(d.attendance) || 0] || null], ['comment', 'Комментарий', d => String(d.comment || '').trim() || null],
  ['client', 'Клиент', d => String(d.client?.name || '').trim() || null], ['custom_color', 'Цвет', d => m.normColor(d.custom_color)], ['record_labels', 'Метки', d => labelsText(d.record_labels)],
  ['technical_break_duration', 'Технический перерыв', d => `${Math.round((Number(d.technical_break_duration) || 0) / 60)} мин`],
  ['paid_full', 'Оплата', d => Number(d.paid_full) === 1 ? 'оплачено' : Number(d.paid_full) === 2 ? 'частично' : 'не оплачено'], ['deleted', 'Удалена', d => d.deleted ? 'да' : 'нет'],
];
function diffRecords(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  for (const [field, label, read] of FIELDS) { const from = read(prev) ?? null, to = read(next) ?? null; if (from !== to) out.push({ field, label, from, to }); }
  return out;
}
function iso(value) { const d = value instanceof Date ? value : new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString(); }
function text(value) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return typeof value === 'string' ? (value.replace(/[\r\n]+/g, ' ').trim().slice(0, 1000) || null) : null;
}
function safeChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap(c => (!c || typeof c !== 'object' || !SAFE_AUDIT_FIELDS.has(String(c.field || '')) || !text(c.label)) ? [] : [{ field: String(c.field), label: text(c.label), from: text(c.from), to: text(c.to) }]);
}
function rub(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Math.abs(n)) + ' ₽' : null; }
function count(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Math.abs(n)) : null; }
function methodText(method, accountTitle) {
  if (method === 'bonus' || method === 'loyalty_card') return 'бонусы';
  if (accountTitle) return String(accountTitle).slice(0, 160);
  return ({ cash: 'наличные', card: 'карта', account: 'касса' })[method] || 'способ оплаты не указан';
}
function author(users, userId, fallback) { const name = users.get(Number(userId)); return name ? `LoyalPro: ${name}` : fallback; }
function provenance(row) {
  const out = [];
  for (const key of ['outbox_id', 'step_op_id', 'journal_operation_id', 'operation_id', 'revenue_operation_id', 'loyalty_txn_id']) if (row?.[key] != null && String(row[key])) out.push(`${key}:${String(row[key])}`);
  return out;
}
function operationIdentity(row) {
  const id = row?.step_op_id ?? row?.journal_operation_id ?? row?.operation_id;
  return id == null || !String(id) ? null : `operation:${String(id)}`;
}
function financeEvent(row, users) {
  const kind = String(row.kind || (row.action === 'remove' ? 'payment_reversal' : row.action === 'payment' ? 'visit_payment' : ''));
  const money = rub(row.amount); if (!FINANCE_TITLE[kind] || !money) return null;
  const bonus = ['bonus', 'loyalty_card'].includes(String(row.method || '')) || kind.startsWith('bonus_');
  const removal = kind === 'payment_reversal';
  const value = bonus ? `${count(row.amount)} бонусов` : `${money} · ${methodText(String(row.method || ''), row.account_title)}`;
  const status = String(row.status || row.state || 'confirmed');
  let title = FINANCE_TITLE[kind];
  if (kind === 'bonus_adjustment') title = Number(row.amount) < 0 ? 'Бонусы списаны' : 'Бонусы начислены';
  if (status === 'pending' || status === 'queued' || status === 'sending') title = removal ? 'Удаление оплаты — ожидает подтверждения' : (bonus ? 'Бонусы — ожидают подтверждения' : 'Оплата — ожидает подтверждения');
  else if (status === 'failed' || status === 'rejected') title = removal ? 'Удаление оплаты — не проведено' : (bonus ? 'Бонусы — не списаны' : 'Оплата — не проведена');
  else if (status === 'cancelled') title = removal ? 'Удаление оплаты отменено' : (bonus ? 'Списание бонусов отменено' : 'Оплата отменена');
  else if (status === 'reviewed') title = removal ? 'Удаление оплаты — результат проверен вручную' : (bonus ? 'Бонусы — результат проверен вручную' : 'Оплата — результат проверен вручную');
  return { at: iso(row.occurred_at || row.created_at), source: 'finance', author: author(users, row.user_id, 'Неизвестно'), title, status, changes: [{ field: kind, label: bonus ? 'Бонусы' : 'Оплата', from: removal ? value : null, to: removal ? null : value }], provenance: provenance(row) };
}
function auditEvents(row, users, suppliedAudit) {
  const audit = suppliedAudit || row?.overlay?.audit;
  if (!audit || Number(audit.version) !== 1 || !Array.isArray(audit.events)) return [];
  const actorName = text(audit.actor?.name);
  const by = actorName ? `LoyalPro: ${actorName}` : author(users, audit.actor?.userId ?? row.user_id, 'LoyalPro: автор не указан');
  return audit.events.flatMap((event, order) => {
    if (!event || typeof event !== 'object' || !STEP[String(event.action || '')]) return [];
    const details = event.details && typeof event.details === 'object' ? event.details : {};
    const payment = ['payment', 'remove_payment', 'drop_payment'].includes(event.action);
    const amount = payment ? rub(details.amount) : null, removal = event.action !== 'payment';
    const changes = safeChanges(event.changes);
    // audit.js already stores the human-readable payment delta (and method
    // title) in its allow-listed changes.  Add a fallback only for old audit
    // snapshots that did not have it yet.
    const methodTitle = text(details.methodTitle) || methodText(String(details.method || ''));
    if (payment && amount && !changes.some(c => c.field === 'payment' || c.field === 'bonus_payment')) { const value = `${amount} · ${methodTitle}`; changes.push({ field: String(details.method) === 'loyalty_card' ? 'bonus_payment' : 'payment', label: String(details.method) === 'loyalty_card' ? 'Списание бонусов' : 'Оплата', from: removal ? value : null, to: removal ? null : value }); }
    if (payment && amount) changes.push({ field: 'payment_method', label: 'Способ оплаты', from: null, to: methodTitle });
    const allSteps = Array.isArray(row.steps) ? row.steps : [];
    const rowStatus = String(row.status || ({ pending: 'running', done: 'done', rejected: 'failed', reviewed: 'done' })[row.state] || '');
    // A package can fail after an earlier step succeeded.  The immutable audit
    // event is tied to its own step when supplied, so never label that earlier
    // payment as failed just because a later step failed.
    const stepOpId = event.stepOpId ?? details.stepOpId;
    const ownStep = stepOpId ? allSteps.find(s => String(s?.opId || '') === String(stepOpId)) : null;
    const localOnly = event.action === 'drop_payment' || (event.action === 'delete' && rowStatus === 'cancelled' && !allSteps.length && row.create_outbox_id != null && row.overlay?.kind === 'patch' && row.overlay.patch?.deleted === true);
    const status = localOnly ? 'local' : ownStep ? ({ done: 'done', failed: 'failed', pending: rowStatus === 'cancelled' ? 'cancelled' : rowStatus === 'running' ? 'running' : 'queued', uncertain: 'uncertain' }[String(ownStep.state)] || rowStatus) : rowStatus;
    const baseTitle = event.action === 'payment' ? 'Оплата сохранена' : event.action === 'remove_payment' ? 'Оплата удалена' : event.action === 'drop_payment' ? 'Неотправленная оплата удалена в LoyalPro' : (localOnly ? 'Несохранённая запись удалена в LoyalPro' : (OPERATION_TITLE[event.action] || 'Запись изменена'));
    const suffix = PACKAGE[status] ? ` — ${PACKAGE[status]}` : '';
    return [{ at: iso(row.created_at), source: 'journal', author: by, title: baseTitle + suffix, changes, status, outboxId: Number(row.id) || null, error: ['failed', 'uncertain'].includes(status) ? (text(row.error_text) || 'Не удалось передать изменение.') : null, errorCode: row.error_code || null, provenance: [`outbox_id:${row.id}`, ...(row.operation_id ? [`operation_id:${row.operation_id}`] : []), ...allSteps.filter(s => s?.opId).map(s => `step_op_id:${s.opId}`)], _order: order }];
  });
}
function legacyPaymentEvents(row, users) {
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return steps.flatMap((step, order) => {
    const kind = String(step?.kind || ''), details = step?.params && typeof step.params === 'object' ? step.params : {};
    if (!['pay', 'remove_payment'].includes(kind) || !rub(details.amount)) return [];
    const removal = kind === 'remove_payment', bonus = details.method === 'loyalty_card';
    const amount = bonus ? `${count(details.amount)} бонусов` : `${rub(details.amount)} · ${details.method === 'account' ? `касса #${Number(details.methodId) || '?'}` : methodText(String(details.method || ''))}`;
    const state = String(step.state || ''), status = ({ done: 'done', failed: 'failed', uncertain: 'uncertain', pending: row.status === 'cancelled' ? 'cancelled' : row.status === 'running' ? 'running' : 'queued' })[state] || String(row.status || '');
    return [{ at: iso(row.created_at), source: 'journal', author: author(users, row.user_id, 'LoyalPro: автор не указан'),
      title: (removal ? 'Оплата удалена' : bonus ? 'Бонусы списаны' : 'Оплата сохранена') + (PACKAGE[status] ? ` — ${PACKAGE[status]}` : ''),
      changes: [{ field: bonus ? 'bonus_payment' : 'payment', label: bonus ? (removal ? 'Возврат бонусов' : 'Списание бонусов') : 'Оплата', from: removal ? amount : null, to: removal ? null : amount }],
      status, outboxId: Number(row.id) || null, provenance: [`outbox_id:${row.id}`, ...(step.opId ? [`step_op_id:${step.opId}`] : [])], _order: order }];
  });
}
// webhookRows must be OLDEST FIRST (each is diffed against the previous one).
function mergeHistory(webhookRows, outboxRows, users = new Map(), operationRows = [], paymentRows = [], financeRows = []) {
  const events = []; let prev = null;
  for (const w of webhookRows || []) {
    const data = w.data && typeof w.data === 'object' ? w.data : null, status = TITLE[w.status] ? w.status : 'update', changes = diffRecords(prev, data);
    if (data) { if (!(status === 'update' && prev && !changes.length)) events.push({ at: iso(w.created_at), source: 'yclients', author: 'Неизвестно (YClients)', title: TITLE[status], changes }); prev = data; }
  }
  const captured = new Set(), stepIds = new Set();
  for (const o of outboxRows || []) for (const s of (Array.isArray(o.steps) ? o.steps : [])) if (s?.opId) stepIds.add(String(s.opId));
  for (const o of [...(outboxRows || [])].reverse()) {
    const detailed = auditEvents(o, users);
    if (detailed.length) { for (const e of detailed) for (const id of e.provenance || []) captured.add(id); events.push(...detailed); continue; }
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => ({ kind: String(s?.kind || ''), state: String(s?.state || '') }));
    const rawSteps = Array.isArray(o.steps) ? o.steps : [];
    events.push({ at: iso(o.created_at), source: 'journal', author: author(users, o.user_id, 'LoyalPro: автор не указан'), title: o.status === 'cancelled' && !steps.length ? 'Удалена до отправки' : steps.length && steps.every(s => s.kind === 'drop_payment') ? 'Неотправленная оплата удалена' : `${steps.map(s => STEP[s.kind] || s.kind).join(', ') || 'изменения'} — ${PACKAGE[o.status] || String(o.status)}`, changes: [], status: String(o.status), steps, outboxId: Number(o.id) || null, error: o.status === 'failed' ? (text(o.error_text) || 'Не удалось передать изменение.') : null, errorCode: o.error_code || null, provenance: [`outbox_id:${o.id}`, ...rawSteps.filter(s => s?.opId).map(s => `step_op_id:${s.opId}`)] });
    // Earlier packages predate overlay.audit.  Their steps still hold only
    // safe payment parameters, so expose the amount/method without guessing a
    // before balance or looking into raw request payloads.
    const legacyPayments = legacyPaymentEvents(o, users);
    for (const event of legacyPayments) for (const id of event.provenance) captured.add(id);
    events.push(...legacyPayments);
  }
  for (const op of operationRows || []) {
    if (stepIds.has(String(op.operation_id)) || !OPERATION_TITLE[String(op.action || '')]) continue;
    const detailed = auditEvents(op, users, op.result?._localAudit);
    if (detailed.length) { events.push(...detailed); continue; }
    const state = String(op.state || '');
    const suffix = state === 'pending' ? ' — ожидает подтверждения' : state === 'rejected' ? ' — не выполнено' : state === 'reviewed' ? ' — результат проверен вручную' : '';
    events.push({ at: iso(op.created_at), source: 'journal', author: author(users, op.user_id, 'LoyalPro: автор не указан'), title: OPERATION_TITLE[op.action] + suffix, changes: [], status: state, provenance: provenance(op) });
  }
  // finance_operations is the richer materialised representation of old
  // direct journal payment rows (method/cash-account status).  The two rows
  // share an operation id; choose it once by provenance, never by amount.
  const representedOperations = new Set();
  for (const row of [...(financeRows || []), ...(paymentRows || [])]) {
    const ids = provenance(row);
    if (ids.some(id => captured.has(id) || (id.startsWith('operation_id:') && stepIds.has(id.slice(13))) || (id.startsWith('journal_operation_id:') && stepIds.has(id.slice(21))))) continue;
    const operation = operationIdentity(row);
    if (operation && representedOperations.has(operation)) continue;
    const event = financeEvent(row, users); if (event) events.push(event);
    if (event && operation) representedOperations.add(operation);
  }
  return events.map((e, i) => ({ e, i })).sort((a, b) => (Date.parse(b.e.at) - Date.parse(a.e.at)) || ((b.e._order || 0) - (a.e._order || 0)) || (b.i - a.i)).map(x => { const { provenance: _p, _order, ...event } = x.e; return event; }).slice(0, CAP);
}
const WEBHOOK_SQL = `SELECT created_at, payload->>'status' AS status, payload->'data' AS data FROM webhook_logs WHERE salon_id=$1 AND event_type='record' AND resource_id=$2 AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz) ORDER BY created_at DESC, id DESC LIMIT ${CAP}`;
const OUTBOX_SQL = `SELECT id, user_id, status, steps, overlay, create_outbox_id, error_code, error_text, created_at FROM journal_outbox WHERE salon_id=$1 AND (yclients_record_id=$2 OR id=$3 OR create_outbox_id=$3) ORDER BY id DESC LIMIT ${CAP}`;
const OPERATIONS_SQL = `SELECT operation_id, user_id, action, state, result, created_at FROM journal_operations WHERE salon_id=$1 AND record_id=$2 ORDER BY created_at DESC LIMIT ${CAP}`;
const PAYMENTS_SQL = `SELECT operation_id, user_id, action, method, amount, state, created_at FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 ORDER BY created_at DESC LIMIT ${CAP}`;
const FINANCE_SQL = `SELECT id, user_id, kind, method, amount, status, account_title, occurred_at, outbox_id, step_op_id, journal_operation_id, revenue_operation_id, loyalty_txn_id FROM finance_operations WHERE salon_id=$1 AND yclients_record_id=$2 ORDER BY occurred_at DESC, id DESC LIMIT ${CAP}`;
const USERS_SQL = 'SELECT id, name FROM users WHERE salon_id=$1 AND id = ANY($2::int[])';
const CREATED_SQL = "SELECT raw_payload->>'create_date' AS create_date FROM records WHERE salon_id=$1 AND yclients_record_id=$2";
const CREATE_SQL = 'SELECT yclients_record_id FROM journal_outbox WHERE salon_id=$1 AND id=$2';
async function optionalAny(sql, args) { try { return await db.any(sql, args); } catch (e) { if (['42P01', '42703'].includes(e?.code)) return []; throw e; } }
async function load(salonId, recordId) {
  let ycId = recordId > 0 ? Number(recordId) : null; const createId = recordId < 0 ? -Number(recordId) : null;
  if (createId) { const row = await db.oneOrNone(CREATE_SQL, [salonId, createId]); if (!row) m.fail('Запись не найдена.', 404); if (row.yclients_record_id != null) ycId = Number(row.yclients_record_id); }
  let since = null;
  if (ycId) try { const rec = await db.oneOrNone(CREATED_SQL, [salonId, ycId]); const p = rec?.create_date ? m.moscowParts(String(rec.create_date).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null; if (p) since = new Date(p.ms - 86400000); } catch (_) { /* unbounded fallback */ }
  const [hooks, outbox, operations, payments, finance] = await Promise.all([ycId ? optionalAny(WEBHOOK_SQL, [salonId, String(ycId), since]) : Promise.resolve([]), optionalAny(OUTBOX_SQL, [salonId, ycId, createId]), ycId ? optionalAny(OPERATIONS_SQL, [salonId, ycId]) : Promise.resolve([]), ycId ? optionalAny(PAYMENTS_SQL, [salonId, ycId]) : Promise.resolve([]), ycId ? optionalAny(FINANCE_SQL, [salonId, ycId]) : Promise.resolve([])]);
  const all = [...outbox, ...operations, ...payments, ...finance], ids = [...new Set(all.map(x => Number(x.user_id)).filter(n => Number.isSafeInteger(n) && n > 0))];
  const users = new Map((ids.length ? await optionalAny(USERS_SQL, [salonId, ids]) : []).map(u => [Number(u.id), String(u.name || '')]));
  return { recordId, events: mergeHistory([...hooks].reverse(), outbox, users, operations, payments, finance) };
}
module.exports = { diffRecords, mergeHistory, load, WEBHOOK_SQL, OUTBOX_SQL, OPERATIONS_SQL, PAYMENTS_SQL, FINANCE_SQL, CREATED_SQL, CAP };
