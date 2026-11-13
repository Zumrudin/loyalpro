'use strict';
const crypto = require('crypto');
const { db } = require('../../db');
const store = require('./store');
const ledger = require('./ledger');
const m = require('./model');
const { transaction } = require('./documents');
const finOps = require('../finance-ops');
const { ycSearchClientIdByPhone } = require('../yclients');
const { normalizePhoneKey } = require('../agent-gate');
const validId = v => ['number', 'string'].includes(typeof v) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
const validation = errors => m.fail(errors[0], 400, 'validation', { errors });

async function resolveClient(salonId, body, q = (sql, args) => db.query(sql, args)) {
  let rows;
  if (body.clientId != null) {
    if (!validId(body.clientId)) validation(['Некорректный id клиента.']);
    rows = (await q('SELECT id, yclients_client_id FROM clients WHERE salon_id=$1 AND id=$2', [salonId, Number(body.clientId)])).rows;
  } else {
    const phone = normalizePhoneKey(body.phone);
    if (!/^7\d{10}$/.test(phone)) validation(['Некорректный телефон.']);
    // Сначала точные формы номера (индекс idx_clients_salon_phone), суффикс — только запасной путь (как client-summary.js).
    const p10 = phone.slice(-10);
    rows = (await q('SELECT id, yclients_client_id FROM clients WHERE salon_id=$1 AND phone = ANY($2::text[]) LIMIT 2',
      [salonId, [`+7${p10}`, `7${p10}`, `8${p10}`, p10]])).rows;
    if (!rows.length) rows = (await q(`SELECT id, yclients_client_id FROM clients WHERE salon_id=$1
      AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 LIMIT 2`, [salonId, p10])).rows;
    if (rows.length > 1) m.fail('Найдено несколько клиентов. Выберите клиента.', 409, 'ambiguous_client');
    if (!rows.length) {
      const salon = (await q('SELECT * FROM salons WHERE id=$1', [salonId])).rows[0];
      if (!salon) m.fail('Салон не найден.', 404, 'not_found');
      let ycClientId;
      try {
        // Единственный разрешённый внешний запрос: POST /clients/search, только чтение.
        ycClientId = await ycSearchClientIdByPhone(salon, phone);
      } catch (_) {
        m.fail('Поиск клиента временно недоступен.', 502, 'client_search_unavailable');
      }
      if (!validId(ycClientId)) m.fail('Клиент не найден.', 404, 'client_not_found');
      // Конкурентный импорт клиента не должен затирать его имя, телефон или бонусы.
      rows = (await q(`INSERT INTO clients (salon_id, yclients_client_id, phone, name)
        VALUES ($1, $2, $3, '')
        ON CONFLICT (salon_id, yclients_client_id) DO UPDATE SET id=clients.id
        RETURNING id, yclients_client_id`, [salonId, Number(ycClientId), phone])).rows;
    }
  }
  if (!rows[0]) m.fail('Клиент не найден.', 404, 'client_not_found');
  return rows[0];
}

async function create(salonId, userId, body) {
  const b = body || {};
  const [storages, goods] = await Promise.all([store.listStorages(salonId), store.listGoods(salonId)]);
  const result = m.validateDocument({ ...b, kind: 'sale', docDate: b.docDate ?? new Date(),
    lines: Array.isArray(b.lines) ? b.lines.map(l => l || {}) : b.lines }, {
    storages: storages.filter(s => s.is_active).map(s => ({ id: s.id, forSale: s.for_sale, forService: s.for_service })),
    goods: new Map(goods.map(g => [Number(g.id), { stockActive: g.stock_active, unitEquals: g.unit_equals }])) });
  for (const key of ['storageId', 'clientId', 'masterStaffYcId', 'recordId']) {
    if ((key === 'storageId' || b[key] != null) && !validId(b[key])) result.errors.push(`Некорректный ${key}.`);
  }
  if (b.gift != null && typeof b.gift !== 'boolean') result.errors.push('gift: true или false.');
  if (b.payments != null && !Array.isArray(b.payments)) result.errors.push('Ожидается список оплат.');
  result.errors.push(...m.validateSalePayments(b.payments, result.normalized.totalCost, { gift: b.gift }).errors);
  if (result.errors.length) validation(result.errors);
  const { lines, ...normalized } = result.normalized;
  // Клиент резолвится ДО транзакции: поиск в YClients (до 30 с) не должен держать соединение пула открытым.
  const client = await resolveClient(salonId, b);
  return transaction(salonId, async q => {
    if (b.recordId != null) {
      const r = (await q('SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, Number(b.recordId)])).rows[0];
      if (!r) validation(['Запись не найдена.']);
    }
    const input = { ...normalized, origin: 'loyalpro', status: 'posted', createdBy: userId,
      clientId: client.id, ycClientId: client.yclients_client_id ?? null,
      recordId: b.recordId == null ? null : Number(b.recordId), masterStaffYcId: b.masterStaffYcId == null ? null : Number(b.masterStaffYcId) };
    const doc = await store.insertDocument(q, salonId, input);
    await ledger.postDocument(q, salonId, { ...input, ...doc }, lines);
    const payments = [];
    for (const p of b.payments || []) payments.push(await finOps.recordStockSalePayment(q, {
      salonId, stockDocumentId: doc.id, opId: crypto.randomUUID(), method: p.method, amount: m.kop(p.amount) / 100,
      clientId: client.id, ycClientId: client.yclients_client_id ?? null, occurredAt: normalized.docDate, userId }));
    return { ...doc, lines, payments, warnings: result.warnings };
  });
}
module.exports = { create, resolveClient };
