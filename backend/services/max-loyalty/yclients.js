'use strict';
const crypto = require('crypto');
const yc = require('../yclients');
const { phone, id } = require('./protocol');

function list(value) {
  if (!Array.isArray(value)) throw new Error('Invalid YClients list response');
  return value;
}
function createYclients(salon) {
  if (!salon?.yclients_company_id || !salon.yclients_partner_token || !salon.yclients_user_token) {
    throw new Error('YClients is not configured');
  }
  const company = salon.yclients_company_id;
  return {
    async search(p) {
      const rows = list(await yc.ycPost(salon, `/company/${company}/clients/search`, {
        page: 1, page_size: 100, count: 100, fields: ['id', 'phone'],
        filters: [{ type: 'quick_search', state: { value: p } }],
      }));
      // YClients defaults to id-only rows. Missing identity fields must never
      // be interpreted as "no client" and lead to a duplicate creation attempt.
      if (rows.some(c => !id(c?.id) || !phone(c?.phone))) throw new Error('Incomplete YClients identity response');
      const matches = rows.filter(c => phone(c.phone) === p);
      // Ambiguous CRM duplicates must be resolved by staff, never select first hit.
      if (matches.length > 1) throw new Error('Ambiguous YClients client');
      if (rows.length >= 100 && !matches.length) throw new Error('Incomplete YClients search');
      if (matches.length && !id(matches[0].id)) throw new Error('Invalid YClients client');
      return matches[0] || null;
    },
    client: clientId => yc.ycGet(salon, `/client/${company}/${clientId}`),
    async createClient(p, name) {
      const c = await yc.ycPost(salon, `/clients/${company}`, { name, phone: p });
      if (!id(c?.id)) throw new Error('Invalid client creation response');
      return c;
    },
    async cardType() {
      const types = list(await yc.ycGet(salon, `/loyalty/card_types/salon/${company}`));
      const type = salon.yclients_card_type_id
        ? types.find(t => String(t.id) === String(salon.yclients_card_type_id))
        : types.find(t => t.title === 'samosale');
      if (!id(type?.id)) throw new Error('Loyalty card type not configured');
      return String(type.id);
    },
    cards: async clientId => list(await yc.ycGet(salon, `/loyalty/client_cards/${clientId}`)),
    createCard: (p, type, number) => yc.ycPost(salon, `/loyalty/cards/${company}`, {
      loyalty_card_number: number, loyalty_card_type_id: type, phone: Number(p),
    }),
    accrue: cardId => yc.ycAccrueCard(salon, cardId, 500, 'Приветственные бонусы за регистрацию в программе лояльности'),
    cardNumber: () => crypto.randomInt(1000000, 10000000),
  };
}
module.exports = { createYclients };
