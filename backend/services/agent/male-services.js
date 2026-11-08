'use strict';

// Мужской прайс клиники — это ОТДЕЛЬНЫЕ услуги каталога с приставкой «Муж.» в
// начале названия, а не наценка на женскую услугу: «Муж. Комплекс 5в1 …» —
// 24 700 ₽ против 19 000 ₽ у женской «5в1Лоб+брови…» (у главного врача — 29 900
// против 23 000). Инцидент 2026-08-01: пациенту-мужчине названа женская цена,
// потому что ничто не связывало пару услуг между собой.
// Чистый модуль: правило распознавания одно на промпт и на подсказку инструмента.

// Приставка именно В НАЧАЛЕ названия — это соглашение прайса клиники.
// Упоминание «для мужчин» внутри названия признаком прайса НЕ считаем:
// ошибочно назвать женщине мужскую цену так же плохо, как наоборот.
const MALE_TITLE_RE = /^\s*муж(\.|ск|чин|\s)/i;

function isMaleService(title) {
  return MALE_TITLE_RE.test(String(title == null ? '' : title));
}

// Есть ли у направления этой услуги отдельный мужской прайс. Направление —
// ПОЛНЫЙ category_path: мужская ботулинотерапия не делает мужской биоревитализацию,
// хотя обе лежат в «Инъекционной косметологии».
function hasMalePriceList(services, service) {
  if (!service || isMaleService(service.title)) return false;
  const path = (service.category_path || []).join('>');
  if (!path) return false;                     // сравнивать не с чем — не гадаем
  return (Array.isArray(services) ? services : []).some(s =>
    s !== service && isMaleService(s.title) && (s.category_path || []).join('>') === path);
}

// ── Лазерная эпиляция: мужчине — стандартная цена +30 % ─────────────────────
// Решение владельца 08.11.2026: отдельно дублировать эпиляцию для мужчин
// избыточно — услуги «Муж.» этого направления удалены в YClients, остались
// стандартные. Мужская цена = стандартная +30 %, и считает её КОД (как диапазоны
// цен в catalog-block): арифметику модель делает хуже, а правило «сам
// коэффициенты не применяй» в промпте остаётся верным. Направление узнаём по
// category_path, а не по id категории салона.
const MALE_MARKUP_RATE = 0.3;
const MALE_MARKUP_DIRECTION_RE = /лазерн\S*\s+эпиляц/i;
// Интимные зоны мужчинам не проводятся: любые виды бикини и межъягодичная зона,
// а значит, и комплексы, куда они входят (№1–№6 с бикини, №7 «все зоны»). Мужской
// цены у них нет вовсе — модель физически не может её назвать.
const INTIMATE_ZONE_RE = /бикини|меж[ъь]?ягодичн|все\s+зоны/i;

function hasMaleMarkup(service) {
  if (!service || isMaleService(service.title)) return false;
  return (service.category_path || []).some(c => MALE_MARKUP_DIRECTION_RE.test(String(c == null ? '' : c)));
}

function isIntimateZone(title) {
  return INTIMATE_ZONE_RE.test(String(title == null ? '' : title));
}

// Есть ли у услуги мужская цена «стандартная +30 %».
function maleMarkupApplies(service) {
  return hasMaleMarkup(service) && !isIntimateZone(service.title);
}

// Ровно ×1,3 без дополнительного округления — так был посчитан прежний мужской
// прайс клиники (1100 → 1430, 2500 → 3250). Math.round снимает хвост float.
function maleMarkupPrice(n) {
  return Math.round(Number(n) * (1 + MALE_MARKUP_RATE));
}

module.exports = {
  isMaleService, hasMalePriceList,
  hasMaleMarkup, isIntimateZone, maleMarkupApplies, maleMarkupPrice, MALE_MARKUP_RATE,
};
