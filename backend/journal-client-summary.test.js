'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', BONUS_LEDGER_PRIMARY: false }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGetClientAbonements: jest.fn() }));
const { db } = require('./db');
const config = require('./config');
const { ycGetClientAbonements } = require('./services/yclients');
const cs = require('./services/journal/client-summary');
const SALON = { id: 3, yclients_company_id: 77 };
const CLIENT = { id: 10, name: 'Анна', phone: '+79200255591', yclients_client_id: 555, bonus_balance: 700, yclients_card_balance: '650.5', loyalty_level: 'Золото', total_spent: '42000' };
const VISIT = { visit_datetime: new Date('2026-11-01T07:00:00Z'), raw_payload: { datetime: '2026-11-01T10:00:00+03:00', staff: { name: 'Юлия' },
  services: [{ title: 'Чистка' }], attendance: 1, client: { success_visits_count: 7, fail_visits_count: 2, phone: '79200255591' } } };
function setup({ client = CLIENT, visits = [VISIT], counts = { success: 4, fail: 1 } } = {}) {
  db.oneOrNone.mockImplementation(async sql => {
    if (/FROM salons/.test(sql)) return SALON;
    if (/FROM clients/.test(sql)) return client;
    if (/count\(\*\)/.test(sql)) return counts;
    return null;
  });
  db.any.mockImplementation(async sql => (/FROM records/.test(sql) ? visits : []));
}
beforeEach(() => { jest.clearAllMocks(); cs._cache.clear(); config.BONUS_LEDGER_PRIMARY = false; setup();
  ycGetClientAbonements.mockResolvedValue([{ type: { title: 'Чистка ×5' }, balance_container: { links: [{ count: 3 }] }, expiration_date: '2027-01-01' }]); });

test('summary by phone: card, counts from the mirror, last visits, abonements', async () => {
  const out = await cs.summary(3, { phone: '8 920 025-55-91' });
  expect(out).toEqual({ name: 'Анна', phone: '79200255591', visits: { success: 7, fail: 2 }, bonusBalance: 650.5, loyaltyLevel: 'Золото', totalSpent: 42000,
    lastVisits: [{ date: '2026-11-01', staffName: 'Юлия', services: ['Чистка'], attendance: 1 }],
    abonements: [{ title: 'Чистка ×5', balance: 3, expires: '2027-01-01' }], bonusesSource: 'card' });
  expect(ycGetClientAbonements).toHaveBeenCalledWith(SALON, '79200255591');
  for (const [sql, args] of [...db.oneOrNone.mock.calls, ...db.any.mock.calls]) if (!/FROM salons/.test(sql)) expect(args[0]).toBe(3);
});
test('ledger mode shows our balance', async () => {
  config.BONUS_LEDGER_PRIMARY = true;
  const out = await cs.summary(3, { ycClientId: '555' });
  expect(out).toMatchObject({ bonusBalance: 700, bonusesSource: 'ledger' });
});
test('without counters in the mirror, visits are counted', async () => {
  setup({ visits: [{ ...VISIT, raw_payload: { ...VISIT.raw_payload, client: {} } }] });
  expect((await cs.summary(3, { phone: '79200255591' })).visits).toEqual({ success: 4, fail: 1 });
});
test('abonements: cached 60 s, failure → null and not cached', async () => {
  await cs.summary(3, { phone: '79200255591' }); await cs.summary(3, { phone: '79200255591' });
  expect(ycGetClientAbonements).toHaveBeenCalledTimes(1);
  cs._cache.clear(); ycGetClientAbonements.mockRejectedValueOnce(new Error('boom'));
  expect((await cs.summary(3, { phone: '79200255591' })).abonements).toBe(null);
  expect((await cs.summary(3, { phone: '79200255591' })).abonements).toHaveLength(1);
});
test('unknown client still answers; bad input is 400', async () => {
  setup({ client: null, visits: [] });
  expect(await cs.summary(3, { phone: '79200255591' })).toMatchObject({ name: null, bonusBalance: null, totalSpent: null, lastVisits: [] });
  await expect(cs.summary(3, {})).rejects.toMatchObject({ status: 400 });
  await expect(cs.summary(3, { phone: '123' })).rejects.toMatchObject({ status: 400 });
  await expect(cs.summary(3, { ycClientId: 'x' })).rejects.toMatchObject({ status: 400 });
});
test('abonement balance: united counter, unlimited, links sum', () => {
  expect(cs.abonementsView([
    { type: { title: 'A' }, is_united_balance: true, united_balance_services_count: 4, balance_container: { links: [{ count: 9 }] } },
    { type: { title: 'B' }, is_united_balance_unlimited: true },
    { type: { title: 'C' }, balance_container: { links: [{ count: 1 }, { count: 2 }] } },
  ]).map(a => a.balance)).toEqual([4, 'безлимит', 3]);
});
