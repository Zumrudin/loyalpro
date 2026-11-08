'use strict';

const { db } = require('../../../db');

const MAX_RESULTS = 10;

const schema = {
  name: 'search_retail_products',
  description: 'Найти косметику и товары, которые салон разрешил показывать пациентам: ' +
    'название, розничная цена и статус наличия. Вызывай при любом вопросе о косметике, ' +
    'цене товара или наличии. Не отвечай по памяти и не называй точное складское количество.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Название, бренд или часть названия товара.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

function availability(stock, threshold) {
  const rows = Array.isArray(stock) ? stock : [];
  const amount = rows.reduce((sum, row) => {
    const n = Number(row && row.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  if (amount <= 0) return 'out_of_stock';
  return amount <= Number(threshold || 1) ? 'low_stock' : 'in_stock';
}

async function run(salonId, input) {
  const query = String((input && input.query) || '').trim().slice(0, 120);
  if (query.length < 2) return { products: [], reason: 'query_too_short' };
  const rows = await db.any(`
    SELECT yclients_good_id, title, category_title, retail_price, stock,
           agent_low_stock_threshold, updated_at,
           updated_at >= NOW() - INTERVAL '36 hours' AS stock_is_fresh
      FROM yclients_goods_catalog
     WHERE salon_id=$1 AND agent_visible=TRUE AND is_archived=FALSE
       AND retail_price IS NOT NULL
       AND (title ILIKE $2 OR COALESCE(category_title, '') ILIKE $2 OR COALESCE(article, '') ILIKE $2)
     ORDER BY CASE WHEN title ILIKE $3 THEN 0 ELSE 1 END, title
     LIMIT $4`, [salonId, `%${query.replace(/[\\%_]/g, '\\$&')}%`, `${query.replace(/[\\%_]/g, '\\$&')}%`, MAX_RESULTS]);
  return {
    products: rows.map(row => ({
      id: Number(row.yclients_good_id),
      title: row.title,
      category: row.category_title || null,
      price: Number(row.retail_price),
      availability: row.stock_is_fresh === false
        ? 'unknown'
        : availability(row.stock, row.agent_low_stock_threshold),
      checked_at: row.updated_at || null,
    })),
    note: 'Точное складское количество пациенту не сообщай; используй только availability.',
  };
}

module.exports = { schema, run, availability };
