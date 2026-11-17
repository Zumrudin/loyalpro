'use strict';
const catalog = require('../service-catalog');
const m = require('./model');

// External IDs identify persisted visit lines, but eligibility always comes
// from the same local settings catalog exposed to the journal picker.
async function requireAssigned(salonId, serviceIds, staffId) {
  if (!serviceIds.length) return;
  const { services } = await catalog.forJournal(salonId);
  for (const id of serviceIds) {
    const service = services.find(s => Number(s.yclientsId) === Number(id));
    if (!service || !service.staffIds?.some(staff => Number(staff) === Number(staffId))) {
      m.fail('Услуга не назначена выбранному специалисту в настройках услуг.', 409, 'service_assignment');
    }
  }
}
module.exports = { requireAssigned };
