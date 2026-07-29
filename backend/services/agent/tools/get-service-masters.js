'use strict';

// Персональные цены мастеров по конкретным услугам. Пара к режиму
// AGENT_CATALOG_IN_PROMPT: в строке каталога виден только общий диапазон
// цены услуги, а «у Ани 5000, у главврача 8000» — здесь.
const { loadCatalogServices } = require('../catalog-data');
const { fmtPrice } = require('../catalog-block');

const MAX_IDS = 20;

const schema = {
  name: 'get_service_masters',
  description: 'Мастера указанных услуг с персональной ценой КАЖДОГО мастера (цены могут отличаться: врач vs главный врач). ' +
    'В поле price_display каждого мастера — готовая строка цены: называй её пациенту дословно. ' +
    'Звать, когда пациент спрашивает цену у конкретного мастера или нужна точная сумма, а у услуги в каталоге диапазон.',
  input_schema: {
    type: 'object',
    properties: {
      service_yc_ids: {
        type: 'array', items: { type: 'integer' },
        description: 'yc_id услуг из каталога (первая колонка строки)',
      },
    },
    required: ['service_yc_ids'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const raw = input && input.service_yc_ids;
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(Number.isFinite))] : [];
  if (!ids.length) return { error: 'service_yc_ids: нужен непустой массив yc_id услуг из каталога' };
  if (ids.length > MAX_IDS) return { error: `слишком много услуг за один вызов (максимум ${MAX_IDS})` };

  const all = await loadCatalogServices(salonId);
  const byId = new Map(all.map(s => [Number(s.yc_id), s]));
  const services = [];
  const notFound = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) {
      const staff = (s.staff || []).map(m => ({
        ...m,
        // Готовая строка для показа пациенту — модель копирует, а не форматирует
        // сырые price_min/price_max (источник ошибок «от 6500 ₽» и «6500–0»).
        price_display: (() => {
          const p = fmtPrice(m.price_min, m.price_max);
          return p ? `${p} ₽` : '';
        })(),
      }));
      services.push({ yc_id: s.yc_id, title: s.title, duration_min: s.duration_min, staff });
    } else notFound.push(id);
  }
  return notFound.length ? { services, not_found: notFound } : { services };
}

module.exports = { schema, run };
