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
