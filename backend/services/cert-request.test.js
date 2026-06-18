const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizePhone, validateInn, makeRateLimiter, makeTokenStore,
} = require('./cert-request');

test('normalizePhone: только цифры, 8→7 не трогаем (оставляем как есть)', () => {
  assert.strictEqual(normalizePhone('+7 (912) 345-67-89'), '79123456789');
  assert.strictEqual(normalizePhone('8 912 345 67 89'), '89123456789');
  assert.strictEqual(normalizePhone(''), '');
  assert.strictEqual(normalizePhone(null), '');
});

test('validateInn: валидный 12-значный (физлицо)', () => {
  assert.strictEqual(validateInn('500100732259'), true);
  assert.strictEqual(validateInn('500100732258'), false); // битая контрольная
});

test('validateInn: валидный 10-значный (юрлицо)', () => {
  assert.strictEqual(validateInn('7830002293'), true);
  assert.strictEqual(validateInn('7830002292'), false);
});

test('validateInn: неверная длина/нецифры → false', () => {
  assert.strictEqual(validateInn('12345'), false);
  assert.strictEqual(validateInn('abcdefghij'), false);
  assert.strictEqual(validateInn(''), false);
  assert.strictEqual(validateInn(null), false);
});

test('makeRateLimiter: пропускает до лимита, потом блокирует, окно сбрасывается', () => {
  let now = 1000;
  const rl = makeRateLimiter({ max: 2, windowMs: 100, now: () => now });
  assert.strictEqual(rl('1.1.1.1'), true);
  assert.strictEqual(rl('1.1.1.1'), true);
  assert.strictEqual(rl('1.1.1.1'), false);     // лимит исчерпан
  assert.strictEqual(rl('2.2.2.2'), true);       // другой IP — свой счётчик
  now += 101;                                     // окно прошло
  assert.strictEqual(rl('1.1.1.1'), true);
});

test('makeTokenStore: выдаёт токен, отдаёт значение в TTL, истекает после', () => {
  let now = 0;
  const store = makeTokenStore({ ttlMs: 100, now: () => now });
  const tok = store.put({ requestId: 7, salonId: 1 });
  assert.strictEqual(typeof tok, 'string');
  assert.deepStrictEqual(store.get(tok), { requestId: 7, salonId: 1 });
  now = 101;
  assert.strictEqual(store.get(tok), null);
});

const { matchPatient, computeYearAmount, resolveSalonBySlug } = require('./cert-request');

function fakeDb(responses) {
  // responses: массив значений, отдаём по очереди на каждый oneOrNone/one
  let i = 0;
  return {
    oneOrNone: async () => responses[i++],
    one: async () => responses[i++],
  };
}

test('matchPatient: находит клиента по нормализованному телефону', async () => {
  const db = fakeDb([{ id: 42 }]);
  const r = await matchPatient({ db, salonId: 1, phone: '+7 (912) 345-67-89' });
  assert.deepStrictEqual(r, { clientId: 42 });
});

test('matchPatient: нет совпадения → clientId null', async () => {
  const db = fakeDb([null]);
  const r = await matchPatient({ db, salonId: 1, phone: '79990000000' });
  assert.deepStrictEqual(r, { clientId: null });
});

test('matchPatient: пустой телефон → null без запроса', async () => {
  const r = await matchPatient({ db: fakeDb([]), salonId: 1, phone: '' });
  assert.deepStrictEqual(r, { clientId: null });
});

test('computeYearAmount: сумма из revenue_operations', async () => {
  const db = fakeDb([{ total: '12345.67' }]);
  const sum = await computeYearAmount({ db, salonId: 1, clientId: 42, year: 2025 });
  assert.strictEqual(sum, 12345.67);
});

test('computeYearAmount: clientId null → 0 без запроса', async () => {
  const sum = await computeYearAmount({ db: fakeDb([]), salonId: 1, clientId: null, year: 2025 });
  assert.strictEqual(sum, 0);
});

test('resolveSalonBySlug: находит салон', async () => {
  const db = fakeDb([{ id: 1, cert_request_slug: 'clinic-1' }]);
  const s = await resolveSalonBySlug({ db, slug: 'clinic-1' });
  assert.strictEqual(s.id, 1);
});
