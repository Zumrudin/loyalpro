'use strict';
const { id } = require('./protocol');

function cardFor(cards, typeId) {
  const matching = cards.filter(c => String(c.type?.id) === String(typeId));
  if (matching.length > 1) throw new Error('Ambiguous loyalty cards');
  if (matching.length && !id(matching[0].id)) throw new Error('Invalid loyalty card');
  return matching[0] || null;
}

// Durable intent BEFORE every non-idempotent CRM write. Any uncertain outcome
// (including process death between HTTP success and DB save) stops automation.
// Never retry a debit/accrual/create merely because the HTTP response was lost.
async function register({ store, crm, phone, name, birthday }) {
  let r = await store.registration(phone);
  const save = async patch => { r = { ...r, ...patch }; await store.saveRegistration(phone, r); };
  const review = async () => { await save({ uncertainStage: r.uncertainStage || r.stage, stage: 'review' }); return r; };
  // Recover only the pre-card client-creation stage via verified read-only
  // lookup. A pre-existing card is safe to link, never eligible for a welcome
  // grant. Card/bonus uncertainty still requires manual reconciliation.
  const uncertain = r.uncertainStage || r.stage;
  if (['client_creating', 'review'].includes(r.stage) && uncertain === 'client_creating'
    && r.typeId && !r.clientId && !r.cardId) {
    const existing = await crm.search(phone);
    const card = existing ? cardFor(await crm.cards(existing.id), r.typeId) : null;
    if (card) {
      await save({ stage: 'done', clientId: String(existing.id), cardId: String(card.id), welcome: false,
        recoveredFrom: 'client_creating', uncertainStage: null });
      return r;
    }
  }
  if (['client_creating', 'card_creating', 'bonus_sending', 'review'].includes(r.stage)) return review();
  if (r.stage === 'done') return r;
  if (!r.typeId) await save({ typeId: await crm.cardType(), name, birthday });
  if (!r.clientId) {
    let c = await crm.search(phone);
    if (!c) {
      await save({ stage: 'client_creating' });
      try { c = await crm.createClient(phone, r.name); }
      catch { return review(); }
    }
    await save({ stage: 'client_ready', clientId: String(c.id) });
  }
  if (!r.cardId) {
    let card = cardFor(await crm.cards(r.clientId), r.typeId);
    if (card) {
      await save({ stage: 'done', cardId: String(card.id), welcome: false });
      return r;
    }
    await save({ stage: 'card_creating', cardNumber: crm.cardNumber() });
    try {
      await crm.createCard(phone, r.typeId, r.cardNumber);
      card = cardFor(await crm.cards(r.clientId), r.typeId);
      // Only our newly issued card qualifies for the welcome amount. If a card
      // appeared concurrently via Telegram/staff, do not claim ownership of it.
      if (!card || String(card.number ?? card.loyalty_card_number) !== String(r.cardNumber)) return review();
    } catch { return review(); }
    await save({ stage: 'card_ready', cardId: String(card.id) });
  }
  await save({ stage: 'bonus_sending' });
  try { await crm.accrue(r.cardId); }
  catch { return review(); }
  await save({ stage: 'done', welcome: true });
  return r;
}

module.exports = { register, cardFor };
