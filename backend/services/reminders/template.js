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

  // Значения приходят из CRM (услуга, мастер, салон, имя из карточки клиента) и
  // уходят живому клиенту — цепочка из String.replace(regex, СТРОКА) тут не
  // годится по ДВУМ причинам:
  //   1. строковый аргумент replace разворачивает $-шаблоны ($&, $$, $`, $',
  //      $1…) — «Топ$& мастер» превратилось бы в текст с повторённым куском
  //      совпадения вместо буквального «$&»;
  //   2. каждый следующий replace в цепочке сканирует УЖЕ подставленный текст,
  //      поэтому плейсхолдер, случайно оказавшийся внутри РАНЕЕ подставленного
  //      значения, разворачивается повторно (инъекция через данные CRM).
  // Один проход по ИСХОДНОМУ шаблону с функцией-заменителем читает каждый
  // плейсхолдер ровно один раз и подставляет значение как есть, без повторного
  // сканирования и без интерпретации $-синтаксиса.
  const values = {
    first_name: firstName,
    name:       ctx.name || '',
    'услуга':   ctx.service || '',
    'мастер':   ctx.staff || '',
    'дней':     num(ctx.days),
    'бонусы':   num(ctx.accrued),
    'баланс':   num(ctx.balance),
    'салон':    ctx.salon || '',
  };
  return String(tpl)
    .replace(/\{(first_name|name|услуга|мастер|дней|бонусы|баланс|салон)\}/g, (_, key) => values[key])
    // «{first_name}, пора повторить» без имени → «Пора повторить»
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/** Текст ступени, а при пустом — базовый текст правила. */
function pickTierText(tier, ruleText) {
  const t = String((tier && tier.text) || '').trim();
  return t || String(ruleText || '');
}

module.exports = { renderReminderText, pickTierText };
