'use strict';
const mockPgQuery = jest.fn();
const mockLinkCard = jest.fn();

jest.mock('./middleware/auth', () => ({ auth: (req, _res, next) => next() }));
jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() },
  pool: { connect: jest.fn(async () => ({ query: mockPgQuery, release: jest.fn() })) },
}));
jest.mock('./services/finance-ops', () => ({ safely: jest.fn(), recordLoyaltyTxn: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetCardTransactions: jest.fn(), ycWebSessions: jest.fn() }));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: jest.fn(async () => ({})), runSync: jest.fn(), sleep: jest.fn(), linkClientCard: mockLinkCard,
}));
const { db } = require('./db');
const router = require('./routes/clients');

function handler(path, method) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[String(method).toLowerCase()]);
  if (!layer) throw new Error('Missing route');
  return layer.route.stack.at(-1).handle;
}
async function invoke(path, method = 'GET', extra = {}) {
  const req = { params: { id: '10' }, query: {}, body: {}, user: { salonId: 1, userId: 7 }, ...extra };
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  await handler(path, method)(req, res);
  return { req, res };
}
beforeEach(() => {
  jest.clearAllMocks();
  db.any.mockResolvedValue([]);
  db.oneOrNone.mockResolvedValue(null);
  mockPgQuery.mockResolvedValue({ rows: [] });
});

test('detail scopes transaction history and bookings to the same salon', async () => {
  db.oneOrNone.mockResolvedValue({ id: 10, salon_id: 1 });
  const { res } = await invoke('/:id');
  expect(res.json).toHaveBeenCalled();
  expect(db.any).toHaveBeenCalledTimes(2);
  for (const [sql, params] of db.any.mock.calls) {
    expect(sql).toContain('salon_id=$2');
    expect(params).toEqual(['10', 1]);
  }
});

test('foreign client cannot receive a manual bonus or a card sync', async () => {
  const bonus = await invoke('/:id/bonus', 'POST', { body: { amount: 10 } });
  expect(bonus.res.status).toHaveBeenCalledWith(404);
  expect(mockPgQuery).toHaveBeenCalledWith('SELECT * FROM clients WHERE id=$1 AND salon_id=$2 FOR UPDATE', ['10', 1]);
  expect(mockPgQuery.mock.calls.some(([sql]) => /INSERT INTO|UPDATE clients/.test(sql))).toBe(false);
  expect(mockPgQuery).toHaveBeenCalledWith('ROLLBACK');

  const card = await invoke('/:id/card-transactions');
  expect(card.res.status).toHaveBeenCalledWith(404);
  const sync = await invoke('/:id/sync-card', 'POST', { body: { salonId: 2 } });
  expect(sync.res.status).toHaveBeenCalledWith(404);
  expect(mockLinkCard).not.toHaveBeenCalled();
});

test('card history cannot read transactions through a global client id', async () => {
  db.oneOrNone.mockResolvedValue({ id: 10, salon_id: 1 });
  await invoke('/:id/card-transactions');
  expect(db.any).toHaveBeenCalledTimes(2);
  for (const [sql, params] of db.any.mock.calls) {
    expect(sql).toContain('salon_id=$2');
    expect(params).toEqual([10, 1]);
  }
});

test('card sync gets credentials and transaction count only from the current salon', async () => {
  db.oneOrNone.mockResolvedValue({ id: 10, salon_id: 1, yclients_client_id: 55 });
  db.one.mockResolvedValueOnce({ id: 1, yclients_card_type_id: 20 }).mockResolvedValueOnce({ count: '0' });
  mockLinkCard.mockResolvedValue({ yclients_card_balance: 0 });
  const { res } = await invoke('/:id/sync-card', 'POST', { body: { salonId: 2, yclients_company_id: '999' } });
  expect(res.status).not.toHaveBeenCalled();
  expect(db.one.mock.calls[0][1]).toEqual([1]);
  expect(mockLinkCard).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 10 }), {});
  expect(db.one.mock.calls[1][1]).toEqual([10, 1]);
});
