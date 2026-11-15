'use strict';
const crypto = require('crypto');
const { db } = require('../../db');
const store = require('./store');
const ledger = require('./ledger');
const m = require('./model');
const { transaction } = require('./documents');
const finOps = require('../finance-ops');
const appointmentGoods = require('./appointment-goods');
const { ycSearchClientIdByPhone } = require('../yclients');
const { normalizePhoneKey } = require('../agent-gate');
const validId = v => ['number', 'string'].includes(typeof v) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = v => typeof v === 'string' && UUID_RE.test(v);
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

function createRequestHash({ userId, body, normalized, lines, client }) {
  const canonical = {
    userId: Number(userId), clientId: Number(client.id), ycClientId: client.yclients_client_id == null ? null : Number(client.yclients_client_id),
    storageId: normalized.storageId, recordId: body.recordId == null ? null : Number(body.recordId),
    masterStaffYcId: body.masterStaffYcId == null ? null : Number(body.masterStaffYcId),
    docDate: body.docDate == null ? null : normalized.docDate.toISOString(), comment: normalized.comment,
    gift: body.gift === true, unpaid: body.unpaid === true,
    totalCost: normalized.totalCost,
    lines: lines.map(l => ({ goodRowId: l.goodRowId, qty: l.qty, unitType: l.unitType,
      costPerUnit: l.costPerUnit, discount: l.discount, cost: l.cost, qtyBase: l.qtyBase,
      unitUnknown: l.unitUnknown, comment: l.comment })),
    payments: (body.payments || []).map(p => ({ method: p.method, amountKop: m.kop(p.amount) })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function saleResponse(q, salonId, doc, lines, warnings) {
  const payments = await store.listDocumentPayments(salonId, doc.id, q);
  const summary = await store.salePaymentSummary(q, salonId, doc.id, doc.total_cost ?? doc.totalCost, doc.status);
  return { ...doc, lines, payments, warnings, ...summary };
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
  if (b.unpaid != null && typeof b.unpaid !== 'boolean') result.errors.push('unpaid: true или false.');
  if (b.requestId != null && !validUuid(b.requestId)) result.errors.push('requestId: UUID.');
  if (b.payments != null && !Array.isArray(b.payments)) result.errors.push('Ожидается список оплат.');
  result.errors.push(...m.validateSalePayments(b.payments, result.normalized.totalCost, { gift: b.gift, unpaid: b.unpaid }).errors);
  if (b.gift === true && m.kop(result.normalized.totalCost) !== 0) result.errors.push('Итог подарка должен быть нулевым.');
  if (b.masterStaffYcId != null) {
    const staff=await require('../journal/reference-cache').getReference(salonId,'staff');
    if (!Array.isArray(staff) || !staff.some(s=>Number(s.id)===Number(b.masterStaffYcId)&&!s.fired)) result.errors.push('Специалист не найден в салоне.');
  }
  if (result.errors.length) validation(result.errors);
  const { lines, ...normalized } = result.normalized;
  // Клиент резолвится ДО транзакции: поиск в YClients (до 30 с) не должен держать соединение пула открытым.
  const client = await resolveClient(salonId, b);
  const requestId = b.requestId ? b.requestId.toLowerCase() : null;
  const requestHash = b.requestId ? createRequestHash({ userId, body: b, normalized, lines, client }) : null;
  return transaction(salonId, async q => {
    if (requestId) {
      // Сериализует конкурентные повторы до lookup/insert; unique index остаётся последней защитой.
      await q('SELECT pg_advisory_xact_lock($1, hashtext($2))', [salonId, requestId]);
      const existing = await store.documentByRequestId(salonId, requestId, q);
      if (existing) {
        if (existing.request_hash !== requestHash) m.fail('requestId уже использован с другими данными.', 409, 'idempotency_conflict');
        return saleResponse(q, salonId, existing, lines, result.warnings);
      }
    }
    if (b.recordId != null) {
      const r = (await q('SELECT id, client_id, yclients_client_id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, Number(b.recordId)])).rows[0];
      if (!r) validation(['Запись не найдена.']);
      if ((r.client_id != null && Number(r.client_id)!==Number(client.id)) || (r.yclients_client_id != null && Number(r.yclients_client_id)!==Number(client.yclients_client_id))) validation(['Пациент не совпадает с записью.']);
    }
    const input = { ...normalized, origin: 'loyalpro', status: 'posted', createdBy: userId,
      clientId: client.id, ycClientId: client.yclients_client_id ?? null,
      recordId: b.recordId == null ? null : Number(b.recordId), masterStaffYcId: b.masterStaffYcId == null ? null : Number(b.masterStaffYcId),
      requestId, requestHash };
    const doc = await store.insertDocument(q, salonId, input);
    await ledger.postDocument(q, salonId, { ...input, ...doc }, lines);
    const payments = [];
    for (const p of b.payments || []) payments.push(await finOps.recordStockSalePayment(q, {
      salonId, stockDocumentId: doc.id, opId: crypto.randomUUID(), method: p.method, amount: m.kop(p.amount) / 100,
      clientId: client.id, ycClientId: client.yclients_client_id ?? null, occurredAt: normalized.docDate, userId }));
    const summary = await store.salePaymentSummary(q, salonId, doc.id, normalized.totalCost, doc.status);
    return { ...doc, lines, payments, warnings: result.warnings, ...summary };
  });
}

async function addPayment(salonId, userId, documentId, body) {
  const b = body || {}; const errors = [];
  if (!validId(documentId)) errors.push('Некорректный id продажи.');
  if (!validUuid(b.paymentId)) errors.push('paymentId: UUID.');
  if (!m.PAY_METHODS.includes(b.method)) errors.push('Способ оплаты: наличные или карта.');
  const amountTypeOk = ['number', 'string'].includes(typeof b.amount);
  const amountKop = amountTypeOk ? m.kop(b.amount) : NaN;
  if (!amountTypeOk || !Number.isFinite(Number(b.amount)) || !Number.isSafeInteger(amountKop) || amountKop <= 0)
    errors.push('Сумма оплаты должна быть больше нуля.');
  if (errors.length) validation(errors);
  const paymentId = b.paymentId.toLowerCase();
  return transaction(salonId, async q => {
    // paymentId глобален внутри салона: одинаковый ключ для разных документов тоже сериализуется.
    await q('SELECT pg_advisory_xact_lock($1, hashtext($2))', [salonId, paymentId]);
    // Та же row lock, что в cancel(): оплата и отмена одного документа не проходят одновременно.
    const doc = await store.documentById(salonId, Number(documentId), q);
    if (!doc) m.fail('Продажа не найдена.', 404, 'not_found');
    if (doc.kind !== 'sale' || doc.origin !== 'loyalpro' || doc.status !== 'posted')
      m.fail('Этот документ нельзя оплатить.', 409, 'not_payable');
    const previous = await store.paymentByStepId(q, salonId, paymentId);
    if (previous) {
      const same = Number(previous.stock_document_id) === Number(doc.id) && previous.method === b.method &&
        m.kop(previous.amount) === amountKop && previous.status === 'confirmed';
      if (!same) m.fail('paymentId уже использован с другими данными.', 409, 'idempotency_conflict');
      return { payment: previous, ...(await store.salePaymentSummary(q, salonId, doc.id, doc.total_cost, doc.status)) };
    }
    const before = await store.salePaymentSummary(q, salonId, doc.id, doc.total_cost, doc.status);
    if (amountKop > m.kop(before.outstandingAmount)) m.fail('Сумма оплаты превышает долг.', 409, 'overpayment');
    const now = (await q('SELECT NOW() AS now')).rows[0]?.now;
    const financeKind = await appointmentGoods.saleKindForDocument(q, salonId, doc.id);
    const payment = await finOps.recordStockSalePayment(q, {
      salonId, stockDocumentId: doc.id, opId: paymentId, method: b.method, amount: amountKop / 100,
      clientId: doc.client_id ?? null, ycClientId: doc.yclients_client_id ?? null, occurredAt: now, userId, kind: financeKind,
    });
    const summary = await store.salePaymentSummary(q, salonId, doc.id, doc.total_cost, doc.status);
    if (m.kop(summary.outstandingAmount) === 0) await appointmentGoods.syncCodesForDocument(q, salonId, doc.id, 'active');
    return { payment, ...summary };
  });
}

async function clientDetail(salonId, clientId) {
  if (!validId(clientId)) validation(['Некорректный id клиента.']);
  const row = await store.saleClientById(salonId, Number(clientId));
  if (!row) m.fail('Клиент не найден.', 404, 'client_not_found');
  return { id: Number(row.id), displayName: row.display_name || '', firstName: row.first_name || '',
    lastName: row.last_name || '', patronymic: row.patronymic || '', phone: row.phone || '', email: row.email || '' };
}

module.exports = { create, addPayment, clientDetail, resolveClient, createRequestHash };
