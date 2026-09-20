'use strict';
// ============================================================
// Бонусная фраза для напоминания Милы о себе — ЧИСТЫЙ выбор по фактам.
// Спека: docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md
//
// Все факты приходят снаружи (класс ситуации, результат чтения карты,
// шаблоны салона, признаки «уже звучало»); модуль только решает, какая ветка
// применима, и рендерит шаблон. Текст пишет САЛОН, а не модель: баланс —
// живые данные, называть их по памяти Миле запрещено, а дописка кодом не
// может ни выдумать число, ни оказаться «не к месту» вопреки гейтам.
//
// Порядок проверок: гейты уместности → статус карты → шаблон ветки. Пустой
// шаблон выключает ТОЛЬКО свою ветку.
//
// Юнит-тесты: agent-followup-bonus.test.js
// ============================================================

// Слово о бонусах/лояльности в транскрипте или в тексте модели: второй раз
// звучать не должно. «балл» намеренно не в списке — в клинике так говорят и о
// другом (см. visit-rating.js).
const BONUS_MENTION_RE = /бонус|лояльност/iu;

/** 3024 → «3 024» (неразрывный пробел), целая часть. */
function formatBalance(n) {
  const v = Math.floor(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * @param {object} o
 * @param {{kind:string, bonusOk:boolean}} o.situation
 * @param {{status:string, balance?:number}} o.card   результат card-balance.readCardBalance
 * @param {object} o.settings   followupBonusText / followupWelcomeText / followupBonusMinBalance
 * @param {boolean} o.alreadyMentioned  бонусы уже звучали в окне транскрипта
 * @param {boolean} o.recentlySent      по номеру за 7 дней уже уходила бонусная фраза
 * @param {string}  o.nudgeText         текст напоминания от модели
 * @param {(t:string)=>string} [o.render]  общий рендер шаблонов ({first_name}, {salon})
 * @returns {{kind:'balance', text:string, balance:number}|{kind:'welcome', text:string}|null}
 */
function chooseBonusLine({ situation, card, settings = {}, alreadyMentioned, recentlySent, nudgeText, render } = {}) {
  if (!situation || !situation.bonusOk) return null;
  if (alreadyMentioned || recentlySent) return null;
  if (BONUS_MENTION_RE.test(String(nudgeText || ''))) return null;
  if (!card) return null;
  const rnd = typeof render === 'function' ? render : (t) => t;

  if (card.status === 'ok') {
    const tpl = String(settings.followupBonusText || '').trim();
    if (!tpl) return null;
    const min = Number.isFinite(Number(settings.followupBonusMinBalance)) ? Number(settings.followupBonusMinBalance) : 100;
    const balance = Math.floor(Number(card.balance) || 0);
    if (balance < min) return null;
    const text = rnd(tpl.replace(/\{balance\}/g, formatBalance(balance))).trim();
    return text ? { kind: 'balance', text, balance } : null;
  }
  if (card.status === 'no_card' || card.status === 'no_client') {
    const tpl = String(settings.followupWelcomeText || '').trim();
    if (!tpl) return null;
    const text = rnd(tpl).trim();
    return text ? { kind: 'welcome', text } : null;
  }
  return null;
}

module.exports = { chooseBonusLine, formatBalance, BONUS_MENTION_RE };
