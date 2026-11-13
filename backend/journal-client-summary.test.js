'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', BONUS_LEDGER_PRIMARY: false }));
jest.mock('./services/bonus-ledger', () => ({ isPrimary: () => require('./config').BONUS_LEDGER_PRIMARY === true }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGetClientAbonements: jest.fn() }));
const { db } = require('./db');
const config = require('./config');
const { ycGetClientAbonements } = require('./services/yclients');
const cs = require('./services/journal/client-summary');
const SALON = { id: 3, yclients_company_id: 77 };
const CLIENT = { id: 10, name: 'Анна', phone: '+79200255591', yclients_client_id: 555, bonus_balance: 700, yclients_card_balance: '650.5', ledger_open: true, loyalty_level: 'Золото', total_spent: '42000' };
const VISIT = { visit_datetime: new Date('2026-11-01T07:00:00Z'), raw_payload: { datetime: '2026-11-01T10:00:00+03:00', staff: { name: 'Юлия' },
  services: [{ title: 'Чистка' }], attendance: 1, client: { success_visits_count: 7, fail_visits_count: 2, phone: '79200255591' } } };
function setup({ client = CLIENT, visits = [VISIT], counts = { success: 4, fail: 1 }, fresh = VISIT.raw_payload.client } = {}) {
  db.oneOrNone.mockImplementation(async sql => {
    if (/FROM salons/.test(sql)) return SALON;
    if (/FROM clients/.test(sql)) return client;
    if (/count\(\*\)/.test(sql)) return counts;
    if (/AS client FROM records/.test(sql)) return { client: fresh };
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
    abonements: [{ title: 'Чистка ×5', balance: 3, expires: '2027-01-01', status: null, frozen: false }], bonusesSource: 'card' });
  expect(ycGetClientAbonements).toHaveBeenCalledWith(SALON, '79200255591');
  for (const [sql, args] of [...db.oneOrNone.mock.calls, ...db.any.mock.calls]) if (!/FROM salons/.test(sql)) expect(args[0]).toBe(3);
});
test('ledger mode shows our balance', async () => {
  config.BONUS_LEDGER_PRIMARY = true;
  const out = await cs.summary(3, { ycClientId: '555' });
  expect(out).toMatchObject({ bonusBalance: 700, bonusesSource: 'ledger' });
});
test('without counters in the mirror, visits are counted', async () => {
  setup({ fresh: {} });
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

const sqls = () => [...db.oneOrNone.mock.calls, ...db.any.mock.calls].map(c => c[0]);
test('ledger flag on but no opening balance → card reading', async () => {
  config.BONUS_LEDGER_PRIMARY = true; setup({ client: { ...CLIENT, ledger_open: false } });
  expect(await cs.summary(3, { ycClientId: '555' })).toMatchObject({ bonusBalance: 650.5, bonusesSource: 'card' });
});
test('duplicate cards: the card with a reading wins in ORDER BY; exact phone forms passed', async () => {
  await cs.summary(3, { phone: '9200255591' });
  const call = db.oneOrNone.mock.calls.find(c => /FROM clients/.test(c[0]));
  expect(call[0].replace(/\s+/g, ' ')).toMatch(/ORDER BY \(\$2::bigint IS NOT NULL AND yclients_client_id=\$2\) DESC, \(yclients_card_balance IS NOT NULL\) DESC, \(yclients_client_id IS NOT NULL\) DESC, id/);
  expect(call[1][2]).toEqual(['79200255591', '+79200255591', '89200255591']);
});
test('known yc id: record queries by id only, no phone scans; counters from freshest changed record', async () => {
  await cs.summary(3, { phone: '79200255591' });
  const rec = sqls().filter(q => /FROM records/.test(q));
  expect(rec.length).toBeGreaterThan(0);
  for (const q of rec) { expect(q).toMatch(/yclients_client_id=\$2/); expect(q).not.toMatch(/raw_payload->'client'->>'phone'/); }
  expect(sqls().some(q => /ORDER BY raw_payload->>'last_change_date' DESC/.test(q))).toBe(true);
});
test('unknown yc id: phone branch is bounded by date and uses the last 10 digits', async () => {
  setup({ client: null });
  await cs.summary(3, { phone: '79200255591' });
  const q = sqls().find(x => /FROM records/.test(x) && /raw_payload->'client'->>'phone'/.test(x));
  expect(q).toMatch(/visit_date >= CURRENT_DATE - 730/);
});
test('10-digit phone gets leading 7 for YClients', async () => {
  expect(cs.canonPhone('9200255591')).toBe('79200255591');
  await cs.summary(3, { phone: '9200255591' });
  expect(ycGetClientAbonements).toHaveBeenCalledWith(SALON, '79200255591');
});
test('abonements: expired and used-up dropped, frozen kept and marked, status passed', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  const out = cs.abonementsView([
    { type: { title: 'old' }, balance_container: { links: [{ count: 2 }] }, expiration_date: '2026-10-01' },
    { type: { title: 'empty' }, balance_container: { links: [{ count: 0 }] } },
    { type: { title: 'ice' }, is_frozen: true, status: { title: 'Заморожен' }, balance_container: { links: [{ count: 2 }] }, expiration_date: '2027-01-01' },
    { type: { title: 'inf' }, is_united_balance_unlimited: true },
  ], now);
  expect(out.map(a => a.title)).toEqual(['ice', 'inf']);
  expect(out[0]).toMatchObject({ frozen: true, status: 'Заморожен' });
});
test('record queries bind exactly the parameters they use (pg rejects extras)', async () => {
  await cs.summary(3, { phone: '79200255591' });
  for (const [sql, args] of db.any.mock.calls) expect(args).toHaveLength(2);
  for (const [sql, args] of db.oneOrNone.mock.calls.filter(c => /FROM records/.test(c[0]))) expect(args).toHaveLength(2);
});
