// backend/services/medical-cert-defaults.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildDefaults } = require('./medical-cert-defaults');

const CLINIC = {
  org_name: 'ООО «КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ «ПЕРИ КЛИНИК»',
  org_inn: '9724060392', org_kpp: '772401001',
  signer_name: 'Гаджиева Пери Исамудиновна',
};

test('buildDefaults собирает ФИО, сумму и константы', async () => {
  const fakeDb = {
    oneOrNone: async () => ({ name: 'Агафонов Артем Эдуардович' }),
    one: async () => ({ total: '82203.00' }),
  };
  const r = await buildDefaults({ db: fakeDb, clinic: CLINIC, salonId: 1, clientId: 5, year: 2025 });
  assert.strictEqual(r.payer_last, 'АГАФОНОВ');
  assert.strictEqual(r.payer_first, 'АРТЕМ');
  assert.strictEqual(r.payer_middle, 'ЭДУАРДОВИЧ');
  assert.strictEqual(r.amount_total, 82203);
  assert.strictEqual(r.org_inn, '9724060392');
  assert.strictEqual(r.report_year, '2025');
  assert.strictEqual(r.signer_last, 'ГАДЖИЕВА');
});

test('buildDefaults: клиент не найден → пустое ФИО, сумма 0', async () => {
  const fakeDb = { oneOrNone: async () => null, one: async () => ({ total: null }) };
  const r = await buildDefaults({ db: fakeDb, clinic: CLINIC, salonId: 1, clientId: 999, year: 2025 });
  assert.strictEqual(r.payer_last, '');
  assert.strictEqual(r.amount_total, 0);
});
