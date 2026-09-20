'use strict';
// ============================================================
// Бонусная карта пациента: выбор карты типа салона и чтение баланса.
//
// Общий модуль для двух потребителей: напоминания о повторном визите
// (services/reminders/bonus.js — там дальше идёт начисление) и бонусный довод
// в напоминании Милы о себе (services/agent/followup-bonus.js — только чтение).
//
// ГЛАВНЫЙ ИНВАРИАНТ readCardBalance: наружу НИКОГДА не бросает, и результат
// ТРЁХЗНАЧЕН — 'ok' / нет карты ('no_card', 'no_client') / 'unavailable'.
// Разница между «карты нет» и «не смогли проверить» принципиальна: по «карты
// нет» пациенту уходит приглашение зарегистрироваться в программе лояльности,
// и получить его держатель карты в момент сбоя сети не должен. Поэтому карты
// читаются СТРОГИМ вызовом (ycGetClientCardsStrict бросает), а не
// ycGetClientCards, который при сбое молча отдаёт [].
//
// Карта — СТРОГО типа, настроенного в салоне (salons.yclients_card_type_id),
// как в services/loyalty.js и routes/clients.js: у клиента бывают карты других
// программ, и их баланс называть нельзя. Тип не задан → 'unavailable'.
//
// Юнит-тесты: card-balance.test.js
// ============================================================

const { db: realDb } = require('../db');
const { ycGetClientCardsStrict, ycSearchClientIdByPhone } = require('./yclients');
const { normalizePhoneKey } = require('./agent-gate');
const { createLogger } = require('../logger');

/**
 * Карта типа салона с максимальным балансом. Чистая.
 * @returns {{id:number, balance:number}|null}
 */
function pickSalonCard(cards, cardTypeId) {
  if (!Array.isArray(cards) || cardTypeId == null) return null;
  const want = String(cardTypeId);
  return cards
    .filter((c) => c && c.type && String(c.type.id) === want && c.id != null)
    .map((c) => ({ id: c.id, balance: Number(c.balance) || 0 }))
    .sort((a, b) => b.balance - a.balance)[0] || null;
}

const defaultDeps = {
  // Быстрый путь: id клиента YClients из нашей карточки (loyalty-синк).
  // Суффиксный LIKE, как в get_bonus_balance: в clients номера лежат в разных
  // формах ('+7…'), точное сравнение с каноничным ключом промахивается.
  findClientId: async (salon, phone) => {
    const row = await realDb.oneOrNone(
      `SELECT yclients_client_id FROM clients
        WHERE salon_id = $1 AND phone LIKE '%' || $2 AND yclients_client_id IS NOT NULL
        LIMIT 1`, [salon.id, phone]);
    return row && row.yclients_client_id ? Number(row.yclients_client_id) : null;
  },
  searchClientId: (salon, phone) => ycSearchClientIdByPhone(salon, phone),
  getCards: (salon, ycClientId) => ycGetClientCardsStrict(salon, ycClientId),
  log: createLogger('CardBalance'),
};

/**
 * @param {object} salon строка salons: id, yclients_company_id, токены, yclients_card_type_id
 * @param {string} rawPhone номер собеседника
 * @returns {Promise<
 *   {status:'ok', balance:number, cardId:number} |
 *   {status:'no_card'} | {status:'no_client'} |
 *   {status:'unavailable', reason:string}>}
 */
async function readCardBalance(salon, rawPhone, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!salon || !salon.yclients_card_type_id) {
    d.log.warn('тип карты лояльности не выбран в настройках салона — баланс не читаем');
    return { status: 'unavailable', reason: 'no_card_type' };
  }
  const phone = normalizePhoneKey(String(rawPhone || ''));
  if (!phone || phone.length < 10) return { status: 'unavailable', reason: 'no_phone' };

  let ycClientId = null;
  try { ycClientId = await d.findClientId(salon, phone); }
  catch (e) { d.log.warn(`clients по ${phone}: ${e.message}`); return { status: 'unavailable', reason: 'db_failed' }; }

  if (!ycClientId) {
    try { ycClientId = await d.searchClientId(salon, phone); }
    catch (e) { d.log.warn(`clients/search по ${phone}: ${e.message}`); return { status: 'unavailable', reason: 'search_failed' }; }
    if (!ycClientId) return { status: 'no_client' };
  }

  let cards;
  try { cards = await d.getCards(salon, ycClientId); }
  catch (e) { d.log.warn(`карты клиента ${ycClientId}: ${e.message}`); return { status: 'unavailable', reason: 'cards_failed' }; }

  const card = pickSalonCard(cards, salon.yclients_card_type_id);
  if (!card) return { status: 'no_card' };
  return { status: 'ok', balance: Math.floor(card.balance), cardId: card.id };
}

module.exports = { pickSalonCard, readCardBalance, defaultDeps };
