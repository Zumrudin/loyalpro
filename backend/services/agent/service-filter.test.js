'use strict';
const test = require('node:test');
const assert = require('node:assert');
const f = require('./service-filter');

const mk = (o = {}) => ({
  mode: o.mode || 'all',
  denyServices: new Set(o.denyServices || []),
  allowServices: new Set(o.allowServices || []),
  denyPairs: new Set(o.denyPairs || []),
});

test('all-режим: услуга видна, если нет deny', () => {
  assert.equal(f.decideServiceVisible(mk(), 10), true);
  assert.equal(f.decideServiceVisible(mk({ denyServices: ['10'] }), 10), false);
});

test('allowlist-режим: услуга видна только если есть allow', () => {
  assert.equal(f.decideServiceVisible(mk({ mode: 'allowlist' }), 10), false);
  assert.equal(f.decideServiceVisible(mk({ mode: 'allowlist', allowServices: ['10'] }), 10), true);
});

test('id нормализуются к строке (number и string эквивалентны)', () => {
  assert.equal(f.decideServiceVisible(mk({ denyServices: ['10'] }), '10'), false);
});

test('filterServiceStaff убирает deny-пары', () => {
  const filter = mk({ denyPairs: ['10:5'] });
  assert.deepEqual(f.filterServiceStaff(filter, 10, [5, 6, 7]), [6, 7]);
});

test('decideOfferVisible all: активная видна по умолчанию, неактивная — нет', () => {
  assert.equal(f.decideOfferVisible(mk(), 10, true), true);
  assert.equal(f.decideOfferVisible(mk(), 10, false), false);
});

test('decideOfferVisible all: активную можно скрыть deny, неактивную показать allow', () => {
  assert.equal(f.decideOfferVisible(mk({ denyServices: ['10'] }), 10, true), false);
  assert.equal(f.decideOfferVisible(mk({ allowServices: ['10'] }), 10, false), true);
});

test('decideOfferVisible allowlist: только явный allow, active игнорируется', () => {
  assert.equal(f.decideOfferVisible(mk({ mode: 'allowlist' }), 10, true), false);
  assert.equal(f.decideOfferVisible(mk({ mode: 'allowlist', allowServices: ['10'] }), 10, false), true);
});

test('isBookable: false при скрытой услуге ИЛИ скрытой паре', () => {
  assert.equal(f.isBookable(mk(), 10, 5), true);
  assert.equal(f.isBookable(mk({ denyServices: ['10'] }), 10, 5), false);
  assert.equal(f.isBookable(mk({ denyPairs: ['10:5'] }), 10, 5), false);
  assert.equal(f.isBookable(mk({ mode: 'allowlist', allowServices: ['10'] }), 10, 5), true);
});
