'use strict';
// Шлюз зовёт доставки через фасад модуля (server.js: require('./lib/deliveries')),
// а не через makeDeliveries. Новая функция, добавленная только в makeDeliveries,
// молча не работала бы в бою (31.10.2026: raiseStatus квитанций не вызывался).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../lib/deliveries');

test('фасад deliveries экспортирует каждую функцию makeDeliveries', () => {
  const inst = mod.makeDeliveries({ query: async () => ({ rows: [] }), oneOrNone: async () => null });
  for (const name of Object.keys(inst)) assert.equal(typeof mod[name], 'function', `нет в фасаде: ${name}`);
});
