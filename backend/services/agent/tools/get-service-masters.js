'use strict';

// Персональные цены мастеров по конкретным услугам. Пара к режиму
// AGENT_CATALOG_IN_PROMPT: в строке каталога виден только общий диапазон
// цены услуги, а «у Ани 5000, у главврача 8000» — здесь.
const { loadCatalogServices } = require('../catalog-data');
const { fmtPrice } = require('../catalog-block');
const { isMaleService, hasMalePriceList } = require('../male-services');

const MAX_IDS = 20;

// Подсказки мужского прайса приходят ровно в тот момент, когда модель берёт цену:
// правило промпта «МУЖСКОЙ ПРАЙС» легко пропустить на длинном ходу, а здесь оно
// лежит рядом с числом, которое пойдёт пациенту.
const HINT_FOR_MEN = 'Это услуга по МУЖСКОМУ прайсу — называй её цену и записывай по ней, только если процедура для мужчины. Женщине предложи ту же зону без приставки «Муж.».';
const HINT_MEN_LIST = 'В этом направлении для мужчин действует ОТДЕЛЬНЫЙ прайс — услуги с приставкой «Муж.» в каталоге. Это цена для женщины: если процедура для мужчины, возьми цену и оформляй запись по услуге «Муж. …».';

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
      const staff = (s.staff || []).map(m => {
        const p = fmtPrice(m.price_min, m.price_max);
        return {
          ...m,
          // Готовая строка для показа пациенту — модель копирует, а не форматирует
          // сырые price_min/price_max (источник ошибок «от 6500 ₽» и «6500–0»).
          // «₽» только к числу: fmtPrice может вернуть «инд.» (плейсхолдер-цена) —
          // там суффикс сломал бы строку в «инд. ₽».
          price_display: /^\d/.test(p) ? `${p} ₽` : p,
        };
      });
      const male = isMaleService(s.title)
        ? { for_men: true, hint: HINT_FOR_MEN }
        : hasMalePriceList(all, s) ? { men_price_list: true, hint: HINT_MEN_LIST } : null;
      services.push({ yc_id: s.yc_id, title: s.title, duration_min: s.duration_min, staff, ...male });
    } else notFound.push(id);
  }
  return notFound.length ? { services, not_found: notFound } : { services };
}

module.exports = { schema, run };
