'use strict';

// Реестр инструментов агента: schemas для Claude + карта имя→run.
// Два режима: legacy (list_services как инструмент) и catalogMode
// (AGENT_CATALOG_IN_PROMPT: каталог уже в системном промпте).
const searchKb  = require('./search-knowledge-base');
const listSvc   = require('./list-services');
const listStaff = require('./list-staff');
const getSlots  = require('./get-available-slots');
const getParSlot = require('./get-parallel-slots');
const getSeqSlot = require('./get-sequential-slots');
const getDates  = require('./get-available-dates');
const getClient = require('./get-client');
const createBk  = require('./create-booking');
const escalate  = require('./escalate-to-operator');
const listBookings = require('./list-client-bookings');
const visitHistory = require('./get-client-visit-history');
const cancelBk  = require('./cancel-booking');
const reschedBk = require('./reschedule-booking');
const modifySvc = require('./modify-booking-services');
const bonusBal  = require('./get-bonus-balance');
const abonement = require('./get-client-abonements');
const svcMasters = require('./get-service-masters');

const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getSeqSlot, getDates, getClient,
  createBk, listBookings, visitHistory, cancelBk, reschedBk, modifySvc,
  bonusBal, abonement, escalate];

function build(list) {
  const schemas = list.map(t => t.schema);
  const handlers = {};
  for (const t of list) handlers[t.schema.name] = t.run;
  return { schemas, handlers };
}

const legacy = build(tools);

// catalogMode: list_services из схем убран (не соблазнять модель лишним вызовом),
// вместо него get_service_masters. Стаб-хендлер — на случай, если модель всё же
// сгенерирует фантомный вызов list_services: мягкая подсказка вместо
// «Неизвестный инструмент» дешевле для восстановления хода.
const catalogMode = build(tools.filter(t => t !== listSvc).concat(svcMasters));
catalogMode.handlers.list_services = async () => ({
  error: 'Каталог услуг уже приведён в системном промпте (раздел «КАТАЛОГ УСЛУГ КЛИНИКИ») — возьми данные оттуда, этот инструмент вызывать не нужно.',
});

module.exports = { schemas: legacy.schemas, handlers: legacy.handlers, catalogMode };
