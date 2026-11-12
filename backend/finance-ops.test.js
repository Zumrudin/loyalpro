'use strict';
jest.mock('./db', () => ({ db: { query: jest.fn(), any: jest.fn(), oneOrNone: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/journal/reference-cache', () => ({
  getReference: jest.fn(async () => [
    { id: 1355177, title: 'Основная касса', type_slug: 'cash' },
    { id: 1355178, title: 'Расчетный счет', type_slug: 'cashless' },
  ]),
}));
const { db } = require('./db');
const fo = require('./services/finance-ops');

// Поддельный запрос: сценарий — список [регулярка SQL, ответ | функция]. Все вызовы пишутся в calls.
function fakeQ(script = []) {
  const calls = [];
  const q = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, answer] of script) {
      if (re.test(sql)) return typeof answer === 'function' ? answer(sql, params) : answer;
    }
    return { rows: [], rowCount: 0 };
  });
  q.calls = calls;
  return q;
}
const rows = (...r) => ({ rows: r, rowCount: r.length });
const upsertAnswer = inserted => ({ rows: [{ id: 1, inserted }], rowCount: 1 });

beforeEach(() => jest.clearAllMocks());

describe('classifiers', () => {
  test('revenue category -> kind', () => {
    expect(fo.revenueKind('services')).toBe('visit_payment');
    expect(fo.revenueKind('goods')).toBe('goods_sale');
    expect(fo.revenueKind('certificate')).toBe('certificate_sale');
    expect(fo.revenueKind('abonement')).toBe('abonement_sale');
    expect(fo.revenueKind('deposit')).toBe('deposit');
    expect(fo.revenueKind('other')).toBe('other_income');
    expect(fo.revenueKind(undefined)).toBe('other_income');
  });
  test('is_cash -> method', () => {
    expect(fo.revenueMethod(true)).toBe('cash');
    expect(fo.revenueMethod(false)).toBe('card');
    expect(fo.revenueMethod(null)).toBe('other');
  });
  test('account -> cash/card by type_slug from the accounts cache', () => {
    const accounts = [{ id: 1, title: 'Касса', type_slug: 'cash' }, { id: 2, title: 'Счёт', type_slug: 'cashless' }];
    expect(fo.accountMethod(accounts, 1)).toEqual({ method: 'cash', title: 'Касса' });
    expect(fo.accountMethod(accounts, '2')).toEqual({ method: 'card', title: 'Счёт' });
    expect(fo.accountMethod(accounts, 3)).toEqual({ method: 'other', title: null });
    expect(fo.accountMethod(null, 1).method).toBe('other');
  });
  test('loyalty transaction kinds', () => {
    const k = (amount, title, extra) => fo.classifyLoyaltyTxn({ amount, title, ...extra });
    expect(k(-500, 'Списание бонусов при оплате визита #123', { record_id: 5 })).toBe('bonus_redemption');
    expect(k(-500, 'Отмена кэшбэка за визит #123', { record_id: 5 })).toBe('bonus_adjustment');
    expect(k(-90, 'Отмена начисления', { record_id: 5 })).toBe('bonus_adjustment');
    expect(k(-100, 'Списание бонусов при отмене визита #1', { record_id: 5 })).toBe('bonus_adjustment');
    expect(k(120, 'Кэшбэк 5% за визит #123', { record_id: 5 })).toBe('bonus_accrual');
    expect(k(500, '🎂 Подарок на день рождения')).toBe('bonus_accrual');
    expect(k(300, 'Возврат бонусов при отмене оплаты визита #1')).toBe('bonus_accrual');
    expect(k(100, 'Ручная корректировка')).toBe('bonus_adjustment');
    expect(k(100, 'Ручная корректировка', {})).toBe('bonus_adjustment');
    expect(fo.classifyLoyaltyTxn({ amount: 10, title: 'Кэшбэк' }, { kind: 'bonus_adjustment' })).toBe('bonus_adjustment');
  });
  test('step status from package and step state', () => {
    expect(fo.stepStatus({ status: 'queued' }, { state: 'pending' })).toBe('queued');
    expect(fo.stepStatus({ status: 'queued', released_at: new Date() }, { state: 'pending' })).toBe('sending');
    expect(fo.stepStatus({ status: 'running', released_at: new Date() }, { state: 'pending' })).toBe('sending');
    expect(fo.stepStatus({ status: 'done' }, { state: 'done' })).toBe('confirmed');
    expect(fo.stepStatus({ status: 'failed' }, { state: 'failed' })).toBe('failed');
    expect(fo.stepStatus({ status: 'failed' }, { state: 'uncertain' })).toBe('failed');
    expect(fo.stepStatus({ status: 'cancelled' }, { state: 'pending' })).toBe('cancelled');
    expect(fo.stepStatus({ status: 'running' }, { state: 'done' })).toBe('confirmed');
  });
  test('journal_financial_transactions state', () => {
    expect(fo.journalStateStatus('confirmed')).toBe('confirmed');
    expect(fo.journalStateStatus('pending')).toBe('sending');
    expect(fo.journalStateStatus('rejected')).toBeNull();
    expect(fo.journalStateStatus('reviewed')).toBeNull();
  });
  test('Moscow date of a moment', () => {
    expect(fo.mskDate(new Date('2026-11-12T22:30:00Z'))).toBe('2026-11-13');
    expect(fo.mskDate('garbage')).toBeNull();
  });
});

describe('row builders', () => {
  const outbox = { id: 39, salon_id: 1, user_id: 4, yclients_record_id: 2100, created_at: '2026-11-12T06:42:00Z', status: 'queued' };
  const accounts = [{ id: 1355177, title: 'Основная касса', type_slug: 'cash' }, { id: 1355178, title: 'Расчетный счет', type_slug: 'cashless' }];
  test('bonus payment is a signed negative redemption, method bonus', () => {
    const op = fo.buildJournalOp(outbox, { kind: 'pay', opId: 'a', params: { method: 'loyalty_card', methodId: 9, amount: 6500 }, state: 'pending' }, { accounts });
    expect(op).toMatchObject({ kind: 'bonus_redemption', method: 'bonus', amount: -6500, status: 'queued', origin: 'journal', step_op_id: 'a', outbox_id: 39, user_id: 4, yclients_record_id: 2100, op_date: '2026-11-12' });
  });
  test('cash and card payments take the method from the account, amount is positive', () => {
    const cash = fo.buildJournalOp(outbox, { kind: 'pay', opId: 'b', params: { method: 'account', methodId: 1355177, amount: 100 } }, { accounts });
    expect(cash).toMatchObject({ kind: 'visit_payment', method: 'cash', amount: 100, account_id: 1355177, account_title: 'Основная касса' });
    const card = fo.buildJournalOp(outbox, { kind: 'pay', opId: 'c', params: { method: 'account', methodId: 1355178, amount: 58500 } }, { accounts });
    expect(card).toMatchObject({ method: 'card', amount: 58500, account_title: 'Расчетный счет' });
  });
  test('payment removal flips the sign: bonus returns (+), money leaves (-)', () => {
    const b = fo.buildJournalOp(outbox, { kind: 'remove_payment', opId: 'd', params: { method: 'loyalty_card', methodId: 9, amount: 300, transactionId: 1 } }, { accounts });
    expect(b).toMatchObject({ kind: 'payment_reversal', method: 'bonus', amount: 300 });
    const m = fo.buildJournalOp(outbox, { kind: 'remove_payment', opId: 'e', params: { method: 'account', methodId: 1355178, amount: 300, transactionId: 2 } }, { accounts });
    expect(m).toMatchObject({ kind: 'payment_reversal', method: 'card', amount: -300 });
  });
  test('non-money steps, zero amounts and unknown methods give no row', () => {
    expect(fo.buildJournalOp(outbox, { kind: 'edit', opId: 'x', params: {} })).toBeNull();
    expect(fo.buildJournalOp(outbox, { kind: 'pay', opId: 'x', params: { method: 'account', methodId: 1, amount: 0 } })).toBeNull();
    expect(fo.buildJournalOp(outbox, { kind: 'pay', opId: 'x', params: { method: 'cheque', methodId: 1, amount: 5 } })).toBeNull();
  });
  test('done step carries its operation id as journal link', () => {
    const op = fo.buildJournalOp(outbox, { kind: 'pay', opId: 'f', params: { method: 'account', methodId: 1355177, amount: 1 }, state: 'done' }, { accounts });
    expect(op).toMatchObject({ status: 'confirmed', journal_operation_id: 'f' });
  });
  test('revenue row: Yclients date 1970 falls back to the receive time', () => {
    const op = fo.buildRevenueOp({ id: 7, salon_id: 1, yclients_operation_id: 99, category: 'services', amount: '27000.00', operation_at: '1970-01-01T01:00:00Z', created_at: '2026-11-10T09:00:00Z', is_cash: false, account_title: 'Расчетный счет', expense_title: 'Оказание услуг', yclients_record_id: 5 });
    expect(op).toMatchObject({ kind: 'visit_payment', method: 'card', amount: 27000, op_date: '2026-11-10', revenue_operation_id: 7, yclients_operation_id: 99, status: 'confirmed', origin: 'yclients' });
    expect(fo.buildRevenueOp({ id: 8, salon_id: 1, category: 'goods', amount: 0, operation_at: new Date() })).toBeNull();
    expect(fo.buildRevenueOp({ id: 8, salon_id: 1, category: 'goods', amount: 5, operation_at: new Date(), is_cash: true }, { origin: 'backfill' }).origin).toBe('backfill');
  });
  test('loyalty row keeps the stored sign and links the record', () => {
    const op = fo.buildLoyaltyOp({ id: 11, salon_id: 1, client_id: 3, amount: '-650', title: 'Списание бонусов при оплате визита #5', record_id: 10, txn_date: '2026-11-11T18:20:00Z' }, {}, { yclients_record_id: 5, yclients_client_id: 77 });
    expect(op).toMatchObject({ kind: 'bonus_redemption', method: 'bonus', amount: -650, loyalty_txn_id: 11, yclients_record_id: 5, yclients_client_id: 77, origin: 'loyalpro' });
    expect(fo.buildLoyaltyOp({ id: 12, salon_id: 1, amount: 0 })).toBeNull();
  });
});

describe('upsert is idempotent and never rewrites amounts', () => {
  const op = () => fo.buildLoyaltyOp({ id: 11, salon_id: 1, client_id: 3, amount: 100, title: 'Кэшбэк 5% за визит #5' });
  test('ON CONFLICT targets the unique key and updates only status and links', () => {
    for (const key of ['step_op_id', 'revenue_operation_id', 'loyalty_txn_id', 'journal_operation_id']) {
      const sql = fo.upsertSql(key);
      expect(sql).toContain(`ON CONFLICT (salon_id,${key}) WHERE ${key} IS NOT NULL DO UPDATE SET`);
      const update = sql.split('DO UPDATE SET')[1];
      expect(update).not.toMatch(/\bamount\s*=/);
      expect(update).not.toMatch(/\bkind\s*=/);
      expect(update).not.toMatch(/\boccurred_at\s*=/);
      expect(update).not.toMatch(/\bmethod\s*=/);
      expect(update).toMatch(/status=CASE WHEN finance_operations\.status='confirmed' THEN 'confirmed'/);
      expect(update).toMatch(/COALESCE\(finance_operations\.client_id,EXCLUDED\.client_id\)/);
    }
  });
  test('returns inserted on first call and updated on the repeat; parameters follow the column order', async () => {
    const q = fakeQ([[/INSERT INTO finance_operations/, upsertAnswer(true)]]);
    const first = await fo.upsertOp(op(), { q });
    expect(first.action).toBe('inserted');
    q.mockImplementationOnce(async () => upsertAnswer(false));
    expect((await fo.upsertOp(op(), { q })).action).toBe('updated');
    const params = q.calls[0].params;
    expect(params).toHaveLength(22);
    expect(params[0]).toBe(1);         // salon_id
    expect(params[3]).toBe('bonus_accrual');
    expect(params[5]).toBe(100);       // amount
    expect(q.calls[0].sql).toContain('ON CONFLICT (salon_id,loyalty_txn_id)');
  });
  test('key priority: step, revenue, loyalty, journal', async () => {
    const q = fakeQ([[/INSERT INTO finance_operations/, upsertAnswer(true)]]);
    await fo.upsertOp({ ...op(), loyalty_txn_id: null, step_op_id: 's', kind: 'visit_payment', method: 'cash', status: 'queued', origin: 'journal' }, { q });
    expect(q.calls[0].sql).toContain('ON CONFLICT (salon_id,step_op_id)');
  });
  test('refuses rows outside the CHECK domain or without a key', async () => {
    const q = fakeQ();
    await expect(fo.upsertOp({ ...op(), kind: 'bogus' }, { q })).rejects.toThrow(/недопустимые/);
    await expect(fo.upsertOp({ ...op(), status: 'done' }, { q })).rejects.toThrow(/недопустимые/);
    await expect(fo.upsertOp({ ...op(), origin: 'x' }, { q })).rejects.toThrow(/недопустимые/);
    await expect(fo.upsertOp({ ...op(), method: 'gold' }, { q })).rejects.toThrow(/недопустимые/);
    await expect(fo.upsertOp({ ...op(), loyalty_txn_id: null }, { q })).rejects.toThrow(/ключ/);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('matching external rows with our journal payments (link, do not duplicate)', () => {
  const rev = { id: 50, salon_id: 1, yclients_operation_id: 900, category: 'services', amount: '27000.00', operation_at: '2026-11-10T09:00:00Z', is_cash: false, client_id: 3, yclients_client_id: 77, yclients_record_id: 2132511195, expense_title: 'Оказание услуг' };
  test('revenue operation of a visit links to the unlinked confirmed journal payment', async () => {
    const q = fakeQ([
      [/revenue_operation_id=\$2/, rows()],                                   // не известна
      [/FROM finance_operations WHERE salon_id=\$1 AND origin='journal' AND kind='visit_payment'/, rows({ id: 7 })],
      [/UPDATE finance_operations SET/, rows({ id: 7, revenue_operation_id: 50 })],
    ]);
    const r = await fo.recordRevenueOp(rev, { q });
    expect(r.action).toBe('linked');
    const find = q.calls.find(c => /origin='journal' AND kind='visit_payment'/.test(c.sql));
    expect(find.sql).toMatch(/status IN \('sending','confirmed'\)/);
    expect(find.sql).toMatch(/revenue_operation_id IS NULL/);
    expect(find.sql).toMatch(/BETWEEN \(\$5::date - 1\) AND \(\$5::date \+ 1\)/);
    expect(find.params).toEqual([1, 2132511195, 27000, 'card', '2026-11-10']);
    expect(q.calls.some(c => /INSERT INTO finance_operations/.test(c.sql))).toBe(false);
  });
  test('no matching journal row: a standalone row is inserted', async () => {
    const q = fakeQ([[/INSERT INTO finance_operations/, upsertAnswer(true)]]);
    const r = await fo.recordRevenueOp(rev, { q });
    expect(r.action).toBe('inserted');
  });
  test('already known revenue row is only upserted (no matching query, no duplicate)', async () => {
    const q = fakeQ([[/revenue_operation_id=\$2/, rows({ id: 3 })], [/INSERT INTO finance_operations/, upsertAnswer(false)]]);
    expect((await fo.recordRevenueOp(rev, { q })).action).toBe('updated');
    expect(q.calls.some(c => /origin='journal'/.test(c.sql))).toBe(false);
  });
  test('goods sale or cash-less unknown method never links to a visit payment', async () => {
    const q = fakeQ([[/INSERT INTO finance_operations/, upsertAnswer(true)]]);
    await fo.recordRevenueOp({ ...rev, category: 'goods' }, { q });
    await fo.recordRevenueOp({ ...rev, id: 51, is_cash: null }, { q });
    expect(q.calls.some(c => /origin='journal'/.test(c.sql))).toBe(false);
  });
  test('bonus redemption links to the confirmed journal bonus payment of the same visit and amount', async () => {
    const lct = { id: 60, salon_id: 1, client_id: 3, type: 'redemption', amount: '-650', title: 'Списание бонусов при оплате визита #2121358890', record_id: 10799, txn_date: '2026-11-11T18:20:00Z' };
    const q = fakeQ([
      [/FROM records WHERE salon_id=\$1 AND id=\$2/, rows({ yclients_record_id: '2121358890' })],
      [/FROM clients WHERE id=\$1/, rows({ yclients_client_id: '77' })],
      [/loyalty_txn_id=\$2/, rows()],
      [/origin='journal' AND method='bonus'/, rows({ id: 8 })],
      [/UPDATE finance_operations SET/, rows({ id: 8 })],
    ]);
    const r = await fo.recordLoyaltyTxn(lct, {}, { q });
    expect(r.action).toBe('linked');
    const find = q.calls.find(c => /origin='journal' AND method='bonus'/.test(c.sql));
    expect(find.params).toEqual([1, 2121358890, -650, 3]);
    expect(find.sql).toMatch(/loyalty_txn_id IS NULL/);
    expect(q.calls.some(c => /INSERT INTO finance_operations/.test(c.sql))).toBe(false);
  });
  test('loyalty row without a visit is inserted as is (cashback, birthday, manual)', async () => {
    const q = fakeQ([[/INSERT INTO finance_operations/, upsertAnswer(true)]]);
    const r = await fo.recordLoyaltyTxn({ id: 61, salon_id: 1, client_id: 3, amount: 500, title: '🎂 Подарок на день рождения', created_at: new Date() }, { origin: 'loyalpro', kind: 'bonus_accrual' }, { q });
    expect(r.action).toBe('inserted');
    expect(q.calls.some(c => /origin='journal'/.test(c.sql))).toBe(false);
  });
});

describe('status changes', () => {
  test('markStep never downgrades confirmed and fills links', async () => {
    const q = fakeQ([[/UPDATE finance_operations f SET\s+status=CASE/, rows({ id: 1, origin: 'journal', kind: 'bonus_redemption', method: 'bonus', status: 'confirmed', client_id: 3, yclients_record_id: 5, loyalty_txn_id: null, amount: '-100', salon_id: 1 })]]);
    const row = await fo.markStep(1, 'op-1', 'confirmed', { journalOperationId: 'op-1', yclientsRecordId: 5, q });
    expect(row.id).toBe(1);
    const upd = q.calls[0];
    expect(upd.sql).toMatch(/CASE WHEN f\.status='confirmed' THEN f\.status ELSE \$3 END/);
    expect(upd.params).toEqual([1, 'op-1', 'confirmed', 'op-1', 5]);
    // confirmed: ищет самостоятельную бонусную строку (дубль, пришедший раньше), чтобы слить её
    expect(q.calls.some(c => /step_op_id IS NULL/.test(c.sql) && /loyalty_txn_id IS NOT NULL/.test(c.sql))).toBe(true);
  });
  test('markStep on an unknown step returns null (reconcile adds it later)', async () => {
    const q = fakeQ();
    expect(await fo.markStep(1, 'nope', 'failed', { q })).toBeNull();
  });
  test('markStep rejects statuses outside the domain', async () => {
    await expect(fo.markStep(1, 'x', 'done', { q: fakeQ() })).rejects.toThrow();
  });
  test('absorbing a standalone duplicate moves its link to the journal row and deletes it', async () => {
    const journal = { id: 1, salon_id: 1, origin: 'journal', kind: 'visit_payment', method: 'card', amount: '27000', yclients_record_id: 5, revenue_operation_id: null, occurred_at: '2026-11-10T09:00:00Z' };
    const q = fakeQ([
      [/step_op_id IS NULL\s+AND revenue_operation_id IS NOT NULL/, rows({ id: 2, link: 50, yc: 900 })],
      [/UPDATE finance_operations SET/, rows({ ...journal, revenue_operation_id: 50 })],
    ]);
    const out = await fo.absorbStandalone(q, journal);
    expect(out.revenue_operation_id).toBe(50);
    const del = q.calls.findIndex(c => /DELETE FROM finance_operations/.test(c.sql));
    const upd = q.calls.findIndex(c => /UPDATE finance_operations SET/.test(c.sql));
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(upd);      // сначала снимаем уникальный ключ с дубля
  });
  test('markOutbox moves only open rows between allowed statuses', async () => {
    const q = fakeQ([[/UPDATE finance_operations SET status=\$3/, { rows: [], rowCount: 2 }]]);
    expect(await fo.markOutbox(1, [5, '6'], 'sending', { q })).toBe(2);
    expect(q.calls[0].params).toEqual([1, [5, 6], 'sending', ['queued', 'failed']]);
    expect(await fo.markOutbox(1, [5], 'cancelled', { q })).toBe(2);
    expect(q.calls[1].params[3]).toEqual(['queued', 'sending', 'failed']);
    expect(await fo.markOutbox(1, [], 'sending', { q })).toBe(0);
    expect(await fo.markOutbox(1, [5], 'confirmed', { q })).toBe(0);   // подтверждение — только markStep
  });
  test('revenue deletion cancels standalone rows and unlinks journal rows', async () => {
    const q = fakeQ([[/SET status='cancelled'/, { rows: [], rowCount: 1 }], [/SET revenue_operation_id=NULL/, { rows: [], rowCount: 1 }]]);
    expect(await fo.cancelRevenueOp(1, 900, { q })).toEqual({ cancelled: 1, unlinked: 1 });
    expect(q.calls[0].sql).toMatch(/step_op_id IS NULL/);
    expect(q.calls[1].sql).toMatch(/step_op_id IS NOT NULL/);
  });
  test('retry re-keys the failed step and leaves confirmed rows alone', async () => {
    const q = fakeQ([[/UPDATE finance_operations SET step_op_id/, { rows: [{ id: 1 }], rowCount: 1 }]]);
    expect(await fo.rekeyStep(1, 'old', 'new', { q })).toBe(1);
    expect(q.calls[0].sql).toMatch(/status<>'confirmed'/);
    expect(q.calls[0].params).toEqual([1, 'old', 'new']);
  });
});

describe('journal package recording', () => {
  test('records only pay/remove_payment steps, status queued, client from the mirror', async () => {
    const q = fakeQ([
      [/FROM records WHERE salon_id=\$1 AND yclients_record_id=\$2/, rows({ client_id: 3, yclients_client_id: 77 })],
      [/INSERT INTO finance_operations/, upsertAnswer(true)],
    ]);
    const row = { id: 39, salon_id: 1, user_id: 4, yclients_record_id: 2100, created_at: new Date(), status: 'queued' };
    const steps = [
      { kind: 'edit', opId: 'e', params: {} },
      { kind: 'pay', opId: 'p1', params: { method: 'loyalty_card', methodId: 9, amount: 6500 }, state: 'pending' },
      { kind: 'pay', opId: 'p2', params: { method: 'account', methodId: 1355178, amount: 58500 }, state: 'pending' },
    ];
    const out = await fo.recordJournalPackage(row, steps, { q });
    expect(out).toHaveLength(2);
    const inserts = q.calls.filter(c => /INSERT INTO finance_operations/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[3]).toBe('bonus_redemption');
    expect(inserts[0].params[5]).toBe(-6500);
    expect(inserts[0].params[6]).toBe('queued');
    expect(inserts[0].params[10]).toBe(3);                // client_id
    expect(inserts[1].params[4]).toBe('card');            // Расчетный счет из кэша
    expect(inserts[1].params[5]).toBe(58500);
  });
});

describe('a failing ledger never breaks the money path', () => {
  const failing = jest.fn(async () => { throw Object.assign(new Error('relation "finance_operations" does not exist'), { code: '42P01' }); });
  test('safely swallows errors and returns null', async () => {
    await expect(fo.safely('t1', () => fo.markStep(1, 'x', 'confirmed', { q: failing }))).resolves.toBeNull();
    await expect(fo.safely('t2', async () => { throw new Error('boom'); })).resolves.toBeNull();
    await expect(fo.safely('t3', () => fo.recordLoyaltyTxn({ id: 1, salon_id: 1, amount: 5 }, {}, { q: failing }))).resolves.toBeNull();
    await expect(fo.safely('t4', () => fo.recordRevenueOp({ id: 1, salon_id: 1, category: 'services', amount: 5, operation_at: new Date() }, { q: failing }))).resolves.toBeNull();
  });
  test('safely passes the result through', async () => {
    await expect(fo.safely('ok', async () => 42)).resolves.toBe(42);
  });
  test('revenue webhook still reports the inserted row when the ledger write fails', async () => {
    db.oneOrNone.mockResolvedValue(null);
    db.query.mockImplementation(async sql => {
      if (/INSERT INTO revenue_operations/.test(sql)) return { rowCount: 1, rows: [{ id: 5, salon_id: 1, yclients_operation_id: 9, category: 'services', amount: '100', operation_at: new Date(), is_cash: true }] };
      throw new Error('finance_operations unavailable');
    });
    const { recordRevenueOperation } = require('./services/revenue');
    const payload = { status: 'create', data: { id: 9, amount: 100, date: '2026-11-10T10:00:00+03:00', expense: { title: 'Оказание услуг' } } };
    await expect(recordRevenueOperation(payload, { id: 1 }, 'webhook')).resolves.toBe(true);
  });
  test('revenue delete webhook still returns when cancelling in the ledger fails', async () => {
    db.query.mockImplementation(async sql => {
      if (/DELETE FROM revenue_operations/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('finance_operations unavailable');
    });
    const { recordRevenueOperation } = require('./services/revenue');
    await expect(recordRevenueOperation({ status: 'delete', data: { id: 9 } }, { id: 1 }, 'webhook')).resolves.toBe(false);
  });
  test('dispatch release still answers when marking steps as sending fails', async () => {
    const d = require('./services/journal/dispatch');
    db.any.mockImplementation(async (sql, args) => {
      if (sql === d.PERIOD_SQL) return [{ id: '5', grp: 'r1' }];
      if (sql === d.RELEASE_SQL) return args[2].map(id => ({ id }));
      return [];
    });
    db.query.mockRejectedValue(new Error('finance_operations unavailable'));
    const r = await d.release(1, { from: '2026-11-10', to: '2026-11-10' });
    expect(r).toMatchObject({ packages: 1 });
  });
});

describe('reconcile', () => {
  test('re-runs the same upserts over the last days for one salon and cancels deleted revenue rows', async () => {
    db.any.mockResolvedValue([]);
    db.query.mockImplementation(async sql => {
      if (/UPDATE finance_operations f SET status='cancelled'/.test(sql)) return { rows: [], rowCount: 2 };
      if (/UPDATE finance_operations SET status='cancelled'/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await fo.reconcile({ salonId: 1, days: 7, now: new Date('2026-11-12T01:50:00Z') });
    expect(out).toMatchObject({ salons: 1, cancelled: 3, errors: 0 });
    const sources = db.query.mock.calls.map(c => c[0]);
    expect(sources.some(s => /FROM journal_outbox o/.test(s))).toBe(true);
    expect(sources.some(s => /FROM journal_financial_transactions f/.test(s))).toBe(true);
    expect(sources.some(s => /FROM revenue_operations/.test(s))).toBe(true);
    expect(sources.some(s => /FROM loyalty_card_transactions/.test(s))).toBe(true);
    const outboxCall = db.query.mock.calls.find(c => /FROM journal_outbox o/.test(c[0]));
    expect(outboxCall[1][0]).toBe(1);
    expect(outboxCall[1][1].toISOString()).toBe('2026-11-05T01:50:00.000Z');
  });
});
