'use strict';
// Подстановки текста разовой рассылки через мессенджеры (спека 2026-11-01 §3). Чистый модуль.
// {first_name} — ЛИЧНОЕ имя через общий resolveGivenName (первое слово карточки — чаще фамилия);
// имя не опознано → пусто, осиротевшая «, » в начале строки схлопывается тем же правилом, что в
// notifications/render.js renderTemplate (капитализация следующей буквы): правило одно на оба модуля.
const { resolveGivenName } = require('../../utils/person-name');

const CAPTION_MAX = 1024;

/** ctx = {name, bonus_balance, salon_name, phone}; значения — функциями (спецпоследовательности $& в имени). */
function renderText(template, ctx) {
  if (!template) return '';
  const c = ctx || {};
  const firstName = resolveGivenName(c.name) || '';
  return String(template)
    .replace(/\{name\}/g, () => c.name || '')
    .replace(/\{first_name\}/g, () => firstName)
    .replace(/\{bonuses\}/g, () => String(Math.round(Number(c.bonus_balance) || 0)))
    .replace(/\{salon\}/g, () => c.salon_name || '')
    .replace(/\{phone\}/g, () => c.phone || '')
    // «{first_name}, здравствуйте!» без имени → «Здравствуйте!», а не «, здравствуйте!».
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/**
 * Куда класть текст при картинке: подпись ≤ 1024 символов — подписью, длиннее — отдельным сообщением
 * следом (картинка уходит без подписи). Без картинки — обычное текстовое сообщение.
 */
function splitCaption(text, hasImage) {
  if (!hasImage) return { caption: null, followText: text };
  if (String(text).length <= CAPTION_MAX) return { caption: text, followText: null };
  return { caption: '', followText: text };
}

module.exports = { renderText, splitCaption, CAPTION_MAX };
