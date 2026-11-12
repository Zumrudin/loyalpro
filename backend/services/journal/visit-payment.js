'use strict';

// Marking arrival re-sends the record (PUT /record replaces it). Only the
// lossless subset below is marked automatically; the snapshot proves that
// nothing but attendance changed. Payments themselves never re-send the visit.
const { fingerprint } = require('./model');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))
  ? Number(value) : NaN;
const positiveId = value => Number.isSafeInteger(numeric(value)) && numeric(value) > 0;
const comment = value => value === 0 || value == null ? '' : value;
const flag = value => ![undefined, null, false, 0, '0', 'false', ''].includes(value);
const clientId = record => numeric(record.client?.id ?? record.client_id ?? 0);
const staffId = record => numeric(record.staff_id ?? record.staff?.id);
function datetime(value) {
  if (typeof value !== 'string' || !value) return null;
  let iso = value.replace(' ', 'T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  if (!/(Z|[+-]\d\d:\d\d)$/.test(iso)) iso += '+03:00';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!validObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function serviceSnapshot(service, recordId) {
  if (!validObject(service)) return null;
  return {
    id: numeric(service.id), record_id: numeric(service.record_id || recordId),
    title: service.title, amount: numeric(service.amount),
    cost: numeric(service.cost), cost_per_unit: numeric(service.cost_per_unit),
    first_cost: numeric(service.first_cost), discount: numeric(service.discount),
    manual_cost: service.manual_cost == null ? numeric(service.cost) : numeric(service.manual_cost),
  };
}

function snapshot(record) {
  const fields = {
    id: numeric(record.id), company_id: numeric(record.company_id), visit_id: numeric(record.visit_id),
    datetime: datetime(record.datetime), staff_id: staffId(record), client_id: clientId(record),
    seance_length: numeric(record.seance_length), attendance: numeric(record.attendance),
    comment: comment(record.comment), deleted: flag(record.deleted),
    services: Array.isArray(record.services)
      ? record.services.map(service => serviceSnapshot(service, record.id)).sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))
      : null,
    goods_transactions: record.goods_transactions,
    documents: Array.isArray(record.documents) ? record.documents.map(document => !validObject(document) ? null : ({
      id: numeric(document.id), type_id: numeric(document.type_id),
      company_id: numeric(document.company_id || record.company_id),
      record_id: numeric(document.record_id || record.id),
      visit_id: numeric(document.visit_id || record.visit_id),
    })).sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0)) : null,
    resource_instance_ids: Array.isArray(record.resource_instance_ids)
      ? record.resource_instance_ids.map(numeric).sort((a, b) => a - b) : [],
  };
  for (const key of ['technical_break_duration', 'technical_break', 'technicalbreak', 'tech_break', 'activity_id', 'group_id', 'group_record_id']) {
    fields[key] = numeric(record[key] ?? 0);
  }
  for (const key of ['custom_fields', 'labels', 'record_labels', 'resources', 'resource_instances']) {
    fields[key] = record[key] ?? null;
  }
  return fingerprint(canonical(fields));
}

function unavailableReason(record) {
  if (!validObject(record) || !positiveId(record.id) || !positiveId(record.company_id) || !positiveId(record.visit_id)
    || !positiveId(staffId(record)) || !datetime(record.datetime)
    || !Number.isFinite(numeric(record.seance_length)) || numeric(record.seance_length) <= 0
    || ![0, 1, 2].includes(numeric(record.attendance)) || flag(record.deleted)
    || !own(record, 'comment') || typeof comment(record.comment) !== 'string'
    || !Number.isSafeInteger(clientId(record)) || clientId(record) < 0
    || (record.client_id != null && numeric(record.client_id) !== clientId(record))
    || (record.staff?.id != null && numeric(record.staff.id) !== staffId(record))) {
    return 'Не удалось получить полный состав визита. Обновите форму оплаты.';
  }
  if (['activity_id', 'group_id', 'group_record_id'].some(key => record[key] != null && numeric(record[key]) !== 0)
    || flag(record.is_group) || flag(record.is_group_record) || record.group) {
    return 'Оплата группового визита доступна в YClients.';
  }
  if (!Array.isArray(record.goods_transactions)) return 'Не удалось проверить товары и расходники визита. Обновите форму оплаты.';
  if (record.goods_transactions.length || (record.consumables != null && (!Array.isArray(record.consumables) || record.consumables.length))) {
    return 'Визит с товарами или расходниками оплатите в YClients.';
  }
  if (!Array.isArray(record.services) || !record.services.length) return 'В визите нет подтверждённого состава услуг. Проверьте его в YClients.';
  const ids = new Set();
  for (const service of record.services) {
    if (!validObject(service) || !positiveId(service.id) || ids.has(numeric(service.id))
      || typeof service.title !== 'string'
      || (service.record_id && numeric(service.record_id) !== numeric(record.id))) {
      return 'Состав услуг визита неоднозначен. Оплатите его в YClients.';
    }
    ids.add(numeric(service.id));
    if (numeric(service.amount) !== 1) return 'Услуги с количеством больше одной оплатите в YClients.';
    if (['cost', 'cost_per_unit', 'first_cost', 'discount'].some(key => !Number.isFinite(numeric(service[key])) || numeric(service[key]) < 0)
      || numeric(service.discount) > 100
      || (service.manual_cost != null && numeric(service.manual_cost) !== numeric(service.cost))) {
      return 'Не удалось безопасно сохранить стоимость услуг. Оплатите визит в YClients.';
    }
    if (service.consumables != null && (!Array.isArray(service.consumables) || service.consumables.length)) return 'Визит с расходниками оплатите в YClients.';
  }
  return null;
}

module.exports = { snapshot, unavailableReason };
