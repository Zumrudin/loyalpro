'use strict';
const { db, pool } = require('../../db');
const yc = require('./yclients');
const m = require('./model');
const localCatalog = require('../service-catalog');
const sources = require('./sources');
const overlay = require('./overlay');
const mirror = require('./mirror');
async function salonFor(salonId) {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id) m.fail('YClients не подключён для салона.', 409);
  return salon;
}
const shiftDate = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
async function catalog(salon, src = sources.live(salon)) {
  const [staff, services] = await Promise.all([src.staff(), src.services()]);
  return { staff: staff.filter(s => !s.fired && !m.isAdministrator(s)), services };
}
async function day(salonId, date, src) {
  const salon = await salonFor(salonId);
  if (!src) src = await sources.forSalon(salon);
  const [staffSource, local, records, labels] = await Promise.all([src.staff(), localCatalog.forJournal(salonId),
    src.records(shiftDate(date, -1), shiftDate(date, 1)),
    typeof src.labels === 'function' ? Promise.resolve().then(() => src.labels()).catch(() => []) : []]);
  const data = { staff: staffSource.filter(s => !s.fired && !m.isAdministrator(s)) };
  // Bounded concurrency avoids a burst against the shared YClients quota;
  // cached schedules are local reads (a cache miss is a single live call).
  const staff = new Array(data.staff.length);
  const width = src.kind === 'local' ? data.staff.length : 3;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, data.staff.length) }, async () => {
    while (next < data.staff.length) {
      const index = next++, s = data.staff[index];
      const schedule = await src.schedule(s.id, date);
      staff[index] = { id: Number(s.id), name: String(s.name || 'Сотрудник'), ...m.staffSchedule(schedule, date) };
    }
  }));
  return {
    date, fetchedAt: new Date().toISOString(),
    staff,
    services: local.services, categories: local.categories, serviceSource: 'internal',
    labels: m.normalizeLabels(labels),
    records: m.recordsForDay(records, date),
    freshness: await mirror.freshness(salonId),
    unsent: await require('./dispatch').summary(salonId).catch(() => null),
    source: src.kind,
  };
}
async function mirroredRecord(salon, id) {
  const row = await db.oneOrNone('SELECT raw_payload FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, id]);
  return row?.raw_payload ? row.raw_payload : yc.getRecord(salon, id);
}
async function detail(salonId, id) {
  if (id < 0) {
    // Not yet in YClients: a queued create package of this salon.
    const row = await db.oneOrNone('SELECT * FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, -id]);
    // Already created in YClients: the card opened under the queue id must
    // become the REAL record. The synthetic draft carries internal service
    // ids and its own edit version, so saving an edit from it always failed
    // with «Запись изменилась» (10.11.2026, record 2132846785).
    if (row && row.overlay?.kind === 'create' && Number(row.yclients_record_id) > 0) {
      return detail(salonId, Number(row.yclients_record_id));
    }
    if (!row || row.overlay?.kind !== 'create' || row.status === 'cancelled') m.fail('Запись не найдена.', 404);
    // Changes saved for the unsent new record (status, services, time, payments).
    const children = await db.any("SELECT * FROM journal_outbox WHERE salon_id=$1 AND create_outbox_id=$2 AND status IN ('queued','running','failed') ORDER BY id", [salonId, -id]);
    const r = overlay.applyOverlay([], [row, ...children])[0];
    if (!r) m.fail('Запись не найдена.', 404);
    const queuedPay = [row, ...children].some(x => ['queued', 'running'].includes(x.status)
      && (x.steps || []).some(s => s.kind === 'pay' && s.state !== 'done'));
    const out = m.normalizeRecord(r, { withPhone: true });
    return { ...out, paid: out.paid || queuedPay, paymentSync: queuedPay && [row, ...children].some(x => x.released_at != null && (x.steps || []).some(s => s.kind === 'pay' && s.state !== 'done')) };
  }
  const salon = await salonFor(salonId);
  const src = await sources.forSalon(salon);
  let r;
  if (src.kind === 'local') {
    const base = await mirroredRecord(salon, id);
    const [open, ledger] = await Promise.all([
      sources.openOutbox(salonId),
      db.any("SELECT action, method, external_ids, target_transaction_id FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND state IN ('confirmed','pending')", [salonId, id]),
    ]);
    const rows = open.filter(x => x.yclients_record_id != null && Number(x.yclients_record_id) === Number(id));
    r = overlay.applyOverlay([base], rows)[0];
    // The mirror learns about a payment only from the YClients webhook, seconds
    // after our own package finished — meanwhile the card showed «не оплачено»
    // and unlocked status/service edits of a paid visit. Our ledger (confirmed
    // or unresolved) and queued pay steps are known earlier and decide too.
    const payRows = rows.filter(x => ['queued', 'running'].includes(x.status)
      && (x.steps || []).some(s => s.kind === 'pay' && s.state !== 'done'));
    const queuedPay = payRows.length > 0;
    const ledgerPaid = require('./record-edit').hasActivePayments(ledger || []);
    const out = m.normalizeRecord(r, { withPhone: true });
    // paymentSync = the payment is on its way (released); an unreleased one waits for dispatch.
    return { ...out, paid: out.paid || ledgerPaid || queuedPay, paymentSync: payRows.some(x => x.released_at != null) };
  } else {
    r = await yc.getRecord(salon, id);
  }
  return m.normalizeRecord(r, { withPhone: true });
}
// `src` defaults to live YClients: the write path (prepare) must verify against
// the source of truth. Only slots() (a UI read) passes the local source.
async function availability(salon, draft, record, src = sources.live(salon)) {
  const { staff, services } = await catalog(salon, src);
  if (!staff.some(s => Number(s.id) === draft.staffId)) m.fail('Сотрудник недоступен.', 409);
  const local = !record && draft.serviceSource === 'internal' ? await localCatalog.resolve(salon, draft.serviceIds) : null;
  if (local && local.some(s => !localCatalog.journalService(s).staffIds.includes(draft.staffId))) m.fail('Услуга не назначена сотруднику во внутреннем каталоге.',409);
  const ids = record ? (record.services || []).map(s => Number(s.id)) : local ? local.map(s => Number(s.yclients_id)) : draft.serviceIds;
  if (!ids?.length) m.fail('В записи нет услуг.', 409);
  const selected = ids.map(id => services.find(s => Number(s.id) === id));
  if (selected.some(s => !s || s.deleted || s.is_deleted || s.archive)) m.fail('Услуга недоступна.', 409);
  // Staff journal uses the full management catalog (including services hidden
  // from online booking). Unknown assignments fail closed.
  if (selected.some(s => !Array.isArray(s.staff) || !s.staff.some(x => Number(x.id || x) === draft.staffId))) {
    m.fail('Не подтверждена доступность услуг у сотрудника. Проверьте настройки YClients.', 409);
  }
  const computed = record ? Number(record.seance_length) / 60 : local ? local.reduce((sum,s) => { const info=localCatalog.journalService(s);return sum+(info.staffDetails.find(x=>x.id===draft.staffId)?.duration || info.duration)*(draft.lines?.find(l=>l.serviceId===Number(s.id))?.quantity || draft.quantities?.[s.id] || 1); },0) : selected.reduce((total, s) => {
    const specific = (s.staff || []).find(x => Number(x.id) === draft.staffId);
    const seconds = Number(specific?.seance_length || s.duration);
    if (!(seconds > 0)) m.fail('Для услуги не задана длительность.', 409);
    return total + seconds / 60;
  }, 0);
  // An explicit length from the card / resize handle (12.11.2026) wins.
  const override = Number(draft.durationOverride);
  const duration = Number.isInteger(override) && override > 0 ? override : computed;
  // Technical break: the edited value, else the record's own, else none.
  const breakMinutes = m.nonNegSeconds(draft.technicalBreak !== undefined ? draft.technicalBreak
    : record ? record.technical_break_duration : 0) / 60;
  if (!(duration > 0 && duration <= 1440)) m.fail('Некорректная длительность записи.', 409);
  const resourceIds = [...new Set(selected.flatMap(s => (s.resources || []).map(String)))];
  const [schedule, records, resources] = await Promise.all([
    src.schedule(draft.staffId, draft.date),
    src.records(shiftDate(draft.date, -1), shiftDate(draft.date, 1)),
    resourceIds.length ? src.resources() : Promise.resolve([]),
  ]);
  for (const r of records) r._journalResourceIds = (r.services || []).flatMap(s => services.find(x => Number(x.id) === Number(s.id))?.resources || []);
  return { duration, ...(local ? {servicePayload:local.map(s => {const info=localCatalog.journalService(s);const price=info.staffDetails.find(x=>x.id===draft.staffId)?.priceMin ?? info.priceMin;const line=draft.lines?.find(l=>l.serviceId===Number(s.id));return line?{id:Number(s.yclients_id),amount:line.quantity,cost_per_unit:line.unitPrice,first_cost:line.gross,discount:line.discount,cost:line.total}:{id:Number(s.yclients_id),...(price==null?{}:{cost:price})};})}:{}), slots: m.slotsFor({ ...draft, duration, breakMinutes, schedule, records, resourceIds, resources, excludeId: record?.id }) };
}
async function slots(salonId, draft) {
  const salon = await salonFor(salonId);
  const src = await sources.forSalon(salon);
  const record = !draft.recordId ? null
    : src.kind === 'local' ? await mirroredRecord(salon, draft.recordId) : await yc.getRecord(salon, draft.recordId);
  return availability(salon, draft, record, src);
}
function editable(r) {
  if (r.deleted || Number(r.attendance) === -1) m.fail('Запись уже отменена или удалена.', 409);
  if (Number(r.attendance) === 1 || r.paid_full || Number(r.paid_amount) > 0) m.fail('Пришедшие и оплаченные визиты изменяйте в YClients.', 409);
}
async function prepare(salon, draft) {
  let record;
  if (draft.action !== 'create') {
    record = await yc.getRecord(salon, draft.recordId);
    if (m.revision(record) !== draft.version) m.fail('Запись изменилась. Откройте карточку заново.', 409, 'stale');
    if (draft.action !== 'edit') editable(record);
  }
  if (draft.action === 'edit') {
    const patch = await require('./record-edit').patch(salon, record, draft.edit, sources.live(salon), availability);
    return { staff_id: record.staff_id, services: record.services, client: record.client,
      datetime: record.datetime, seance_length: record.seance_length, comment: record.comment || '',
      attendance: record.attendance, ...patch, save_if_busy: false, send_sms: false };
  }
  if (draft.action === 'create' || draft.action === 'move') {
    const available = await availability(salon, draft, record, sources.live(salon));
    if (!available.slots.includes(draft.time)) m.fail('Время уже занято или вне графика. Выберите другое.', 409, 'slot_taken');
    return {
      ...(record ? {
        client: record.client, services: record.services, comment: record.comment || '', attendance: record.attendance,
      } : {
        client: { name: draft.clientName, phone: draft.clientPhone },
        services: available.servicePayload || draft.serviceIds.map(id => ({ id })), comment: draft.comment,
      }),
      staff_id: draft.staffId, datetime: `${draft.date}T${draft.time}:00+03:00`,
      seance_length: available.duration * 60, save_if_busy: false, send_sms: false,
    };
  }
  const body = {
    staff_id: record.staff_id, services: record.services, client: record.client,
    datetime: record.datetime, seance_length: record.seance_length,
    comment: record.comment || '', attendance: draft.action === 'confirm' ? 2 : -1,
    save_if_busy: false, send_sms: false,
  };
  if (draft.action === 'cancel') {
    body.seance_length = 300;
    const all = await yc.list(salon, `/company/${salon.yclients_company_id}/services/`);
    const suppress = all.find(s => String(s.title).toLowerCase().includes('запрет на отправку'));
    if (suppress && !body.services.some(s => Number(s.id) === Number(suppress.id))) body.services = [...body.services, { id: suppress.id }];
  }
  return body;
}
// Session lock serializes this journal's writes across processes. The pending
// marker is AUTOCOMMITTED before the external effect, surviving a process crash.
// Other writers (Mila / YClients UI) are still arbitrated by save_if_busy=false.
async function mutate(salonId, userId, draft) {
  const conn = await pool.connect();
  let locked = false, broken = false;
  const requestHash = m.fingerprint(draft);
  try {
    locked = !!(await conn.query('SELECT pg_try_advisory_lock(17291, $1) AS locked', [salonId])).rows[0]?.locked;
    if (!locked) m.fail('Сохраняется другая запись. Повторите через несколько секунд.', 409, 'busy');
    const prior = (await conn.query('SELECT request_hash, state, result FROM journal_operations WHERE salon_id=$1 AND operation_id=$2', [salonId, draft.operationId])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) m.fail('Ключ операции уже использован для других данных.', 409);
      if (prior.state === 'reviewed') m.fail('Операция сверена вручную. Для нового действия откройте новую форму.', 409, 'reviewed');
      if (prior.state === 'rejected') m.fail('YClients отклонил операцию. Обновите данные и повторите.', 409, 'rejected');
      if (prior.state === 'done') return { ...prior.result, duplicate: true };
      m.fail('Результат операции ещё не подтверждён. Проверьте запись в YClients перед новой попыткой.', 409, 'uncertain');
    }
    // Block a different key while an uncertain operation is unresolved. This
    // also protects a fresh page/tab after an upstream timeout or server crash.
    const uncertain = (await conn.query("SELECT operation_id FROM journal_operations WHERE salon_id=$1 AND state='pending' LIMIT 1", [salonId])).rows[0];
    if (uncertain) m.fail('Есть операция с неподтверждённым результатом. Требуется сверка с YClients.', 409, 'blocked_pending');
    const salon = await salonFor(salonId);
    // Uncertain funds belong to a visit, not to every booking in the salon.
    // Creating an unrelated visit has no financial side effect.
    if (draft.recordId) {
      const paymentPending = (await conn.query("SELECT operation_id FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='pending' LIMIT 1", [salonId,draft.recordId,salon.yclients_company_id])).rows[0];
      if (paymentPending) m.fail('У этого визита есть неподтверждённая оплата. Сначала выполните сверку.',409,'payment_pending');
    }
    if (draft.recordId) {
      const ledger = (await conn.query("SELECT action, method, external_ids, target_transaction_id FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='confirmed'", [salonId,draft.recordId,salon.yclients_company_id])).rows;
      if (require('./record-edit').hasActivePayments(ledger)) m.fail('У визита есть проведённые оплаты. Измените его в YClients.',409);
    }
    const body = await prepare(salon, draft);
    if (draft.recordId && m.revision(await yc.getRecord(salon, draft.recordId)) !== draft.version) {
      m.fail('Запись изменилась. Откройте карточку заново.', 409, 'stale');
    }
    await conn.query(`INSERT INTO journal_operations (salon_id, operation_id, user_id, action, record_id, request_hash, state)
      VALUES ($1,$2,$3,$4,$5,$6,'pending')`, [salonId, draft.operationId, userId, draft.action, draft.recordId || null, requestHash]);
    let result;
    try {
      result = await yc.write(salon, draft.recordId, body);
      await conn.query("UPDATE journal_operations SET state='done', result=$3, record_id=$4, updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2",
        [salonId, draft.operationId, JSON.stringify(result), result.recordId]);
    } catch (error) {
      // A definite HTTP validation/auth/rate rejection has no ambiguous write.
      if ([400, 401, 403, 404, 422, 429].includes(error.response?.status)) {
        await conn.query("UPDATE journal_operations SET state='rejected', updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2", [salonId, draft.operationId]);
        m.fail('YClients отклонил операцию. Проверьте доступ, время и данные записи.', 409, 'rejected');
      }
      m.fail('Не удалось подтвердить результат. Проверьте запись в YClients; повторная отправка заблокирована.', 409, 'uncertain');
    }
    return result;
  } catch (e) {
    if (e.code === '42P01') m.fail('Журнал ещё не подготовлен: требуется миграция базы.', 503);
    throw e;
  } finally {
    if (locked) {
      try { await conn.query('SELECT pg_advisory_unlock(17291, $1)', [salonId]); }
      catch (_) { broken = true; }
    }
    conn.release(broken);
  }
}
async function pending(salonId) {
  return db.any("SELECT operation_id, action, record_id, created_at FROM journal_operations WHERE salon_id=$1 AND state='pending' ORDER BY created_at", [salonId]);
}
// Human reconciliation is explicit and owner-only in the router. No booking is
// retried or deleted. The original key remains permanently non-replayable.
async function review(salonId, userId, operationId) {
  const conn = await pool.connect();
  let locked = false, broken = false;
  try {
    locked = !!(await conn.query('SELECT pg_try_advisory_lock(17291, $1) AS locked', [salonId])).rows[0]?.locked;
    if (!locked) m.fail('Операция ещё выполняется. Дождитесь результата.', 409);
    const result = await conn.query("UPDATE journal_operations SET state='reviewed', reviewed_by=$3, updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2 AND state='pending' RETURNING operation_id", [salonId, operationId, userId]);
    if (!result.rows.length) m.fail('Неподтверждённая операция не найдена.', 404);
    return { reviewed: true };
  } finally {
    if (locked) try { await conn.query('SELECT pg_advisory_unlock(17291, $1)', [salonId]); } catch (_) { broken = true; }
    conn.release(broken);
  }
}
module.exports = { day, detail, slots, mutate, prepare, availability, pending, review };
