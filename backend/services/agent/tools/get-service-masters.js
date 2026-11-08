'use strict';

// Персональные цены мастеров по конкретным услугам. Пара к режиму
// AGENT_CATALOG_IN_PROMPT: в строке каталога виден только общий диапазон
// цены услуги, а «у Ани 5000, у главврача 8000» — здесь.
const { loadCatalogServices } = require('../catalog-data');
const { fmtPrice, fmtMalePrice, isUnitPriceService } = require('../catalog-block');
const { isMaleService, hasMalePriceList, hasMaleMarkup, isIntimateZone, maleMarkupApplies } = require('../male-services');

const MAX_IDS = 20;

// Подсказки мужского прайса приходят ровно в тот момент, когда модель берёт цену:
// правило промпта «МУЖСКОЙ ПРАЙС» легко пропустить на длинном ходу, а здесь оно
// лежит рядом с числом, которое пойдёт пациенту.
const HINT_FOR_MEN = 'Это услуга по МУЖСКОМУ прайсу — называй её цену и записывай по ней, только если процедура для мужчины. Женщине предложи ту же зону без приставки «Муж.».';
const HINT_MEN_LIST = 'В этом направлении для мужчин действует ОТДЕЛЬНЫЙ прайс — услуги с приставкой «Муж.» в каталоге. Это цена для женщины: если процедура для мужчины, возьми цену и оформляй запись по услуге «Муж. …».';
// Цена этой услуги — за ОДНУ ЕДИНИЦУ препарата, а не за процедуру. В блоке
// каталога она уже замаскирована в «инд.», но инструмент отдавал и
// price_display: «370 ₽», и сырые price_min/price_max — а память между ходами
// (tool-memory) рендерит price_display в хвост промпта и держит его 48 часов.
// Здесь тот же приём: числа не пропускаем вовсе, правило перестаёт держаться
// на одном промпте (спека 2026-08-10-agent-prompt-to-code-offload).
// Лазерная эпиляция (решение владельца 08.11.2026): отдельных услуг «Муж.» нет,
// мужчине — стандартная цена +30 %. Число считает код и кладёт рядом с обычной
// ценой: модель берёт готовую сумму, процент сама не считает.
const HINT_MALE_MARKUP = 'Отдельного мужского прайса у лазерной эпиляции нет: для мужчины цена = стандартная +30%, она уже посчитана — поле price_display_men у мастера. Мужчине называй ЕЁ (сама процент не считай), женщине — price_display. Запись в обоих случаях — на эту же услугу.';
const HINT_MEN_NOT_AVAILABLE = 'Интимная зона: мужчинам лазерную эпиляцию этой зоны (любые виды бикини, межъягодичная зона и комплексы с ними) не проводят — мужчине цену не называй и не записывай, предложи другие зоны.';
const HINT_UNIT_PRICE = 'У этой услуги цена — за ОДНУ ЕДИНИЦУ препарата, а не за процедуру: пациенту её НЕ называй (поэтому здесь «инд.»). Действуй по правилу «БОТУЛИНОТЕРАПИЯ — по ЗОНАМ»: подсвети, что ботулинотерапия проводится по зонам, назови диапазон направления, а точную цену — когда пациент назвал зону.';

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
      const unitPrice = isUnitPriceService(s.title);
      const maleMarkup = !unitPrice && maleMarkupApplies(s);
      const staff = (s.staff || []).map(m => {
        // Цена за единицу препарата: ни price_display с числом, ни сырых
        // price_min/price_max — модель не должна видеть 370 ₽ ни в ответе
        // инструмента, ни в памяти между ходами.
        if (unitPrice) return { yc_id: m.yc_id, name: m.name, price_display: 'инд.' };
        const p = fmtPrice(m.price_min, m.price_max);
        const men = maleMarkup ? fmtMalePrice(m.price_min, m.price_max) : '';
        return {
          ...m,
          // Готовая строка для показа пациенту — модель копирует, а не форматирует
          // сырые price_min/price_max (источник ошибок «от 6500 ₽» и «6500–0»).
          // «₽» только к числу: fmtPrice может вернуть «инд.» (плейсхолдер-цена) —
          // там суффикс сломал бы строку в «инд. ₽».
          price_display: /^\d/.test(p) ? `${p} ₽` : p,
          ...(men ? { price_display_men: `${men} ₽` } : {}),
        };
      });
      // Хинт единицы препарата ГЛАВНЕЕ мужских: подсказка «это цена для женщины»
      // не имеет смысла там, где цену не отдаём вовсе.
      const extra = unitPrice
        ? { unit_price: true, hint: HINT_UNIT_PRICE }
        : isMaleService(s.title)
          ? { for_men: true, hint: HINT_FOR_MEN }
          : maleMarkup ? { male_markup: true, hint: HINT_MALE_MARKUP }
            : hasMaleMarkup(s) && isIntimateZone(s.title) ? { men_not_available: true, hint: HINT_MEN_NOT_AVAILABLE }
              : hasMalePriceList(all, s) ? { men_price_list: true, hint: HINT_MEN_LIST } : null;
      services.push({ yc_id: s.yc_id, title: s.title, duration_min: s.duration_min, staff, ...extra });
    } else notFound.push(id);
  }
  return notFound.length ? { services, not_found: notFound } : { services };
}

module.exports = { schema, run };
