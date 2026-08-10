'use strict';

// Компактный текстовый каталог услуг для СИСТЕМНОГО промпта
// (AGENT_CATALOG_IN_PROMPT). Одна услуга — одна строка
// id|название|мин|цена|направление>подкатегория|id мастеров.
// ~16k символов против 77k у JSON list_services (замер 2026-07-27, salon 1).
const { loadCatalogServices, matchesGenericTitle } = require('./catalog-data');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentCatalogBlock');

const MAX_BLOCK_CHARS = 40000;

// Названия услуг/категорий/мастеров приходят из YClients и попадают в системный
// промпт — привилегированную позицию. Управляющие символы и переносы — вектор
// «дописать агенту правила», | ломает колонки: режем всё.
function cell(v, maxLen) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// Цена-заглушка обобщённых услуг («Биоревитализация» = 1 ₽): реальную стоимость
// определяет врач по препарату. Показывать её пациенту нельзя — рендерим «инд.»,
// чтобы модель физически не видела 1 ₽ (раньше это правило жило только в промпте).
const PLACEHOLDER_PRICE_MAX = 100;

// «Ботулинотерапия Ботулакс 1 ед» — цена за ОДНУ ЕДИНИЦУ препарата (370 ₽), а не
// за процедуру; промпт запрещает называть её пациенту и включать в диапазоны.
// Тот же приём, что с заглушкой 1 ₽: рендерим «инд.» и мастеров без цен — модель
// физически не видит числа, и правило перестаёт держаться на одном промпте
// (спека 2026-08-10-agent-prompt-to-code-offload).
const UNIT_PRICE_TITLE = 'Ботулинотерапия Ботулакс 1 ед';
const isUnitPriceService = (title) => matchesGenericTitle(title, UNIT_PRICE_TITLE);

function fmtPrice(min, max) {
  const lo = Number(min) || 0;
  const hi = Number(max) || 0;
  if (!lo && !hi) return '';
  if (!lo) return String(hi);
  // price_max:0 в YClients — НЕ «без верхней границы», а незаполненное поле:
  // price_min и есть фактическая цена (правило «точная цена без "от"», df1f426).
  if (!hi || hi <= lo) {
    return lo <= PLACEHOLDER_PRICE_MAX ? 'инд.' : String(lo);
  }
  return `${lo}-${hi}`;
}

// Колонка мастеров. Если цены мастеров различаются — цена КАЖДОГО стоит прямо
// в строке («55=5000,66=8000»), иначе только id («55,66»). Инцидент 2026-08-01:
// в строке был только агрегат «19000-23000», модель не пошла за точной суммой в
// get_service_masters и назвала пациенту нижнюю границу как цену главврача.
function fmtStaffCell(staff, opts = {}) {
  const list = (staff || []).slice().sort((a, b) => a.yc_id - b.yc_id);
  if (!list.length) return '';
  if (opts.hidePrices) return list.map(m => String(m.yc_id)).join(',');
  const prices = list.map(m => fmtPrice(m.price_min, m.price_max));
  const same = prices.every(p => p === prices[0]);
  return list.map((m, i) => (same ? String(m.yc_id) : `${m.yc_id}=${prices[i]}`)).join(',');
}

function renderCatalogBlock(services) {
  if (!Array.isArray(services) || !services.length) return null;
  const sorted = services
    .slice()
    .sort((a, b) => a.yc_id - b.yc_id);   // детерминизм = обязательное условие префикс-кэша
  const masters = new Map();   // id → имя (первое вхождение в отсортированном по yc_id порядке)
  for (const s of sorted) {
    for (const m of (s.staff || [])) {
      if (!masters.has(m.yc_id)) masters.set(m.yc_id, cell(m.name, 60));
    }
  }
  const legend = [...masters.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, name]) => `${id}=${name}`)
    .join('; ');
  const lines = sorted
    .map(s => {
      const unitPrice = isUnitPriceService(s.title);
      return [
        s.yc_id,
        cell(s.title, 120),
        s.duration_min || '',
        unitPrice ? 'инд.' : fmtPrice(s.price_min, s.price_max),
        (s.category_path || []).map(c => cell(c, 60)).join('>'),
        fmtStaffCell(s.staff, { hidePrices: unitPrice }),
      ].join('|');
    });
  const block = [
    'КАТАЛОГ УСЛУГ КЛИНИКИ (полный актуальный список; формат строки: id услуги|название|длительность в минутах|цена ₽|направление>подкатегория|id мастеров через запятую). Цена: одно число — точная стоимость; X-Y — цены мастеров различаются, и тогда в колонке мастеров у каждого стоит его собственная цена (id=цена) — называй пациенту именно её, а не границу диапазона; «инд.» — стоимость определяет врач на консультации, цифру НЕ называй; пусто — цены нет, не выдумывай. Услуги с приставкой «Муж.» в начале названия — мужской прайс: мужчине называй цену и оформляй запись ТОЛЬКО по ним, женщине — только по строкам без приставки:',
    legend ? `Мастера: ${legend}` : null,
    ...lines,
  ].filter(Boolean).join('\n');
  if (block.length > MAX_BLOCK_CHARS) {
    logger.warn(`каталог в промпте аномально велик: ${block.length} символов (>${MAX_BLOCK_CHARS})`);
  }
  return block;
}

// null при любом сбое → оркестратор остаётся в legacy-режиме с list_services.
async function buildSafe(salonId) {
  try {
    return renderCatalogBlock(await loadCatalogServices(salonId));
  } catch (e) {
    logger.warn(`не собрать каталог для промпта (${e.message}) — legacy-режим с list_services`);
    return null;
  }
}

module.exports = { renderCatalogBlock, buildSafe, fmtPrice };
