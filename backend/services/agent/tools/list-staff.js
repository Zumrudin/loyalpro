'use strict';

const { db } = require('../../../db');

const schema = {
  name: 'list_staff',
  description: 'Список активных мастеров/специалистов салона (имя, специализация, ' +
    'YClients-id для записи). Использовать, когда клиент спрашивает «кто делает / к кому записаться».',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  const rows = await db.any(
    `SELECT yclients_staff_id, name, specialization
       FROM staff_members
      WHERE salon_id = $1 AND is_active = true AND show_in_app = true
      ORDER BY display_order ASC, name ASC`,
    [salonId]);
  return { staff: rows.map(r => ({ yc_id: r.yclients_staff_id, name: r.name, specialization: r.specialization })) };
}

module.exports = { schema, run };
