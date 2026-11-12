'use strict';
// Journal form sessions (local-first). Everything done during ONE opening of
// a journal form arrives as a single package. It is validated against LOCAL
// data only (mirror `records`, reference cache, payment ledger, open outbox) —
// never YClients — and stored in `journal_outbox`; the outbox worker executes
// the steps later through the existing mutate()/payments.pay() cores.
const crypto = require('crypto');
const { db } = require('../../db');
const config = require('../../config');
const m = require('./model');
const pricing = require('./pricing');
const sources = require('./sources');
const index = require('./index');
const localCatalog = require('../service-catalog');
const paymentsLocal = require('./payments-local');
const finOps = require('../finance-ops');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAYMENTS = 10, MAX_REMOVES = 10;
const DUMMY_VERSION = '0'.repeat(64);
const kop = v => Math.round((Number(v) || 0) * 100);
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const present = v => v !== undefined && v !== null;

function amountOf(value) {
  let cents;
  try { cents = pricing.money(value); } catch (e) { m.fail(e.message); }
  if (cents <= 0) m.fail('Сумма оплаты должна быть больше нуля.');
  return cents / 100;
}
function methodOf(p) {
  if (!['account', 'loyalty_card'].includes(p.method)) m.fail('Способ оплаты не поддерживается.');
  return { method: p.method, methodId: m.positiveId(p.methodId), amount: amountOf(p.amount) };
}
function parsePayment(p) {
  if (!isObject(p)) m.fail('Некорректная оплата.');
  const out = methodOf(p);
  if (p.confirmArrival !== undefined) {
    if (p.confirmArrival !== true) m.fail('Некорректное подтверждение прихода.');
    if (p.method !== 'account') m.fail('Подтверждение прихода доступно только при оплате в кассу.');
    out.confirmArrival = true;
  }
  return out;
}
function parseRemove(p) {
  if (!isObject(p)) m.fail('Некорректное удаление оплаты.');
  return { transactionId: m.positiveId(p.transactionId), ...methodOf(p) };
}
function listOf(value, max, parse, label) {
  if (!present(value)) return [];
  if (!Array.isArray(value)) m.fail(`Некорректный список: ${label}.`);
  if (value.length > max) m.fail(`Слишком много операций: ${label} (не больше ${max}).`);
  return value.map(parse);
}

function parseSession(body) {
  if (!isObject(body)) m.fail('Некорректные данные.');
  if (!UUID.test(body.sessionId || '')) m.fail('Некорректный ключ формы.');
  const hasRecord = present(body.recordId), hasCreate = present(body.create);
  if (hasRecord === hasCreate) m.fail('Укажите либо запись, либо данные новой записи.');
  const out = { sessionId: body.sessionId };
  if (hasRecord) {
    // Negative ids are new records not yet sent to YClients (-outbox id):
    // their changes are queued after the create package.
    out.recordId = m.nonZeroId(body.recordId);
  } else {
    if (!isObject(body.create)) m.fail('Некорректные данные новой записи.');
    const { operationId, ...draft } = m.parseDraft({ ...body.create, operationId: body.sessionId }, 'create');
    out.create = draft;
  }
  if (present(body.edit)) {
    if (!hasRecord) m.fail('Изменение доступно только для сохранённой записи.');
    out.edit = require('./record-edit').parse(body.edit);
    // Status/services and time/staff of the same card go in ONE package
    // (move first, then edit). Payments and confirm/cancel stay separate.
    // Delete may carry the card's unsaved edit (e.g. «не уведомлять»); other statuses and payments go separately.
    if ((present(body.status) && body.status !== 'delete') || body.payments?.length || body.removePayments?.length) m.fail('Сохраните изменения записи отдельно от оплат.');
  }
  if (present(body.move)) {
    if (!hasRecord) m.fail('Перенос доступен только для сохранённой записи.');
    if (!isObject(body.move)) m.fail('Некорректные данные переноса.');
    const d = m.parseDraft({ date: body.move.date, time: body.move.time, staffId: body.move.staffId,
      recordId: Math.abs(out.recordId), version: DUMMY_VERSION, operationId: body.sessionId }, 'move');
    out.move = { date: d.date, time: d.time, staffId: d.staffId };
  }
  if (present(body.status)) {
    if (!hasRecord) m.fail('Статус меняется только у сохранённой записи.');
    if (!['confirm', 'cancel', 'delete'].includes(body.status)) m.fail('Неизвестный статус записи.');
    out.status = body.status;
  }
  if (out.move && out.status === 'cancel') m.fail('Нельзя одновременно перенести и отменить запись.');
  if (out.move && out.status === 'delete') m.fail('Нельзя одновременно перенести и удалить запись.');
  out.payments = listOf(body.payments, MAX_PAYMENTS, parsePayment, 'оплаты');
  out.removePayments = listOf(body.removePayments, MAX_REMOVES, parseRemove, 'удаления оплат');
  const keys = out.removePayments.map(r => r.method + ':' + r.transactionId);
  if (new Set(keys).size !== keys.length) m.fail('Одна оплата указана к удалению дважды.');
  if (out.status === 'cancel' && (out.payments.length || out.removePayments.length)) m.fail('Отменённый визит нельзя оплатить.');
  if (out.status === 'delete' && (out.payments.length || out.removePayments.length)) m.fail('Удалённую запись нельзя оплатить.');
  if (!out.edit && !out.create && !out.move && !out.status && !out.payments.length && !out.removePayments.length) m.fail('Нет изменений для сохранения.');
  return out;
}

// Bonuses before cash: the order verified live on 09.11.2026.
const orderedPayments = session => [
  ...session.payments.filter(p => p.method === 'loyalty_card'),
  ...session.payments.filter(p => p.method === 'account'),
];
const step = (kind, params) => ({ kind, opId: crypto.randomUUID(), params, state: 'pending' });
function buildSteps(session) {
  const steps = [];
  if (session.create) steps.push(step('create', { ...session.create }));
  // Move before edit: a status «arrived» set first would make the move refuse.
  // A new length/break saved with the move is applied by the move itself, so
  // the worker never moves with the old length first (time could be taken in
  // between). Absent fields keep the old params byte-for-byte.
  if (session.move) steps.push(step('move', { date: session.move.date, time: session.move.time, staffId: session.move.staffId,
    ...(session.edit?.seanceLength !== undefined ? { seanceLength: session.edit.seanceLength } : {}),
    ...(session.edit?.technicalBreak !== undefined ? { technicalBreak: session.edit.technicalBreak } : {}) }));
  if (session.edit) steps.push(step('edit', session.edit));
  if (session.status) steps.push(step(session.status, {}));
  for (const p of orderedPayments(session)) {
    steps.push(step('pay', { method: p.method, methodId: p.methodId, amount: p.amount, ...(p.confirmArrival ? { confirmArrival: true } : {}) }));
  }
  for (const r of session.removePayments) {
    steps.push(step('remove_payment', { transactionId: r.transactionId, method: r.method, methodId: r.methodId, amount: r.amount }));
  }
  return steps;
}

async function salonFor(salonId) {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id) m.fail('YClients не подключён для салона.', 409);
  return salon;
}
async function createServices(salon, draft, available, src) {
  if (draft.serviceSource === 'internal') {
    // YClients ids (as in a mirrored record): the unsent new record must be
    // editable in the card exactly like a saved one.
    const rows = await localCatalog.resolve(salon, draft.serviceIds);
    return rows.map((s, i) => {
      const line = draft.lines?.find(l => l.serviceId === Number(s.id));
      const p = available.servicePayload?.[i] || {};
      const cost = line ? line.total : Number(p.cost) || 0;
      return { ...p, id: Number(s.yclients_id) || Number(s.id), title: String(s.title || ''), amount: line ? line.quantity : Number(p.amount) || 1, cost };
    });
  }
  const all = await src.services();
  return draft.serviceIds.map(id => {
    const s = all.find(x => Number(x.id) === id) || {};
    return { id, title: String(s.title || ''), cost: Number(s.price_min) || 0 };
  });
}
const busy = () => m.fail('Время уже занято. Выберите другое.', 409, 'slot_taken');

async function validate(salonId, session) {
  const salon = await salonFor(salonId);
  // Local when local-first is on and the cache is warm, else live (rollback).
  const src = await sources.forSalon(salon);
  let overlay, ctx, attendance;
  if (session.create) {
    const d = session.create;
    const available = await index.availability(salon, d, null, src);
    if (!available.slots.includes(d.time)) busy();
    overlay = {
      kind: 'create', date: d.date, time: d.time, staffId: d.staffId, duration: available.duration,
      services: await createServices(salon, d, available, src),
      ...(d.lines ? { lines: d.lines.map(l => ({ serviceId: l.serviceId, quantity: l.quantity, total: l.total })) } : {}),
      client: { name: d.clientName, phone: d.clientPhone }, comment: d.comment, attendance: 0,
    };
    ctx = await paymentsLocal.createContext(salonId, overlay);
    attendance = 0;
  } else {
    ctx = await paymentsLocal.loadContext(salonId, session.recordId);
    const record = ctx.record;
    // A cancelled visit (-1) can still be deleted; a deleted one cannot be changed at all.
    if (record.deleted || (!session.edit && session.status !== 'delete' && Number(record.attendance) === -1)) m.fail('Запись уже отменена или удалена.', 409);
    const patch = {};
    if (session.move || session.status) {
      const paid = paymentsLocal.localOptions(ctx).paid.length > 0;
      if (Number(record.attendance) === 1 || record.paid_full || Number(record.paid_amount) > 0 || paid) {
        m.fail('Пришедшие и оплаченные визиты изменяйте в YClients.', 409);
      }
    }
    if (session.move) {
      // A move saved together with a new length/break is checked with them.
      const draft = { action: 'move', recordId: session.recordId, ...session.move,
        ...(session.edit?.seanceLength !== undefined ? { durationOverride: session.edit.seanceLength } : {}),
        ...(session.edit?.technicalBreak !== undefined ? { technicalBreak: session.edit.technicalBreak } : {}) };
      const available = await index.availability(salon, draft, record, src);
      if (!available.slots.includes(session.move.time)) busy();
      patch.datetime = `${session.move.date}T${session.move.time}:00+03:00`;
      patch.staff_id = session.move.staffId;
      patch.seance_length = Number(record.seance_length);
    }
    if (session.edit) {
      // The edit is checked against the visit as it will be AFTER the move:
      // new services must fit the new time and belong to the new staff.
      const moved = session.move ? { ...record, datetime: patch.datetime, staff_id: patch.staff_id } : record;
      Object.assign(patch, await require('./record-edit').patch(salon, moved, session.edit, src, index.availability, paymentsLocal.localOptions(ctx).paid.length > 0));
      // Display only: the worker builds the YClients body itself; the flag goes
      // to journal_record_prefs (task 5), never into PUT /record.
      if (session.edit.notifyClient !== undefined) patch.notify_client = session.edit.notifyClient;
    }
    if (session.status === 'confirm') patch.attendance = 2;
    if (session.status === 'cancel') patch.cancel = true;
    if (session.status === 'delete') patch.deleted = true;
    overlay = { kind: 'patch', patch };
    attendance = patch.attendance ?? (session.status === 'confirm' ? 2 : Number(record.attendance) || 0);
  }
  // Payments in step order, each against the form state left by the previous.
  const queued = [...(ctx.queued || [])];
  const state = () => ({ ...ctx, record: { ...ctx.record, attendance }, queued });
  let arrived = false;
  for (const p of orderedPayments(session)) {
    const options = paymentsLocal.localOptions(state());
    const method = options.methods.find(v => v.method === p.method && v.id === p.methodId);
    if (!method) m.fail('Способ оплаты недоступен для этого визита.', 409);
    if (p.method === 'account' && config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED !== true) {
      m.fail('Оплата в кассу временно отключена. Проведите её в YClients.', 409, 'payment_disabled');
    }
    if (kop(p.amount) > kop(method.limit)) m.fail(`Сумма больше доступной: ${method.title}`, 409);
    if (p.method === 'account' && attendance === 0) {
      if (!p.confirmArrival) m.fail('Для оплаты записи в ожидании подтвердите действие «Оплатить и отметить приход».', 409, 'arrival_confirmation_required');
      attendance = 1; arrived = true;
    }
    queued.push({ kind: 'pay', method: p.method, methodId: p.methodId, amount: p.amount });
  }
  if (session.removePayments.length) {
    const paid = paymentsLocal.localOptions(ctx).paid;
    const taken = new Set((ctx.queued || []).filter(q => q.kind === 'remove_payment').map(q => q.method + ':' + q.transactionId));
    for (const r of session.removePayments) {
      const key = r.method + ':' + r.transactionId;
      // A transaction absent from the local ledger (e.g. paid in YClients) is
      // allowed: payments.pay re-checks membership and amount live. One that
      // IS in the ledger must match it exactly.
      const known = paid.find(p => p.method === r.method && p.id === r.transactionId);
      const mismatch = known && (known.methodId !== r.methodId || kop(known.amount) !== kop(r.amount));
      if (mismatch || taken.has(key)) m.fail('Транзакция уже изменена.', 409);
      taken.add(key);
      queued.push({ kind: 'remove_payment', transactionId: r.transactionId, method: r.method, methodId: r.methodId, amount: r.amount });
    }
  }
  if (arrived) {
    if (overlay.kind === 'create') overlay.attendance = 1;
    else overlay.patch.attendance = 1;
  }
  return { steps: buildSteps(session), overlay, options: paymentsLocal.localOptions(state()) };
}

const OUTBOX_BY_SESSION = 'SELECT id, request_hash, status FROM journal_outbox WHERE salon_id=$1 AND session_id=$2';
function replay(row, session, hash) {
  if (row.request_hash !== hash) m.fail('Ключ формы уже использован.', 409, 'session_used');
  return { outboxId: Number(row.id), recordId: session.recordId ?? -Number(row.id), status: row.status, duplicate: true };
}
// A negative record id is a new record still queued (-outbox id). Once its
// create reached YClients the change goes to the real record instead.
async function parentOf(salonId, session) {
  if (!present(session.recordId) || Number(session.recordId) > 0) return null;
  const row = await db.oneOrNone("SELECT id, status, yclients_record_id, overlay FROM journal_outbox WHERE salon_id=$1 AND id=$2", [salonId, -Number(session.recordId)]);
  if (!row || row.overlay?.kind !== 'create' || row.status === 'cancelled') m.fail('Запись не найдена.', 404);
  if (row.status === 'failed' && row.yclients_record_id == null) m.fail('Запись не создана в YClients. Повторите отправку или уберите её из журнала.', 409);
  return row;
}
async function enqueue(salonId, userId, session) {
  const hash = m.fingerprint(session);
  try {
    // Idempotency first: a replay of a queued session must get the same answer
    // even though its own overlay now occupies the slot.
    const prior = await db.oneOrNone(OUTBOX_BY_SESSION, [salonId, session.sessionId]);
    if (prior) return replay(prior, session, hash);
    const parent = await parentOf(salonId, session);
    const { steps, overlay } = await validate(salonId, session);
    const uid = Number(userId);
    const recordId = parent ? (parent.yclients_record_id != null ? Number(parent.yclients_record_id) : null) : (session.recordId ?? null);
    const row = await db.oneOrNone(`INSERT INTO journal_outbox(salon_id,session_id,user_id,request_hash,yclients_record_id,create_outbox_id,status,steps,overlay)
      VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8) ON CONFLICT (salon_id,session_id) DO NOTHING RETURNING id, status`,
    [salonId, session.sessionId, Number.isSafeInteger(uid) && uid > 0 ? uid : null, hash, recordId, parent ? Number(parent.id) : null, JSON.stringify(steps), JSON.stringify(overlay)]);
    if (!row) {
      const raced = await db.oneOrNone(OUTBOX_BY_SESSION, [salonId, session.sessionId]);
      if (!raced) m.fail('Не удалось сохранить изменения. Повторите.', 409);
      return replay(raced, session, hash);
    }
    // Ledger of finance operations (never breaks the save: failures are logged, reconcile catches up).
    await finOps.safely('journal-package', () => finOps.recordJournalPackage({ id: row.id, salon_id: salonId,
      user_id: Number.isSafeInteger(uid) && uid > 0 ? uid : null, yclients_record_id: recordId,
      create_outbox_id: parent ? Number(parent.id) : null, overlay, created_at: new Date(), status: 'queued' }, steps));
    return { outboxId: Number(row.id), recordId: session.recordId ?? -Number(row.id), status: row.status };
  } catch (e) {
    if (e.code === '42P01') m.fail('Журнал ещё не подготовлен: требуется миграция базы.', 503);
    throw e;
  }
}

async function outboxRow(salonId, outboxId) {
  const row = await db.oneOrNone('SELECT id, status, error_code, steps FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, outboxId]);
  if (!row) m.fail('Пакет не найден.', 404);
  return row;
}
// Only a definite failure is retried. An uncertain step (money/record outcome
// unknown) is never re-sent: it needs reconciliation in YClients.
async function retry(salonId, outboxId) {
  const row = await outboxRow(salonId, outboxId);
  const steps = Array.isArray(row.steps) ? row.steps : [];
  if (row.status !== 'failed') m.fail('Повторить можно только пакет с ошибкой.', 409);
  if (row.error_code === 'uncertain' || steps.some(s => s?.state === 'uncertain')) m.fail('Результат пакета не подтверждён. Сверьте запись в YClients.', 409, 'uncertain');
  // A failed step had no external effect; a fresh opId keeps the core's
  // per-operation idempotency (a rejected key is never replayable) out of the way.
  const next = steps.map(s => s?.state === 'failed' ? { ...s, state: 'pending', opId: crypto.randomUUID() } : s);
  const updated = await db.oneOrNone(`UPDATE journal_outbox SET status='queued', attempts=0, next_attempt_at=NOW(), error_code=NULL,
    error_text=NULL, failed_step=NULL, steps=$3, updated_at=NOW()
    WHERE salon_id=$1 AND id=$2 AND status='failed' AND error_code IS DISTINCT FROM 'uncertain' RETURNING id, status`,
  [salonId, outboxId, JSON.stringify(next)]);
  if (!updated) m.fail('Пакет уже изменён. Обновите журнал.', 409);
  await finOps.safely('journal-retry', async () => {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]?.state === 'failed' && next[i].opId !== steps[i].opId) await finOps.rekeyStep(salonId, steps[i].opId, next[i].opId);
    }
    await finOps.markOutbox(salonId, [outboxId], 'sending');
  });
  return { outboxId: Number(updated.id), status: updated.status };
}
async function dismiss(salonId, outboxId) {
  const row = await outboxRow(salonId, outboxId);
  if (row.status !== 'failed') m.fail('Отменить можно только пакет с ошибкой.', 409);
  const updated = await db.oneOrNone(`UPDATE journal_outbox SET status='cancelled', updated_at=NOW()
    WHERE salon_id=$1 AND id=$2 AND status='failed' RETURNING id, status, yclients_record_id`, [salonId, outboxId]);
  if (!updated) m.fail('Пакет уже изменён. Обновите журнал.', 409);
  // The new record was never created: its later changes have nothing to apply to.
  if (updated.yclients_record_id == null) {
    await db.query(`UPDATE journal_outbox SET status='cancelled', updated_at=NOW()
      WHERE salon_id=$1 AND create_outbox_id=$2 AND yclients_record_id IS NULL AND status IN ('queued','failed')`, [salonId, outboxId]);
  }
  await finOps.safely('journal-dismiss', () => finOps.syncCancelledOutbox(salonId));
  return { outboxId: Number(updated.id), status: updated.status };
}

module.exports = { parseSession, buildSteps, validate, enqueue, retry, dismiss, MAX_PAYMENTS, MAX_REMOVES };
