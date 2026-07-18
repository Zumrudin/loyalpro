'use strict';

// Реестр инструментов агента: schemas для Claude + карта имя→run.
const searchKb  = require('./search-knowledge-base');
const listSvc   = require('./list-services');
const listStaff = require('./list-staff');
const getSlots  = require('./get-available-slots');
const getClient = require('./get-client');
const createBk  = require('./create-booking');
const escalate  = require('./escalate-to-operator');

const tools = [searchKb, listSvc, listStaff, getSlots, getClient, createBk, escalate];

const schemas = tools.map(t => t.schema);
const handlers = {};
for (const t of tools) handlers[t.schema.name] = t.run;

module.exports = { schemas, handlers };
