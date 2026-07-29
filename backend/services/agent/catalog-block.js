'use strict';

// Компактный текстовый каталог услуг для СИСТЕМНОГО промпта
// (AGENT_CATALOG_IN_PROMPT). Одна услуга — одна строка
// id|название|мин|цена|направление>подкатегория|id мастеров.
// ~16k символов против 77k у JSON list_services (замер 2026-07-27, salon 1).
const { loadCatalogServices } = require('./catalog-data');
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
    .map(s => [
      s.yc_id,
      cell(s.title, 120),
      s.duration_min || '',
      fmtPrice(s.price_min, s.price_max),
      (s.category_path || []).map(c => cell(c, 60)).join('>'),
      (s.staff || []).map(m => m.yc_id).sort((a, b) => a - b).join(','),
    ].join('|'));
  const block = [
    'КАТАЛОГ УСЛУГ КЛИНИКИ (полный актуальный список; формат строки: id услуги|название|длительность в минутах|цена ₽|направление>подкатегория|id мастеров через запятую). Цена: одно число — точная стоимость; X-Y — диапазон по мастерам; «инд.» — стоимость определяет врач на консультации, цифру НЕ называй; пусто — цены нет, не выдумывай:',
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
