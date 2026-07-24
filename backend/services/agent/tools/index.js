'use strict';

// Реестр инструментов агента: schemas для Claude + карта имя→run.
const searchKb  = require('./search-knowledge-base');
const listSvc   = require('./list-services');
const listStaff = require('./list-staff');
const getSlots  = require('./get-available-slots');
const getParSlot = require('./get-parallel-slots');
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

const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getDates, getClient,
  createBk, listBookings, visitHistory, cancelBk, reschedBk, modifySvc,
  bonusBal, abonement, escalate];

const schemas = tools.map(t => t.schema);
const handlers = {};
for (const t of tools) handlers[t.schema.name] = t.run;

module.exports = { schemas, handlers };
