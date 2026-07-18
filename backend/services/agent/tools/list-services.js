'use strict';

const { db } = require('../../../db');
const { ycGet } = require('../../yclients');

const schema = {
  name: 'list_services',
  description: 'Список услуг салона с актуальными ценами из YClients. ' +
    'Использовать, когда клиент спрашивает «что делаете / сколько стоит» в общем.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  const cfg = await db.any(
    `SELECT yclients_service_id, service_title
       FROM services_config WHERE salon_id = $1`,
    [salonId]);
  const salon = await db.one(`SELECT id, yclients_company_id FROM salons WHERE id=$1`, [salonId]);

  let liveById = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const data = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      const services = Array.isArray(data) ? data : [];
      liveById = new Map(services.map(s => [String(s.id), s]));
    } catch (_) { /* YClients недоступен → отдаём заголовки из конфига */ }
  }

  const services = cfg.map(c => {
    const live = liveById.get(String(c.yclients_service_id));
    return {
      yc_id: c.yclients_service_id,
      title: (live && live.title) || c.service_title,
      price_min: live ? live.price_min : null,
      price_max: live ? live.price_max : null,
    };
  });
  return { services };
}

module.exports = { schema, run };
