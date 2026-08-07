'use strict';
// Бонусная часть напоминания: прочитать баланс карты, подобрать ступень,
// при необходимости начислить.
//
// ГЛАВНЫЙ ИНВАРИАНТ: наружу этот модуль НИКОГДА не бросает. Любой сбой —
// нет карты, YClients не ответил, начисление отвалилось — деградирует в
// ступень 'no_bonus', и напоминание уходит без единого слова про бонусы
// (утверждено при обсуждении). Обратный порядок — «сначала пообещать, потом
// начислить» — отвергнут: клиент не должен прочитать про 300 бонусов, которых
// у него нет.
//
// Начисление НЕОБРАТИМО (ручная транзакция по карте лояльности), поэтому
// вызывающий обязан звать applyBonus не более одного раза на строку очереди —
// защита стоит в воркере (проверка bonus_accrued IS NULL).

const { ycGetClientCards, ycAccrueCard } = require('../yclients');
const { pickTier } = require('./tiers');
const { createLogger } = require('../../logger');

const defaultDeps = {
  getCards: (salon, ycClientId) => ycGetClientCards(salon, ycClientId),
  accrue: (salon, cardId, amount, title) => ycAccrueCard(salon, cardId, amount, title),
  log: createLogger('RemindersBonus'),
};

const NO_BONUS_RESULT = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };

/**
 * @returns {{balanceBefore:number|null, tier:string, accrued:number, txnOk:boolean|null}}
 *   tier — 'accrue' | 'mention' | 'none' | 'no_bonus';
 *   txnOk — null если начисления не требовалось.
 */
async function applyBonus(salon, ycClientId, rawTiers, ruleTitle, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  if (!ycClientId) return { ...NO_BONUS_RESULT };

  let cards = [];
  try { cards = await d.getCards(salon, ycClientId); }
  catch (e) { d.log.warn(`карты клиента ${ycClientId} недоступны (${e.message}) — без бонусов`); return { ...NO_BONUS_RESULT }; }
  if (!Array.isArray(cards) || !cards.length) return { ...NO_BONUS_RESULT };

  // Карт может быть несколько (разные программы). Берём ту, где больше денег:
  // именно её клиент и потратит, и именно её баланс честно называть.
  const card = cards
    .map(c => ({ id: c && c.id, balance: Number(c && c.balance) || 0 }))
    .filter(c => c.id != null)
    .sort((a, b) => b.balance - a.balance)[0];
  if (!card) return { ...NO_BONUS_RESULT };

  const tier = pickTier(card.balance, rawTiers);
  if (tier.action !== 'accrue' || tier.amount <= 0) {
    return {
      balanceBefore: card.balance,
      tier: tier.action === 'accrue' ? 'no_bonus' : tier.action,
      accrued: 0,
      txnOk: null,
    };
  }

  try {
    await d.accrue(salon, card.id, tier.amount, `Бонусы по напоминанию «${ruleTitle || ''}»`);
    return { balanceBefore: card.balance, tier: 'accrue', accrued: tier.amount, txnOk: true };
  } catch (e) {
    d.log.error(`начисление ${tier.amount} на карту ${card.id} упало: ${e.message}`);
    return { balanceBefore: card.balance, tier: 'no_bonus', accrued: 0, txnOk: false };
  }
}

module.exports = { applyBonus, defaultDeps };
