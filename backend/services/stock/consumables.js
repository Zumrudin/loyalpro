'use strict';
const store = require('./store');
const { transaction } = require('./documents');
const { fail, consumableDelta } = require('./model');
const { pickTechCard } = require('../economics/tech-cards');
const { unitPriceAsOf, round4 } = require('../economics/price');
function serviceId(s) {
  return Number(s.yclients_id ?? s.id ?? s.service_yc_id);
}
function expectedFor(service, staffId, links, cards, priceFn, goods) {
  const link = pickTechCard(links, serviceId(service), staffId);
  const card = link && cards.find((c) => String(c.id) === String(link.tech_card_id));
  const out = new Map();
  for (const item of card?.items || []) {
    const good = goods.find((g) => Number(g.yclients_good_id) === Number(item.good_id));
    if (!good) continue;
    const p = priceFn(good.id) || { price: 0 };
    const qty = Math.abs(Number(item.amount) || 0) * (Number(service.amount ?? service.quantity) || 1);
    const row = out.get(Number(good.id)) || {
      goodRowId: Number(good.id),
      title: good.title,
      unit: good.service_unit,
      qtyBase: 0,
      unitPrice: p.price,
      cost: 0,
    };
    row.qtyBase = round4(row.qtyBase + qty);
    row.cost = round4(row.qtyBase * row.unitPrice);
    out.set(row.goodRowId, row);
  }
  return [...out.values()];
}
function actualRows(movements) {
  const out = new Map();
  for (const m of movements) {
    const id = Number(m.good_row_id);
    const row = out.get(id) || { goodRowId: id, qtyBase: 0, adjustments: false };
    row.qtyBase = round4(row.qtyBase - Number(m.qty_base));
    row.adjustments ||= m.origin === 'loyalpro';
    out.set(id, row);
  }
  return [...out.values()];
}
function compare(expected, actual) {
  const e = new Map(expected.map((r) => [r.goodRowId, r]));
  const a = new Map(actual.map((r) => [r.goodRowId, r]));
  return [...new Set([...e.keys(), ...a.keys()])].map((id) => {
    const want = e.get(id)?.qtyBase || 0,
      have = a.get(id)?.qtyBase || 0;
    return {
      goodRowId: id,
      expected: want,
      actual: have,
      diff: round4(have - want),
      flag: !want && have ? 'extra' : want && !have ? 'missing' : have > want * 1.2 ? 'over' : 'ok',
      adjustments: !!a.get(id)?.adjustments,
    };
  });
}
async function prices(salonId, ctx, movements) {
  const out = new Map();
  // Memoized once per good for a visit, with a bounded sequential DB workload.
  const selected = ctx.services.map((s) => pickTechCard(ctx.links, serviceId(s), ctx.staffId)?.tech_card_id);
  const needed = new Set(movements.map((m) => Number(m.good_row_id)));
  for (const c of ctx.cards.filter((c) => selected.some((id) => String(id) === String(c.id))))
    for (const i of c.items || []) {
      const g = ctx.goods.find((g) => Number(g.yclients_good_id) === Number(i.good_id));
      if (g) needed.add(Number(g.id));
    }
  for (const g of ctx.goods) {
    if (!needed.has(Number(g.id))) continue;
    out.set(
      Number(g.id),
      unitPriceAsOf({
        receipts: await store.listReceipts(salonId, g.id),
        override: ctx.overrides.find((o) => Number(o.good_id) === Number(g.yclients_good_id)),
        catalogRow: g,
        date: ctx.date,
      }),
    );
  }
  return out;
}
async function forRecord(salonId, recordId) {
  const ctx = await store.consumablesContext(salonId, recordId);
  if (!ctx) fail('Запись не найдена.', 404, 'not_found');
  const movements = recordId < 0 ? [] : await store.recordConsumableMovements(salonId, recordId);
  const priceMap = await prices(salonId, ctx, movements);
  const services = ctx.services.map((s) => {
    const id = serviceId(s);
    const expected = expectedFor(s, ctx.staffId, ctx.links, ctx.cards, (id) => priceMap.get(id), ctx.goods);
    const actual = actualRows(movements.filter((m) => Number(m.service_yc_id) === id));
    const rows = compare(expected, actual).map((r) => {
      const g = ctx.goods.find((g) => Number(g.id) === r.goodRowId);
      const price = priceMap.get(r.goodRowId)?.price ?? Number(g?.unit_actual_cost ?? 0);
      return {
        ...r,
        title: g?.title || 'Товар',
        unit: g?.service_unit || '',
        unitPrice: price,
        cost: round4(r.actual * price),
        expectedCost: round4(r.expected * price),
      };
    });
    return { id, title: s.title || 'Услуга', rows };
  });
  const unassigned = actualRows(
    movements.filter((m) => !ctx.services.some((s) => serviceId(s) === Number(m.service_yc_id))),
  ).map((r) => {
    const g = ctx.goods.find((g) => Number(g.id) === r.goodRowId);
    return {
      ...r,
      title: g?.title || 'Товар',
      unit: g?.service_unit || '',
      cost: round4(r.qtyBase * (priceMap.get(r.goodRowId)?.price || 0)),
    };
  });
  return {
    recordId,
    services,
    unassigned,
    goods: ctx.goods.map((g) => ({
      id: g.id,
      title: g.title,
      service_unit: g.service_unit,
      stock_active: g.stock_active,
    })),
    summary: {
      actual: round4(
        services.flatMap((s) => s.rows).reduce((v, r) => v + r.cost, 0) + unassigned.reduce((v, r) => v + r.cost, 0),
      ),
      expected: round4(services.flatMap((s) => s.rows).reduce((v, r) => v + r.expectedCost, 0)),
    },
    note: recordId < 0 ? 'Запись ещё не отправлена. Доступна только норма.' : null,
  };
}
async function update(salonId, userId, recordId, serviceYcId, body) {
  if (recordId < 0) fail('Для локальной записи доступна только норма.', 409, 'local_record');
  return transaction(salonId, async (q) => {
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stock-consumables:${salonId}:${recordId}`]);
    const ctx = await store.consumablesContext(salonId, recordId);
    if (!ctx || !ctx.services.some((s) => serviceId(s) === serviceYcId))
      fail('Запись или услуга не найдена.', 404, 'not_found');
    const target = body?.lines;
    if (!Array.isArray(target) || target.length > 500) fail('Ожидается состав расходников.', 400, 'validation');
    const actual = actualRows(
      (await store.recordConsumableMovements(salonId, recordId, q)).filter(
        (m) => Number(m.service_yc_id) === serviceYcId,
      ),
    );
    if (actual.some((r) => r.qtyBase < 0))
      fail('Обнаружен положительный итог движения расходников. Требуется сверка.', 409, 'invalid_actual');
    const seen = new Set();
    for (const l of target) {
      if (
        !l ||
        !Number.isSafeInteger(l.goodRowId) ||
        !ctx.goods.some(
          (g) =>
            Number(g.id) === l.goodRowId &&
            (g.stock_active !== false || l.qtyBase <= (actual.find((r) => r.goodRowId === l.goodRowId)?.qtyBase || 0)),
        ) ||
        typeof l.qtyBase !== 'number' ||
        !Number.isFinite(l.qtyBase) ||
        l.qtyBase < 0 ||
        seen.has(l.goodRowId)
      )
        fail('Некорректный товар или количество.', 400, 'validation');
      seen.add(l.goodRowId);
    }
    const deltas = consumableDelta(target, actual);
    if (!deltas.length) return { unchanged: true };
    const settings = await store.getSettings(salonId),
      storage = await store.storageById(salonId, settings.default_service_storage_id);
    if (!storage?.is_active) fail('Выберите активный склад расходников в настройках.', 409, 'storage_required');
    const now = new Date();
    const d = await store.insertDocument(q, salonId, {
      kind: 'consumable',
      origin: 'loyalpro',
      status: 'posted',
      storageId: storage.id,
      docDate: now,
      recordId,
      masterStaffYcId: ctx.staffId,
      createdBy: userId,
    });
    for (const l of deltas)
      await store.insertMovement(q, salonId, {
        documentId: d.id,
        goodRowId: l.goodRowId,
        storageId: storage.id,
        qty: Math.abs(l.qtyBase),
        unitType: 2,
        qtyBase: l.qtyBase,
        recordId,
        serviceYcId,
        masterStaffYcId: ctx.staffId,
        source: 'loyalpro',
        occurredAt: now,
      });
    return { documentId: d.id };
  });
}
module.exports = { expectedFor, actualRows, compare, forRecord, update };
