'use strict';
// Техкарты: разбор ответов YClients, стоимость нормы, выбор привязки, подсказки.
// Чистый модуль — без БД и сети.
//
// Три формы ответа YClients (сверены живыми запросами 19.10.2026):
//  - GET /technological_cards/{cid}/ — [{id, title, technological_card_items:[…]}];
//  - GET /technological_cards/record_consumables/{cid}/{record}/ — по строке на КАЖДУЮ
//    услугу записи: [{service_id, record_id, technological_cards:[карта…], consumables:[…]}],
//    у услуги без техкарты technological_cards = [];
//  - GET /technological_cards/default_for_staff_and_service/{cid}/{staff}/{service}/ —
//    одна карта или null.
// Элемент карты: {id, technological_card_id, storage_id, good_id, amount, price,
// good:{id, title, unit}} — название и единица лежат ВО ВЛОЖЕННОМ good, а не наверху.
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Карта YClients (любой из трёх ответов) → строка tech_cards. */
function parseYcCard(c) {
  if (!c || typeof c !== 'object') return null;
  const id = num(c.id);
  if (!id || id <= 0) return null;
  const items = (Array.isArray(c.technological_card_items) ? c.technological_card_items : [])
    .filter(i => i && typeof i === 'object')
    .map(i => ({
      good_id: num(i.good_id),
      amount: num(i.amount),
      unit: typeof i.unit === 'string' ? i.unit : (i.good && typeof i.good.unit === 'string' ? i.good.unit : null),
      price_at_sync: num(i.price),
      title: typeof i.title === 'string' ? i.title : (i.good && typeof i.good.title === 'string' ? i.good.title : null),
    }))
    .filter(i => i.good_id && i.amount !== null);
  return { yc_card_id: id, title: typeof c.title === 'string' ? c.title.slice(0, 500) : '', items };
}

/** Σ amount × unit_price(good, date). priceFn(goodId, date) → {price, source}. Без округления. */
function normCost(card, priceFn, date) {
  const items = card && Array.isArray(card.items) ? card.items : [];
  if (!items.length) return null;
  let cost = 0; const noPrice = [];
  for (const it of items) {
    const p = priceFn(it.good_id, date) || { price: 0, source: 'none' };
    if (!(Number(p.price) > 0)) noPrice.push(it.good_id);
    cost += Math.abs(Number(it.amount) || 0) * (Number(p.price) || 0);
  }
  return { cost, noPrice, items: items.length };
}

// Приоритет источников привязки: ручная > найденная в YClients (lookup) > выученная по факту.
// Тот же порядок держит апсерт привязки в store.js (младший источник не перетирает старший).
const SOURCE_RANK = { manual: 0, lookup: 1, learned: 2 };

/** Привязка для пары услуга+сотрудник: manual > lookup > learned; внутри источника — с сотрудником > общая. */
function pickTechCard(links, serviceYcId, staffYcId) {
  const cands = (links || []).filter(l => String(l.service_yc_id) === String(serviceYcId)
    && (l.staff_yc_id === null || l.staff_yc_id === undefined || String(l.staff_yc_id) === String(staffYcId)));
  if (!cands.length) return null;
  cands.sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
    || ((b.staff_yc_id != null) - (a.staff_yc_id != null)));
  return cands[0];
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Подсказки «техкарта ↔ услуга» по совпадению нормализованных названий (префикс). Не применяются сами. */
function suggestLinks(cards, services) {
  const out = [];
  for (const s of services || []) {
    const st = normTitle(s.title);
    if (st.length < 4) continue;
    const c = (cards || []).find(card => { const ct = normTitle(card.title); return ct.length >= 4 && (ct === st || st.startsWith(ct) || ct.startsWith(st)); });
    if (c) out.push({ service_yc_id: s.id, tech_card_id: c.id, title: c.title });
  }
  return out;
}

module.exports = { parseYcCard, normCost, pickTechCard, suggestLinks, normTitle, SOURCE_RANK };
