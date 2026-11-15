'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetClientCardsStrict: jest.fn(), ycGetClientAbonements: jest.fn(), ycSearchClientIdByPhone: jest.fn() }));
jest.mock('./services/journal/client-summary', () => ({ resolveClient: jest.fn() }));
const { db } = require('./db');
const yc = require('./services/yclients');
const cs = require('./services/journal/client-summary');
const L = require('./services/journal/client-loyalty');
const SALON = { id: 3, yclients_company_id: 77 };
const NOW = new Date('2026-11-13T09:00:00Z');
const CARD = { id: 112, balance: 8592, number: '0065', type: { title: 'samosale' }, salon_group: { title: 'Сеть Peri Clinic' }, sold_amount: 737946, paid_amount: 737946, visits_count: 27, max_discount_percent: 0 };
const AB = { id: 2, number: '804644', type: { title: 'RSL 6', expiration_type_title: 'При первом посещении' }, status: { slug: 'activated', title: 'Активирован' },
  created_date: '2026-09-26T10:00:00+04:00', activated_date: '2026-09-26T10:00:00+04:00', expiration_date: '2027-09-25T00:00:00+04:00',
  is_united_balance: true, united_balance_services_count: 2,
  balance_container: { links: [{ count: 0, service: { title: 'BEAUTYLISER RSL' } }, { count: 0, category: { title: 'RSL-скульптурирование' } }] } };
beforeEach(() => {
  jest.clearAllMocks();
  cs.resolveClient.mockResolvedValue({ salon: SALON, client: { id: 10 }, yc: 555, ph: '79200255591' });
  db.oneOrNone.mockResolvedValue({ yclients_card_id: 112 });
  db.any.mockResolvedValue([{ yclients_card_id: null, txn_date: new Date('2026-11-13T07:00:00Z'), amount: '-650', title: 'Списание' },
    { yclients_card_id: 999, txn_date: new Date('2026-11-01T07:00:00Z'), amount: '100', title: 'Чужая карта' }]);
  yc.ycGetClientCardsStrict.mockResolvedValue([CARD]);
  yc.ycGetClientAbonements.mockResolvedValue([AB, { ...AB, id: 5, united_balance_services_count: 0 }, { ...AB, id: 6, expiration_date: '2026-01-01T00:00:00+04:00' }]);
  yc.ycGet.mockResolvedValue([{ id: 7, number: '508763', balance: 20000, default_balance: 20000, status: { slug: 'active', title: 'Активирован' }, type: { title: 'Сертификат 20000', item_type: { title: 'Любые товары и услуги' } } },
    { id: 8, balance: 0, status: { slug: 'active' }, type: { title: 'Потраченный' } }]);
});
test('cards, abonements and certificates with active flags; history of the linked card only', async () => {
  const out = await L.load(3, { phone: '79200255591' }, { now: NOW });
  expect(out.clientId).toBe(10); expect(out.errors).toEqual({});
  expect(out.cards).toHaveLength(1);
  expect(out.cards[0]).toMatchObject({ title: 'samosale', number: '0065', balance: 8592, linked: true, active: true, visits: 27,
    history: [{ date: '2026-11-13', title: 'Списание', amount: -650 }] });
  expect(out.abonements.map(a => a.active)).toEqual([true, false, false]);
  expect(out.abonements[0]).toMatchObject({ balance: 2, created: '2026-09-26', expires: '2027-09-25',
    services: [{ category: '', service: 'BEAUTYLISER RSL', count: 0 }, { category: 'RSL-скульптурирование', service: 'Все услуги', count: 0 }] });
  expect(out.certificates.map(c => c.active)).toEqual([true, false]);
  expect(yc.ycGet).toHaveBeenCalledWith(SALON, '/loyalty/certificates/', { company_id: 77, phone: '79200255591' });
  for (const [, args] of [...db.any.mock.calls, ...db.oneOrNone.mock.calls]) expect(args[0]).toBe(3);
});
test('a failing part is null with its error; the rest still answers', async () => {
  yc.ycGetClientCardsStrict.mockRejectedValue(new Error('boom'));
  yc.ycGet.mockRejectedValue(new Error('boom'));
  const out = await L.load(3, { phone: '79200255591' }, { now: NOW });
  expect(out.cards).toBe(null); expect(out.certificates).toBe(null); expect(out.abonements).toHaveLength(3);
  expect(Object.keys(out.errors).sort()).toEqual(['cards', 'certificates']);
});
test('no YClients client id: searched by phone; not found → no cards', async () => {
  cs.resolveClient.mockResolvedValue({ salon: SALON, client: null, yc: null, ph: '79200255591' });
  yc.ycSearchClientIdByPhone.mockResolvedValue(null);
  const out = await L.load(3, { phone: '79200255591' }, { now: NOW });
  expect(out.cards).toEqual([]); expect(yc.ycGetClientCardsStrict).not.toHaveBeenCalled(); expect(db.any).not.toHaveBeenCalled();
});
test('an unmatched YClients client id is rejected before the company-less cards request', async () => {
  cs.resolveClient.mockResolvedValue({ salon: SALON, client: null, yc: 999999, ph: null });
  await expect(L.load(3, { ycClientId: '999999' }, { now: NOW })).rejects.toMatchObject({ status: 404 });
  expect(yc.ycGetClientCardsStrict).not.toHaveBeenCalled();
  expect(yc.ycSearchClientIdByPhone).not.toHaveBeenCalled();
  expect(yc.ycGetClientAbonements).not.toHaveBeenCalled();
  expect(yc.ycGet).not.toHaveBeenCalled();
});
test('used-up and expired-status items are inactive; unlimited abonement is active', () => {
  expect(L.abonementView({ ...AB, is_united_balance_unlimited: true, united_balance_services_count: 0 }, '2026-11-13').active).toBe(true);
  expect(L.abonementView({ ...AB, status: { slug: 'expired' } }, '2026-11-13').active).toBe(false);
  expect(L.certificateView({ balance: 5, status: { slug: 'expired' } }, '2026-11-13').active).toBe(false);
  expect(L.certificateView({ balance: 5, expiration_date: '2026-11-12' }, '2026-11-13').active).toBe(false);
});

test('a foreign id paired with a local phone uses the company-scoped lookup', async () => {
  cs.resolveClient.mockResolvedValue({ salon: SALON, client: { id: 10, yclients_client_id: 555 }, yc: 999999, ph: '79000000001' });
  yc.ycSearchClientIdByPhone.mockResolvedValue(555);
  await L.load(3, { ycClientId: '999999', phone: '79000000001' }, { now: NOW });
  expect(yc.ycSearchClientIdByPhone).toHaveBeenCalledWith(SALON, '79000000001');
  expect(yc.ycGetClientCardsStrict).toHaveBeenCalledWith(SALON, 555);
  expect(yc.ycGetClientCardsStrict).not.toHaveBeenCalledWith(SALON, 999999);
});
