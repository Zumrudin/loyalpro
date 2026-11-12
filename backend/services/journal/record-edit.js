'use strict';
const m = require('./model');
const pricing = require('./pricing');
function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) m.fail('Некорректные изменения записи.');
  const out = {};
  // `version` (whole-record) is still accepted from older clients but no
  // longer decides anything: it made every edit after the user's own status
  // or payment package fail as «stale» (10.11.2026, outbox 16).
  if (input.version !== undefined && !/^[a-f0-9]{64}$/.test(input.version)) m.fail('Некорректная версия записи.');
  if (input.servicesVersion !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(input.servicesVersion)) m.fail('Некорректная версия записи.');
    out.servicesVersion = input.servicesVersion;
  }
  if (input.attendance !== undefined) {
    if (!Number.isInteger(input.attendance) || ![-1, 0, 1, 2].includes(input.attendance)) m.fail('Неизвестный статус записи.');
    out.attendance = input.attendance;
  }
  if (input.lines !== undefined) {
    try { out.lines = pricing.quote(input.lines, input.lines.map(l => Number(l.serviceId))).lines; }
    catch (_) { m.fail('Проверьте услуги, количество, цену и скидку.'); }
  }
  if (out.attendance === undefined && !out.lines) m.fail('Нет изменений для сохранения.');
  return out;
}
async function patch(salon, record, input, src, availability, paid = false) {
  const edit = parse(input);
  if (edit.lines && edit.servicesVersion && edit.servicesVersion !== m.servicesRevision(record)) m.fail('Услуги визита изменились. Откройте карточку заново.', 409, 'edit_conflict');
  if (record.deleted) m.fail('Запись удалена.', 409);
  if (paid || record.paid_full || Number(record.paid_amount) > 0) m.fail('У визита есть проведённые оплаты. Измените его в YClients.', 409);
  const out = {};
  if (edit.attendance !== undefined) out.attendance = edit.attendance;
  if (edit.lines) {
    const existing = record.services || [];
    const all = await src.services();
    out.services = edit.lines.map(l => {
      const old = existing.find(s => Number(s.id) === l.serviceId);
      const service = all.find(s => Number(s.id) === l.serviceId);
      if (!old && (!service || service.deleted || service.archive || service.is_deleted || !service.staff?.some(s => Number(s.id || s) === Number(record.staff_id)))) m.fail('Услуга недоступна у сотрудника.', 409);
      // cost_to_pay/manual_cost describe the OLD price; carried over they would
      // contradict the new cost (YClients recalculates them from cost).
      const { cost_to_pay, manual_cost, ...kept } = old || {};
      return { ...kept, id: l.serviceId, title: String(old?.title || service?.title || ''), amount: l.quantity,
        cost_per_unit: l.unitPrice, first_cost: l.gross, discount: l.discount, cost: l.total };
    });
    // The visit keeps its seance_length, so only a different SET of services
    // (equipment) can collide; quantity/price changes cannot. A visit that has
    // already started occupies its time regardless — free-time search excludes
    // the past and would refuse every after-visit correction at the checkout.
    const ids = list => [...new Set(list.map(s => Number(s.id)))].sort((a, b) => a - b).join(',');
    const compositionChanged = ids(out.services) !== ids(existing);
    const at = m.moscowParts(record.datetime);
    if (compositionChanged && !(at && at.ms <= Date.now())) {
      if (!at) m.fail('Некорректное время записи.', 409);
      const available = await availability(salon, { staffId: Number(record.staff_id), date: at.date, time: at.time }, { ...record, services: out.services }, src);
      if (!available.slots.includes(at.time)) m.fail('Новый состав услуг недоступен в этом времени. Перенесите запись.', 409, 'slot_taken');
    }
  }
  return out;
}
// Removal receipts reverse only matching method + transaction IDs. Unknown
// receipts stay blocked rather than being interpreted as an unpaid visit.
function hasActivePayments(rows) {
  const removed = new Set(rows.filter(r => r.action === 'remove').flatMap(r =>
    [...(r.external_ids || []), ...(r.target_transaction_id != null ? [r.target_transaction_id] : [])]
      .map(id => r.method + ':' + String(id))));
  return rows.some(r => r.action !== 'remove' &&
    (!Array.isArray(r.external_ids) || !r.external_ids.length ||
      r.external_ids.some(id => !removed.has(r.method + ':' + String(id)))));
}
module.exports = { parse, patch, hasActivePayments };
