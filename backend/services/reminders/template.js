'use strict';
// Подстановки в текст напоминания. Чистый модуль.
//
// {first_name} резолвится ТЕМ ЖЕ utils/person-name.resolveGivenName, что и в
// автоуведомлениях: подставлять первое слово карточки нельзя — на боевой базе
// PERI 73.5% карточек это «Фамилия Имя Отчество» одной строкой, а 11.6% вместо
// имени содержат телефон или «Тест 2». Имя не опознано → подстановка пустая, а
// осиротевшая запятая в начале строки схлопывается (иначе «, пора повторить»).

const { resolveGivenName } = require('../../utils/person-name');

/** Число, включая 0, рендерится; null/undefined → пустая строка. */
function num(v) {
  return v === null || v === undefined || v === '' ? '' : String(v);
}

/**
 * @param {string} tpl текст правила или ступени
 * @param {object} ctx { name, nameDictionary, service, staff, days, accrued, balance, salon }
 */
function renderReminderText(tpl, ctx = {}) {
  if (!tpl) return '';
  const firstName = resolveGivenName(ctx.name, { dictionary: ctx.nameDictionary }) || '';
  return String(tpl)
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{name\}/g,       ctx.name || '')
    .replace(/\{услуга\}/g,     ctx.service || '')
    .replace(/\{мастер\}/g,     ctx.staff || '')
    .replace(/\{дней\}/g,       num(ctx.days))
    .replace(/\{бонусы\}/g,     num(ctx.accrued))
    .replace(/\{баланс\}/g,     num(ctx.balance))
    .replace(/\{салон\}/g,      ctx.salon || '')
    // «{first_name}, пора повторить» без имени → «Пора повторить»
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/** Текст ступени, а при пустом — базовый текст правила. */
function pickTierText(tier, ruleText) {
  const t = String((tier && tier.text) || '').trim();
  return t || String(ruleText || '');
}

module.exports = { renderReminderText, pickTierText };
