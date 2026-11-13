'use strict';
const m = require('./model');
const pricing = require('./pricing');
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_LABELS = 20;
// One card edit (12.11.2026: comment, duration, client, colour, labels,
// technical break and «не уведомлять» next to status and services).
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
  if (input.comment !== undefined) {
    if (typeof input.comment !== 'string') m.fail('Некорректный комментарий.');
    const comment = input.comment.trim();
    if (comment.length > 1000) m.fail('Комментарий слишком длинный.');
    out.comment = comment;
  }
  if (input.seanceLength !== undefined) {
    const n = input.seanceLength;
    if (!Number.isInteger(n) || n < 5 || n > 720 || n % 5 !== 0) m.fail('Длительность — от 5 до 720 минут, кратно 5.');
    out.seanceLength = n;
  }
  if (input.client !== undefined) {
    const c = input.client;
    if (!c || typeof c !== 'object' || Array.isArray(c)) m.fail('Некорректный клиент.');
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name || name.length > 120) m.fail('Укажите имя клиента (до 120 символов).');
    let phone = (typeof c.phone === 'string' || typeof c.phone === 'number' ? String(c.phone) : '').replace(/[\s()+-]/g, '');
    if (!/^\d{11,15}$/.test(phone)) m.fail('Укажите телефон с кодом страны.');
    if (phone.length === 11 && phone[0] === '8') phone = '7' + phone.slice(1);
    out.client = { name, phone };
  }
  if (input.customColor !== undefined) {
    if (input.customColor === null || input.customColor === '') out.customColor = null;
    else if (typeof input.customColor === 'string' && HEX.test(input.customColor)) out.customColor = input.customColor.toLowerCase();
    else m.fail('Некорректный цвет записи.');
  }
  if (input.labelIds !== undefined) {
    if (!Array.isArray(input.labelIds) || input.labelIds.length > MAX_LABELS) m.fail('Некорректный список меток.');
    // Numbers or digit strings only (positiveId would take `true` as 1).
    out.labelIds = [...new Set(input.labelIds.map(v => {
      if (typeof v !== 'number' && !(typeof v === 'string' && /^\d+$/.test(v))) m.fail('Некорректная метка.');
      return m.positiveId(v);
    }))];
  }
  if (input.technicalBreak !== undefined) {
    const n = input.technicalBreak;
    if (!Number.isInteger(n) || n < 0 || n > 3600 || n % 300 !== 0) m.fail('Технический перерыв — от 0 до 60 минут, кратно 5.');
    out.technicalBreak = n;
  }
  if (input.notifyClient !== undefined) {
    if (typeof input.notifyClient !== 'boolean') m.fail('Некорректный флаг уведомления.');
    out.notifyClient = input.notifyClient;
  }
  if (!Object.keys(out).some(k => k !== 'servicesVersion')) m.fail('Нет изменений для сохранения.');
  return out;
}
async function patch(salon, record, input, src, availability, paid = false) {
  const edit = parse(input);
  if (edit.lines && edit.servicesVersion && edit.servicesVersion !== m.servicesRevision(record)) m.fail('Услуги визита изменились. Откройте карточку заново.', 409, 'edit_conflict');
  if (record.deleted) m.fail('Запись удалена.', 409);
  if (paid || record.paid_full || Number(record.paid_amount) > 0) m.fail('У визита есть оплаты. Сначала удалите оплаты визита.', 409);
  // Spec §4.1: duration and client of a visit that came stay as they are.
  if ((edit.seanceLength !== undefined || edit.client) && (Number(record.attendance) === 1 || edit.attendance === 1)) {
    m.fail('Длительность и клиента пришедшего визита изменить нельзя.', 409);
  }
  const out = {};
  if (edit.attendance !== undefined) out.attendance = edit.attendance;
  if (edit.comment !== undefined) out.comment = edit.comment;
  // YClients re-links the visit to the card found by this phone.
  if (edit.client) out.client = { phone: edit.client.phone, name: edit.client.name };
  // YClients stores the colour without «#» (ffeb3b); inside LoyalPro it is #rrggbb.
  if (edit.customColor !== undefined) out.custom_color = edit.customColor ? edit.customColor.slice(1) : '';
  if (edit.labelIds !== undefined) {
    if (edit.labelIds.length) {
      const known = typeof src.labels === 'function' ? await src.labels() : null;
      if (!Array.isArray(known) || !known.length) m.fail('Справочник меток ещё не загружен. Повторите позже.', 503, 'cache_cold');
      const ids = new Set(m.normalizeLabels(known).map(l => l.id));
      if (edit.labelIds.some(id => !ids.has(id))) m.fail('Метка не найдена. Обновите журнал.', 409);
    }
    out.record_labels = edit.labelIds;
  }
  if (edit.technicalBreak !== undefined) out.technical_break_duration = edit.technicalBreak;
  if (edit.seanceLength !== undefined) out.seance_length = edit.seanceLength * 60;
  let compositionChanged = false;
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
    // Quantity/price changes cannot collide; only a different SET of services
    // (equipment) can.
    const ids = list => [...new Set(list.map(s => Number(s.id)))].sort((a, b) => a - b).join(',');
    compositionChanged = ids(out.services) !== ids(existing);
  }
  const lengthChanged = (edit.seanceLength !== undefined && edit.seanceLength * 60 !== Number(record.seance_length))
    || (edit.technicalBreak !== undefined && edit.technicalBreak !== m.nonNegSeconds(record.technical_break_duration));
  // A visit that has already started occupies its time regardless — free-time
  // search excludes the past and would refuse every after-visit correction.
  const at = m.moscowParts(record.datetime);
  if ((compositionChanged || lengthChanged) && !(at && at.ms <= Date.now())) {
    if (!at) m.fail('Некорректное время записи.', 409);
    const draft = { staffId: Number(record.staff_id), date: at.date, time: at.time,
      ...(edit.seanceLength !== undefined ? { durationOverride: edit.seanceLength } : {}),
      ...(edit.technicalBreak !== undefined ? { technicalBreak: edit.technicalBreak } : {}) };
    const available = await availability(salon, draft, { ...record, ...(out.services ? { services: out.services } : {}) }, src);
    if (!available.slots.includes(at.time)) {
      m.fail(compositionChanged ? 'Новый состав услуг недоступен в этом времени. Перенесите запись.' : 'Новая длительность не помещается: время занято.', 409, 'slot_taken');
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
