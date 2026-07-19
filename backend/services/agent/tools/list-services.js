'use strict';

const { db } = require('../../../db');
const { ycGet } = require('../../yclients');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');

const schema = {
  name: 'list_services',
  description: 'Список услуг салона: актуальная цена из YClients и мастера, которые эту услугу выполняют. ' +
    'Использовать, когда клиент спрашивает «что делаете / сколько стоит / кто делает такую-то услугу / что делает мастер».',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  // service_title/tag из админки — используем как фолбэк, если YClients недоступен.
  const cfg = await db.any(
    `SELECT yclients_service_id, service_title
       FROM services_config WHERE salon_id = $1`,
    [salonId]);

  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);

  // Имена активных мастеров по yclients_staff_id — чтобы подставить в каждую услугу.
  const staffRows = await db.any(
    `SELECT yclients_staff_id, name
       FROM staff_members
      WHERE salon_id = $1 AND is_active = true`, [salonId]);
  const staffNameById = new Map(staffRows.map(s => [String(s.yclients_staff_id), s.name]));

  const filter = await settings.loadServiceFilterSafe(salonId);

  let live = [];
  if (salon && salon.yclients_company_id) {
    try {
      const data = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      live = Array.isArray(data) ? data : [];
    } catch (_) { /* YClients недоступен → фолбэк на заголовки из конфига */ }
  }

  // Услуги с реальной ценой — база каталога. Видимость (учёт active YClients,
  // deny/allow-правил админки) решает decideOfferVisible ниже.
  const priced = live.filter(s => Number(s.price_max) > 0);

  // service.staff = [{ id, seance_length }] → имена мастеров, кто делает эту услугу.
  // Сначала выкидываем deny-пары услуга×мастер, затем резолвим в имена.
  const staffNamesOf = (s) => svcFilter
    .filterServiceStaff(filter, s.id, (s.staff || []).map(st => st.id))
    .map(id => staffNameById.get(String(id)))
    .filter(Boolean);

  let services;
  if (priced.length) {
    services = priced
      .filter(s => svcFilter.decideOfferVisible(filter, s.id, s.active === 1))
      .map(s => ({
        yc_id: s.id,
        title: s.title,
        price_min: s.price_min,
        price_max: s.price_max,
        staff: staffNamesOf(s),   // мастера, выполняющие услугу
      }));
  } else {
    // Нет живых данных (нет YClients-компании или API упал) → отдаём хотя бы заголовки из конфига.
    services = cfg.map(c => ({
      yc_id: c.yclients_service_id,
      title: c.service_title,
      price_min: null,
      price_max: null,
      staff: [],
    }));
  }

  return { services };
}

module.exports = { schema, run };
