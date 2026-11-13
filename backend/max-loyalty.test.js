'use strict';
const crypto = require('crypto');
const p = require('./services/max-loyalty/protocol');
const { register } = require('./services/max-loyalty/registration');
const { handle } = require('./services/max-loyalty/dialog');
// Synthetic identities only. No network/DB dependencies in this suite.
const PHONE = '70000000001';
const TOKEN = 'synthetic-max-token';
function contact(overrides = {}) {
  const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:${PHONE}\r\nEND:VCARD\r\n`;
  return { body: { attachments: [{ type: 'contact', payload: {
    vcf_info: vcf, max_info: { user_id: 42 },
    hash: crypto.createHmac('sha256', TOKEN).update(vcf).digest('hex'), ...overrides,
  } }] } };
}
function fixture({ existing = false } = {}) {
  const regs = new Map();
  let cards = existing ? [{ id: 9, number: 1234567, type: { id: 3 }, balance: 100 }] : [];
  const store = {
    registration: jest.fn(async phone => structuredClone(regs.get(phone) || {})),
    saveRegistration: jest.fn(async (phone, state) => regs.set(phone, structuredClone(state))),
  };
  const crm = {
    cardType: jest.fn(async () => '3'), search: jest.fn(async () => existing ? { id: 7, phone: PHONE } : null),
    createClient: jest.fn(async () => ({ id: 7 })),
    cards: jest.fn(async () => structuredClone(cards)),
    createCard: jest.fn(async (_p, type, number) => { cards = [{ id: 9, number, type: { id: +type }, balance: 0 }]; }),
    accrue: jest.fn(async () => { cards[0].balance += 500; }),
    cardNumber: () => 1234567,
    client: jest.fn(async () => ({ id: 7, phone: PHONE })),
  };
  const deps = { store, crm, sync: jest.fn(async () => {}), balance: jest.fn(async (_id, card) => card.balance) };
  const args = { store, crm, phone: PHONE, name: 'Тестовый клиент', birthday: '2000-02-29' };
  return { ...deps, deps, args, regs };
}
const message = text => ({ type: 'message_created', userId: '42', text });

describe('MAX identity and input validation', () => {
  test('signed own contact verifies; signature and owner mismatches fail closed', () => {
    expect(p.verifiedPhone(contact(), '42', TOKEN)).toBe(PHONE);
    expect(p.verifiedPhone(contact(), '43', TOKEN)).toBeNull();
    expect(p.verifiedPhone(contact(), '42', 'different')).toBeNull();
    expect(p.verifiedPhone(contact({ hash: undefined }), '42', TOKEN)).toBeNull();
    expect(p.verifiedPhone(contact({ max_info: null }), '42', TOKEN)).toBeNull();
    expect(p.verifiedPhone({ ...contact(), link: { type: 'forward' } }, '42', TOKEN)).toBeNull();
  });
  test('CRLF and base64 hash representations; multiple TEL fields rejected', () => {
    const m = contact(), payload = m.body.attachments[0].payload;
    payload.hash = Buffer.from(payload.hash, 'hex').toString('base64');
    payload.vcf_info = payload.vcf_info.replace(/\r\n/g, '\\r\\n');
    expect(p.verifiedPhone(m, '42', TOKEN)).toBe(PHONE);
    payload.vcf_info = `TEL:${PHONE}\r\nTEL:${PHONE}\r\n`;
    payload.hash = crypto.createHmac('sha256', TOKEN).update(payload.vcf_info).digest('hex');
    expect(p.verifiedPhone(m, '42', TOKEN)).toBeNull();
  });
  test('only private user messages accepted; stable dedup; raw contact not retained', () => {
    const update = { update_type: 'message_created', message: {
      ...contact(), sender: { user_id: 42 }, recipient: { chat_type: 'dialog' },
    } };
    update.message.body.mid = 'synthetic-mid';
    const e = p.normalizeUpdate(update, TOKEN);
    expect(e.phone).toBe(PHONE);
    expect(e.key).toBe(p.normalizeUpdate(update, TOKEN).key);
    expect(JSON.stringify(e)).not.toContain('VCARD');
    expect(JSON.stringify(e)).not.toContain('hash');
    update.message.recipient.chat_type = 'chat';
    expect(p.normalizeUpdate(update, TOKEN)).toBeNull();
    update.message.recipient.chat_type = 'dialog';
    update.message.sender.is_bot = true;
    expect(p.normalizeUpdate(update, TOKEN)).toBeNull();
  });
  test('start payload cannot select tenant; unsafe numeric ids rejected', () => {
    const u = { update_type: 'bot_started', timestamp: 123, user: { user_id: 42 }, payload: 'salon=999' };
    expect(p.normalizeUpdate(u, TOKEN)).not.toHaveProperty('salonId');
    expect(p.id(9007199254740992)).toBeNull();
    expect(p.id('9007199254740992')).toBe('9007199254740992');
    expect(p.id('9223372036854775808')).toBeNull();
    expect(p.id(-1)).toBeNull();
  });
  test('real calendar dates and Moscow date boundary', () => {
    expect(p.birthday('29.02.2000')).toBe('2000-02-29');
    expect(p.birthday('29.02.2001')).toBeNull();
    expect(p.birthday('31.04.2000')).toBeNull();
    expect(p.birthday('01.01.1800')).toBeNull();
    expect(p.birthday('14.11.2026', new Date('2026-11-13T21:30:00Z'))).toBe('2026-11-14');
    expect(p.birthday('15.11.2026', new Date('2026-11-13T21:30:00Z'))).toBeNull();
  });
});

describe('durable CRM effects', () => {
  test('recover rejected client creation by linking existing Telegram card without any CRM writes', async () => {
    const f = fixture({ existing: true });
    f.regs.set(PHONE, { stage: 'review', uncertainStage: 'client_creating', typeId: '3' });
    expect(await register(f.args)).toMatchObject({ stage: 'done', welcome: false, clientId: '7', cardId: '9', recoveredFrom: 'client_creating' });
    expect(f.crm.createClient).not.toHaveBeenCalled();
    expect(f.crm.createCard).not.toHaveBeenCalled();
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test('client-creation review with no existing card stays blocked; no new card or bonus', async () => {
    const f = fixture();
    f.regs.set(PHONE, { stage: 'review', uncertainStage: 'client_creating', typeId: '3' });
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(f.crm.createClient).not.toHaveBeenCalled();
    expect(f.crm.createCard).not.toHaveBeenCalled();
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test('new client/card: 500 once even after re-entry/restart', async () => {
    const f = fixture();
    const result = await register(f.args);
    expect(result).toMatchObject({ stage: 'done', welcome: true, clientId: '7', cardId: '9' });
    await register(f.args);
    expect(f.crm.createClient).toHaveBeenCalledTimes(1);
    expect(f.crm.createCard).toHaveBeenCalledTimes(1);
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
    expect(f.store.saveRegistration.mock.calls.map(c => c[1].stage)).toEqual([
      undefined, 'client_creating', 'client_ready', 'card_creating', 'card_ready', 'bonus_sending', 'done',
    ]);
  });
  test('Telegram/existing card: never create or grant again', async () => {
    const f = fixture({ existing: true });
    expect(await register(f.args)).toMatchObject({ stage: 'done', welcome: false });
    expect(f.crm.createClient).not.toHaveBeenCalled();
    expect(f.crm.createCard).not.toHaveBeenCalled();
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test.each(['createClient', 'createCard', 'accrue'])('lost %s response: review, no repeat write', async method => {
    const f = fixture();
    f.crm[method].mockRejectedValue(new Error('uncertain external result'));
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(f.crm[method]).toHaveBeenCalledTimes(1);
  });
  test.each(['client_creating', 'card_creating', 'bonus_sending'])('restart in %s: fail closed', async stage => {
    const f = fixture();
    f.regs.set(PHONE, { stage });
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(f.crm.search).not.toHaveBeenCalled();
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test('CRM read failure is not treated as no card', async () => {
    const f = fixture({ existing: true });
    f.crm.cards.mockRejectedValue(new Error('offline'));
    await expect(register(f.args)).rejects.toThrow();
    expect(f.crm.createCard).not.toHaveBeenCalled();
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test('different card appeared concurrently: no welcome grant', async () => {
    const f = fixture();
    f.crm.createCard.mockImplementation(async () => {});
    f.crm.cards.mockResolvedValueOnce([]).mockResolvedValue([{ id: 8, type: { id: 3 }, number: 7654321 }]);
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(f.crm.accrue).not.toHaveBeenCalled();
  });
  test('DB persistence failure after bonus success does not repeat bonus', async () => {
    const f = fixture(), save = f.store.saveRegistration.getMockImplementation();
    f.store.saveRegistration.mockImplementation(async (p, r) => {
      if (r.stage === 'done') throw new Error('database unavailable');
      return save(p, r);
    });
    await expect(register(f.args)).rejects.toThrow();
    expect(await register(f.args)).toMatchObject({ stage: 'review' });
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram scenario adapted to MAX', () => {
  test('full registration, restartable state, balance, repeated start', async () => {
    const f = fixture();
    let r = await handle({ type: 'bot_started' }, {}, f.deps);
    expect(r.state.step).toBe('phone');
    r = await handle({ ...message(''), phone: PHONE }, r.state, f.deps);
    expect(r.state.step).toBe('name');
    r = await handle(message('Тестовый клиент'), r.state, f.deps);
    expect(r.state.step).toBe('birthday');
    const invalid = await handle(message('31.02.2000'), r.state, f.deps);
    expect(invalid.state.step).toBe('birthday');
    r = await handle(message('29.02.2000'), r.state, f.deps);
    expect(r.state.step).toBe('ready');
    expect(r.reply.text).toContain('500');
    expect(f.sync).toHaveBeenCalledTimes(1);
    const balance = await handle(message('/balance'), structuredClone(r.state), f.deps);
    expect(balance.reply.text).toContain('500');
    expect(balance.reply.text).toContain('5%');
    await handle(message('/start'), r.state, f.deps);
    expect(f.crm.accrue).toHaveBeenCalledTimes(1);
  });
  test('registered Telegram client links immediately without questionnaire or bonus', async () => {
    const f = fixture({ existing: true });
    const r = await handle({ ...message(''), phone: PHONE }, { step: 'phone' }, f.deps);
    expect(r.state.step).toBe('ready');
    expect(f.crm.accrue).not.toHaveBeenCalled();
    expect(f.sync).toHaveBeenCalled();
  });
  test('unsigned/typed phone never authorizes lookup', async () => {
    const f = fixture();
    const r = await handle(message(PHONE), { step: 'phone' }, f.deps);
    expect(r.state.step).toBe('phone');
    expect(f.crm.search).not.toHaveBeenCalled();
  });
  test('CRM owner changed: no balance disclosed', async () => {
    const f = fixture({ existing: true });
    f.crm.client.mockResolvedValue({ phone: '70000000002' });
    const r = await handle(message('/balance'), { step: 'ready', phone: PHONE, clientId: '7', cardId: '9', typeId: '3' }, f.deps);
    expect(r.state.step).toBe('phone');
    expect(f.balance).not.toHaveBeenCalled();
  });
  test('stop suppresses responses until start; cancel clears draft', async () => {
    const f = fixture();
    const r = await handle({ type: 'bot_stopped' }, { step: 'name', phone: PHONE }, f.deps);
    expect((await handle(message('/balance'), r.state, f.deps)).reply).toBeNull();
    expect((await handle(message('/start'), r.state, f.deps)).state).toEqual({ step: 'phone' });
    expect((await handle(message('/cancel'), { step: 'birthday', phone: PHONE }, f.deps)).state).toEqual({});
  });
});
