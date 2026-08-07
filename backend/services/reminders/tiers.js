'use strict';
// Подбор бонусной ступени по балансу карты лояльности. Чистый модуль: ни БД,
// ни сети. Ступени приходят из reminder_rules.bonus_tiers как есть (их пишет
// администратор через админку), поэтому нормализация обязана быть
// недоверчивой: неизвестное действие или нечисловой порог не должны молча
// превратиться в начисление реальных денег на карту клиента.
//
// Порог up_to ИСКЛЮЧАЮЩИЙ: ступень ловит баланс строго меньше своего порога.
// Последняя ступень с up_to:null — «весь остаток».

const TIER_ACTIONS = ['accrue', 'mention', 'none'];

/** Ступень «про бонусы молчим»: нет карты, сбой YClients, кривые настройки. */
const NO_BONUS = Object.freeze({ upTo: null, action: 'no_bonus', amount: 0, text: '' });

/** Сырые ступени из JSONB → отсортированный валидный список. */
function normalizeTiers(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter(t => t && TIER_ACTIONS.includes(t.action))
    .map(t => ({
      upTo: t.up_to === null || t.up_to === undefined ? null : Number(t.up_to),
      action: t.action,
      amount: Math.max(0, Math.round(Number(t.amount) || 0)),
      text: String(t.text || ''),
    }))
    .filter(t => t.upTo === null || Number.isFinite(t.upTo));

  const finite = list.filter(t => t.upTo !== null).sort((a, b) => a.upTo - b.upTo);
  const infinite = list.find(t => t.upTo === null);
  return infinite ? [...finite, infinite] : finite;
}

/**
 * Баланс → ступень. Возвращает объект вида
 * { upTo, action: 'accrue'|'mention'|'none'|'no_bonus', amount, text }.
 * Неизвестный баланс и непокрытый остаток дают 'no_bonus' — сообщение уйдёт
 * без бонусной части, а не по случайной ступени.
 */
function pickTier(balance, rawTiers) {
  const b = Number(balance);
  if (balance === null || balance === undefined || !Number.isFinite(b)) return NO_BONUS;
  for (const t of normalizeTiers(rawTiers)) {
    if (t.upTo === null || b < t.upTo) return t;
  }
  return NO_BONUS;
}

module.exports = { pickTier, normalizeTiers, TIER_ACTIONS, NO_BONUS };
