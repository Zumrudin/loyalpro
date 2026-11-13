'use strict';
// Opt-in isolated PostgreSQL integration. Never consumes DATABASE_URL/.env.
// MAX_LOYALTY_TEST_SOCKET must be a temporary test cluster's UNIX socket dir.
jest.mock('./config', () => ({ BONUS_LEDGER_PRIMARY: true, MAX_LOYALTY_BOT: {} }));
jest.mock('./db', () => ({ db: { query: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const configModule = require('./config');
const { db } = require('./db');
const { MAX_LOYALTY_DDL, FINANCE_OPS_DDL } = require('./migrations');
const { enqueue, createStore } = require('./services/max-loyalty/store');
const { tick, LOCK_NAMESPACE } = require('./services/max-loyalty/worker');
const { createMirror } = require('./services/max-loyalty/mirror');
const socket = process.env.MAX_LOYALTY_TEST_SOCKET;
const integration = socket ? describe : describe.skip;

integration('MAX loyalty: real PostgreSQL queue, restart, locks and ledger', () => {
  let pool, seq = 0;
  const cfg = { enabled: true, salonId: 1, token: 'synthetic', webhookSecret: 'x'.repeat(32) };
  beforeAll(async () => {
    if (!/^\/tmp\/max-loyalty-test-[A-Za-z0-9]+$/.test(socket)) throw new Error('Refusing non-test database');
    const schema = `max_loyalty_${process.pid}_${Date.now()}`;
    pool = new Pool({ host: socket, port: 55439, database: 'postgres', user: 'postgres', max: 5,
      options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(fs.readFileSync(path.join(__dirname, 'scripts/bootstrap-base-schema.sql'), 'utf8'));
    await pool.query(FINANCE_OPS_DDL);
    await pool.query(MAX_LOYALTY_DDL);
    await pool.query(MAX_LOYALTY_DDL); // Actual idempotent migration check.
    await pool.query("INSERT INTO salons(id,name) VALUES(1,'Synthetic A'),(2,'Synthetic B')");
    db.query.mockImplementation((sql, params) => pool.query(sql, params));
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(() => { configModule.BONUS_LEDGER_PRIMARY = true; });
  const input = (userId, text = '', extra = {}) => ({ key: String(++seq).padStart(64, '0'), userId: String(userId), type: 'message_created', text, ...extra });
  function external() {
    let cards = [];
    const crm = {
      search: jest.fn(async () => null), cardType: jest.fn(async () => '3'),
      createClient: jest.fn(async () => ({ id: 700 + seq })),
      cards: jest.fn(async () => structuredClone(cards)),
      cardNumber: () => 1234567,
      createCard: jest.fn(async (_p, type, number) => { cards = [{ id: 900 + seq, type: { id: type }, number, balance: 0 }]; }),
      accrue: jest.fn(async () => { cards[0].balance += 500; }),
      client: jest.fn(),
    };
    return { crm, api: { send: jest.fn(async () => ({})) } };
  }
  async function run(f, config = cfg) {
    await tick({ pool, config, makeCrm: () => f.crm, makeApi: () => f.api });
  }
  async function ageReplies() {
    // Advance only synthetic sent timestamps instead of sleeping for pacing.
    await pool.query("UPDATE max_loyalty_events SET updated_at=NOW()-INTERVAL '2 seconds' WHERE status='done'");
  }
  async function send(f, event) {
    await ageReplies();
    await enqueue(1, event);
    await run(f);
  }

  test('duplicate delivery is persisted once; same id across salons is independent', async () => {
    const event = input(101, '/start');
    await Promise.all([enqueue(1, event), enqueue(1, event), enqueue(2, event)]);
    const rows = (await pool.query('SELECT salon_id,COUNT(*) FROM max_loyalty_events WHERE event_key=$1 GROUP BY salon_id ORDER BY salon_id', [event.key])).rows;
    expect(rows).toEqual([{ salon_id: 1, count: '1' }, { salon_id: 2, count: '1' }]);
    const f = external();
    await run(f);
    expect(f.api.send).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT status FROM max_loyalty_events WHERE salon_id=2 AND event_key=$1', [event.key])).rows[0].status).toBe('pending');
  });
  test('restart between questionnaire steps; one welcome txn and correct ledger', async () => {
    const f = external(), phone = '70000000011';
    await send(f, input(102, '/start'));
    await send(f, input(102, '', { phone }));
    await send(f, input(102, 'Синтетический клиент'));
    const birthday = input(102, '29.02.2000');
    await send(f, birthday);
    await enqueue(1, birthday);
    await run(f);
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
    const r = (await pool.query('SELECT state,synced FROM max_loyalty_registrations WHERE salon_id=1 AND phone=$1', [phone])).rows[0];
    expect(r.state.welcome).toBe(true);
    expect(r.synced).toBe(true);
    const c = (await pool.query('SELECT * FROM clients WHERE salon_id=1 AND yclients_client_id=$1', [r.state.clientId])).rows[0];
    expect(c.bonus_balance).toBe(500);
    const txns = (await pool.query('SELECT * FROM finance_operations WHERE salon_id=1 AND client_id=$1 ORDER BY id', [c.id])).rows;
    expect(txns.filter(t => t.kind === 'bonus_accrual')).toHaveLength(1);
    expect(txns.filter(t => t.kind === 'bonus_opening')).toHaveLength(1);
    expect(txns.reduce((s, t) => s + Number(t.amount), 0)).toBe(500);
    const client = await pool.connect();
    try {
      await createMirror(createStore(client, 1), 1).sync(phone, r.state, (await f.crm.cards())[0]);
    } finally { client.release(); }
    expect((await pool.query('SELECT COUNT(*) FROM loyalty_card_transactions WHERE salon_id=1 AND client_id=$1', [c.id])).rows[0].count).toBe('1');
    expect((await pool.query('SELECT COUNT(*) FROM max_loyalty_events WHERE salon_id=1 AND user_id=102 AND (payload IS NOT NULL OR reply IS NOT NULL)')).rows[0].count).toBe('0');
  });
  test('salon advisory lock prevents a second worker from entering CRM', async () => {
    const connection = await pool.connect();
    const f = external();
    await enqueue(1, input(103, '/start'));
    try {
      await connection.query('SELECT pg_advisory_lock($1,$2)', [LOCK_NAMESPACE, 1]);
      await run(f);
      expect(f.api.send).not.toHaveBeenCalled();
      expect(f.crm.search).not.toHaveBeenCalled();
    } finally {
      await connection.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_NAMESPACE, 1]);
      connection.release();
    }
    await run(f);
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  test('send failure retries stored reply without repeating CRM; newer events wait', async () => {
    const f = external();
    const e = input(104, '/start');
    f.api.send.mockRejectedValue(new Error('MAX offline'));
    await enqueue(1, e);
    await run(f);
    const row = (await pool.query('SELECT * FROM max_loyalty_events WHERE salon_id=1 AND event_key=$1', [e.key])).rows[0];
    expect(row.status).toBe('reply');
    expect(row.payload).toBeNull();
    expect(row.attempts).toBe(1);
    await enqueue(1, input(104, 'untrusted'));
    await run(f);
    expect(f.api.send).toHaveBeenCalledTimes(1);
    await pool.query('UPDATE max_loyalty_events SET next_attempt_at=NOW() WHERE salon_id=1 AND id=$1', [row.id]);
    f.api.send.mockResolvedValue({});
    await run(f);
    expect(f.api.send).toHaveBeenCalledTimes(2);
    expect(f.crm.createClient).not.toHaveBeenCalled();
    // Finish the queued prompt for later tests.
    await ageReplies(); await run(f);
  });
  test('verified replacement identity revokes old session only within the salon', async () => {
    const client = await pool.connect();
    try {
      const state = { step: 'ready', phone: '70000000012', clientId: '77', cardId: '88', typeId: '3' };
      await pool.query(`INSERT INTO max_loyalty_sessions(salon_id,user_id,state) VALUES(1,105,$1),(2,105,$1)`, [JSON.stringify(state)]);
      const e = input(106, '/start');
      await enqueue(1, e);
      const event = (await pool.query('SELECT * FROM max_loyalty_events WHERE salon_id=1 AND event_key=$1', [e.key])).rows[0];
      await createStore(client, 1).saveReply(event, state, null);
      const rows = (await pool.query('SELECT salon_id,state FROM max_loyalty_sessions WHERE user_id=105 ORDER BY salon_id')).rows;
      expect(rows[0].state).toEqual({});
      expect(rows[1].state.step).toBe('ready');
    } finally { client.release(); }
  });
  test('existing local ledger remains primary; fractional card mode remains compatible', async () => {
    const client = await pool.connect();
    try {
      const c = (await pool.query('SELECT * FROM clients WHERE salon_id=1 LIMIT 1')).rows[0];
      const mirror = createMirror(createStore(client, 1), 1);
      expect(await mirror.balance(c.yclients_client_id, { balance: 784.89 })).toBe(500);
      configModule.BONUS_LEDGER_PRIMARY = false;
      expect(await mirror.balance(c.yclients_client_id, { balance: 784.89 })).toBe(784.89);
      const foreign = createMirror(createStore(client, 2), 2);
      await expect(foreign.balance(c.yclients_client_id, { balance: 1 })).rejects.toThrow('Client link missing');
    } finally { client.release(); }
  });
  test('expired drafts clear; fully registered links survive', async () => {
    const client = await pool.connect();
    try {
      await pool.query(`INSERT INTO max_loyalty_sessions(salon_id,user_id,state,updated_at)
        VALUES(1,107,'{"step":"name","phone":"70000000013"}',NOW()-INTERVAL '2 days')`);
      expect(await createStore(client, 1).session('107')).toEqual({});
      expect((await createStore(client, 1).session('102')).step).toBe('ready');
    } finally { client.release(); }
  });
  test('failed atomic reply save rolls back session; persisted bonus is never repeated', async () => {
    const f = external(), phone = '70000000014';
    await send(f, input(108, '/start'));
    await send(f, input(108, '', { phone }));
    await send(f, input(108, 'Тестовый клиент'));
    const bday = input(108, '01.01.2000');
    await enqueue(1, bday);
    await pool.query(`CREATE FUNCTION reject_test_reply() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id=108 AND NEW.status='reply' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_reply BEFORE UPDATE ON max_loyalty_events FOR EACH ROW EXECUTE FUNCTION reject_test_reply()`);
    await run(f);
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT state FROM max_loyalty_sessions WHERE salon_id=1 AND user_id=108')).rows[0].state.step).toBe('birthday');
    await pool.query('ALTER TABLE max_loyalty_events DISABLE TRIGGER reject_test_reply');
    await pool.query('UPDATE max_loyalty_events SET next_attempt_at=NOW() WHERE salon_id=1 AND event_key=$1', [bday.key]);
    await ageReplies(); await run(f);
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT state FROM max_loyalty_sessions WHERE salon_id=1 AND user_id=108')).rows[0].state.step).toBe('ready');
  });
  test('older production schema: welcome persists without optional finance table', async () => {
    configModule.BONUS_LEDGER_PRIMARY = false;
    const client = await pool.connect();
    try {
      await pool.query('ALTER TABLE finance_operations RENAME TO finance_operations_test_saved');
      const store = createStore(client, 1), phone = '70000000015';
      const r = { stage: 'done', welcome: true, clientId: '77777', cardId: '88888', name: 'Тест', birthday: '2000-01-01' };
      await store.saveRegistration(phone, r);
      await createMirror(store, 1).sync(phone, r, { id: '88888', balance: 500, number: 1234567 });
      expect((await pool.query('SELECT bonus_balance FROM clients WHERE salon_id=1 AND yclients_client_id=77777')).rows[0].bonus_balance).toBe(500);
      expect((await pool.query('SELECT COUNT(*) FROM loyalty_card_transactions WHERE salon_id=1 AND yclients_card_id=88888')).rows[0].count).toBe('1');
    } finally {
      await pool.query('ALTER TABLE finance_operations_test_saved RENAME TO finance_operations');
      client.release();
    }
  });
});
