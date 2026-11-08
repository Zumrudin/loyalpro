'use strict';

const { db } = require('../../../db');

const MAX_RESULTS = 10;

const schema = {
  name: 'search_abonement_offers',
  description: 'Найти доступные для покупки абонементы салона и их актуальные цены. ' +
    'Инструмент сам применяет только настроенную салоном действующую акцию. Вызывай при ' +
    'вопросе о покупке, цене или вариантах абонемента; не используй для остатка уже купленного ' +
    'абонемента — для этого есть get_client_abonements.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Процедура или название абонемента.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

function dateKeyMoscow(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
}

function priceFor(row, today) {
  const base = Number(row.price);
  const pct = Number(row.promo_percent);
  const starts = row.promo_starts_on ? String(row.promo_starts_on).slice(0, 10) : null;
  const ends = row.promo_ends_on ? String(row.promo_ends_on).slice(0, 10) : null;
  const active = Number.isFinite(pct) && pct > 0 && pct <= 100 &&
    (!starts || starts <= today) && (!ends || ends >= today);
  return {
    base_price: base,
    final_price: active ? Math.round(base * (100 - pct)) / 100 : base,
    ...(active ? { promo: { label: row.promo_label || null, percent: pct, starts_on: starts, ends_on: ends } } : {}),
  };
}

async function run(salonId, input, ctx = {}) {
  const query = String((input && input.query) || '').trim().slice(0, 120);
  if (query.length < 2) return { offers: [], reason: 'query_too_short' };
  const rows = await db.any(`
    SELECT id, title, procedures_count, price, terms, promo_label, promo_percent,
           promo_starts_on, promo_ends_on, updated_at
      FROM agent_abonement_offers
     WHERE salon_id=$1 AND agent_visible=TRUE AND is_active=TRUE AND title ILIKE $2
     ORDER BY title, procedures_count NULLS LAST
     LIMIT $3`, [salonId, `%${query.replace(/[\\%_]/g, '\\$&')}%`, MAX_RESULTS]);
  const today = dateKeyMoscow(ctx.now ? new Date(ctx.now) : new Date());
  return { offers: rows.map(row => ({
    id: Number(row.id), title: row.title,
    procedures_count: row.procedures_count == null ? null : Number(row.procedures_count),
    terms: row.terms || null,
    ...priceFor(row, today),
    checked_at: row.updated_at || null,
  })) };
}

module.exports = { schema, run, priceFor, dateKeyMoscow };
