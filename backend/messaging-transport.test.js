'use strict';
jest.mock('./services/messaging/accounts', () => ({ credentialsFor: jest.fn(), credentialsById: jest.fn() }));
jest.mock('./logger', () => {
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => log, __log: log };
});
jest.mock('./services/chatpush', () => ({ sendMessage: jest.fn(), sendFile: jest.fn(), getDeliveryStatus: jest.fn(), replyRoutingFor: (c) => (c === 'telegram_bot' ? 'telegram' : c) }));
jest.mock('./config', () => ({ CHATPUSH: { instanceToken: '' }, MESSAGING_GATEWAY: { url: '' } }));

const accounts = require('./services/messaging/accounts');
const chatpush = require('./services/chatpush');
const transport = require('./services/messaging/transport');

const CP = { id: 5, provider: 'chatpush', apiBase: 'https://api.chatpush.ru', token: 'CP' };
const GW = { id: 9, provider: 'gateway', apiBase: 'http://127.0.0.1:3002', token: 'GW' };

beforeEach(() => jest.resetAllMocks());

describe('sendMessage', () => {
  test('все каналы на одном аккаунте Chatpush → ОДИН вызов с полным routing (фолбэк делает Chatpush)', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => ({ ...CP, channel: ch }));
    chatpush.sendMessage.mockResolvedValueOnce({ id: 1 });
    const d = await transport.sendMessage(1, { text: 'hi', phone: '79001112233', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(d).toMatchObject({ id: 1 });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatpush.sendMessage.mock.calls[0][0]).toMatchObject({ token: 'CP' });
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['whatsapp', 'tdlib']);
  });

  test('каналы на РАЗНЫХ аккаунтах → по вызову на аккаунт, первый успешный побеждает', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : { ...CP, channel: ch }));
    chatpush.sendMessage.mockRejectedValueOnce(Object.assign(new Error('wa 422'), { status: 422 })).mockResolvedValueOnce({ id: 'g1' });
    const d = await transport.sendMessage(1, { text: 'hi', phone: '79001112233', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(d).toMatchObject({ id: 'g1' });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(2);
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['whatsapp']);
    expect(chatpush.sendMessage.mock.calls[1][0]).toMatchObject({ token: 'GW' });
    expect(chatpush.sendMessage.mock.calls[1][1].dispatchRouting).toEqual(['tdlib']);
  });

  test('канал без аккаунта пропускается; ни одного аккаунта → ошибка с перечислением каналов', async () => {
    accounts.credentialsFor.mockResolvedValue(null);
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['max'] }))
      .rejects.toThrow(/нет аккаунта мессенджера.*max/);
    expect(chatpush.sendMessage).not.toHaveBeenCalled();
  });

  test('все вызовы упали → бросается ПОСЛЕДНЯЯ ошибка', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : { ...CP, channel: ch }));
    chatpush.sendMessage
      .mockRejectedValueOnce(Object.assign(new Error('one'), { status: 422 }))
      .mockRejectedValueOnce(Object.assign(new Error('two'), { status: 422 }));
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] })).rejects.toThrow('two');
  });

  test('dispatchRouting строкой трактуется как один канал', async () => {
    accounts.credentialsFor.mockResolvedValue({ ...GW, channel: 'tdlib' });
    chatpush.sendMessage.mockResolvedValueOnce({ id: 'g3' });
    await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: 'tdlib' });
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['tdlib']);
  });

  test('salonId обязателен', async () => {
    await expect(transport.sendMessage(null, { text: 'hi', dispatchRouting: ['tdlib'] })).rejects.toThrow(/salonId/);
    expect(accounts.credentialsFor).not.toHaveBeenCalled();
  });
});

describe('sendFile / getDeliveryStatus', () => {
  test('sendFile идёт по первому каналу с аккаунтом', async () => {
    accounts.credentialsFor.mockResolvedValueOnce({ ...GW, channel: 'tdlib' });
    chatpush.sendFile.mockResolvedValueOnce({ id: 'g2' });
    const buf = Buffer.from('x');
    const d = await transport.sendFile(1, { fileName: 'a.jpg', type: 'image', phone: 'p', dispatchRouting: ['tdlib'] }, buf, 'image/jpeg');
    expect(d).toMatchObject({ id: 'g2' });
    expect(chatpush.sendFile.mock.calls[0][0]).toMatchObject({ token: 'GW' });
    expect(chatpush.sendFile.mock.calls[0][2]).toBe(buf);
    expect(chatpush.sendFile.mock.calls[0][3]).toBe('image/jpeg');
  });
  test('getDeliveryStatus(salonId, channel, id)', async () => {
    accounts.credentialsFor.mockResolvedValueOnce({ ...GW, channel: 'tdlib' });
    chatpush.getDeliveryStatus.mockResolvedValueOnce({ id: 'g1' });
    expect(await transport.getDeliveryStatus(1, 'tdlib', 'g1')).toEqual({ id: 'g1' });
    expect(chatpush.getDeliveryStatus.mock.calls[0][0]).toMatchObject({ token: 'GW' });
    expect(chatpush.getDeliveryStatus.mock.calls[0][1]).toBe('g1');
  });
  test('getDeliveryStatus: telegram_bot → креды канала telegram', async () => {
    accounts.credentialsFor.mockResolvedValueOnce({ ...CP, channel: 'telegram' });
    chatpush.getDeliveryStatus.mockResolvedValueOnce({ id: '7' });
    await transport.getDeliveryStatus(1, 'telegram_bot', '7');
    expect(accounts.credentialsFor).toHaveBeenCalledWith(1, 'telegram');
  });
  test('getDeliveryStatus без аккаунта → null', async () => {
    accounts.credentialsFor.mockResolvedValueOnce(null);
    expect(await transport.getDeliveryStatus(1, 'tdlib', 'g1')).toBeNull();
    expect(chatpush.getDeliveryStatus).not.toHaveBeenCalled();
  });
});

describe('configured', () => {
  test('false, когда ни env-токена, ни шлюза', () => {
    expect(transport.configured()).toBe(false);
  });
  test('true при env-токене или url шлюза', () => {
    const config = require('./config');
    config.CHATPUSH.instanceToken = 'x';
    try { expect(transport.configured()).toBe(true); } finally { config.CHATPUSH.instanceToken = ''; }
    config.MESSAGING_GATEWAY.url = 'http://127.0.0.1:3002';
    try { expect(transport.configured()).toBe(true); } finally { config.MESSAGING_GATEWAY.url = ''; }
  });
});

describe('ревью: at-most-once, лог, accountId', () => {
  const split = async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : { ...CP, channel: ch });
  const def = (m) => Object.assign(new Error(m), { status: 422 });

  test('таймаут на первой группе → бросается сразу, вторая группа не вызывается', async () => {
    accounts.credentialsFor.mockImplementation(split);
    const err = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    chatpush.sendMessage.mockRejectedValueOnce(err).mockResolvedValueOnce({ id: 'x' });
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] })).rejects.toBe(err);
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('5xx на первой группе → бросается сразу', async () => {
    accounts.credentialsFor.mockImplementation(split);
    const err = Object.assign(new Error('bad gateway'), { status: 503 });
    chatpush.sendMessage.mockRejectedValueOnce(err).mockResolvedValueOnce({ id: 'x' });
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] })).rejects.toBe(err);
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('оба отказали однозначно → тот же объект ошибки с transportErrors по обеим группам', async () => {
    accounts.credentialsFor.mockImplementation(split);
    const e1 = def('one'); const e2 = def('two');
    chatpush.sendMessage.mockRejectedValueOnce(e1).mockRejectedValueOnce(e2);
    let caught;
    try { await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] }); } catch (e) { caught = e; }
    expect(caught).toBe(e2);
    expect(caught.transportErrors).toEqual([
      { accountId: 5, channels: ['whatsapp'], message: 'one', status: 422 },
      { accountId: 9, channels: ['tdlib'], message: 'two', status: 422 },
    ]);
    expect(require('./logger').__log.warn).toHaveBeenCalledTimes(2);
  });

  test('несмежные каналы одного аккаунта → три вызова CP[whatsapp], GW[tdlib], CP[max]', async () => {
    accounts.credentialsFor.mockImplementation(split);
    chatpush.sendMessage.mockRejectedValueOnce(def('a')).mockRejectedValueOnce(def('b')).mockResolvedValueOnce({ id: 'm' });
    const d = await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib', 'max'] });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(3);
    const calls = chatpush.sendMessage.mock.calls;
    expect(calls.map(c => c[0].token)).toEqual(['CP', 'GW', 'CP']);
    expect(calls.map(c => c[1].dispatchRouting)).toEqual([['whatsapp'], ['tdlib'], ['max']]);
    expect(d).toEqual({ id: 'm', accountId: 5, channels: ['max'] });
  });

  test('аккаунт только у tdlib → один вызов с [tdlib]', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : null));
    chatpush.sendMessage.mockResolvedValueOnce({ id: 't' });
    await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['tdlib']);
  });

  test('sendFile переходит к следующему аккаунту на однозначном отказе', async () => {
    accounts.credentialsFor.mockImplementation(split);
    chatpush.sendFile.mockRejectedValueOnce(def('wa 422')).mockResolvedValueOnce({ id: 'f' });
    const buf = Buffer.from('x');
    const d = await transport.sendFile(1, { fileName: 'a.jpg', type: 'image', phone: 'p', dispatchRouting: ['whatsapp', 'tdlib'] }, buf, 'image/jpeg');
    expect(chatpush.sendFile).toHaveBeenCalledTimes(2);
    expect(chatpush.sendFile.mock.calls[1][0]).toMatchObject({ token: 'GW' });
    expect(d).toEqual({ id: 'f', accountId: 9, channels: ['tdlib'] });
  });

  test('результат несёт accountId и channels', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => ({ ...CP, channel: ch }));
    chatpush.sendMessage.mockResolvedValueOnce({ id: 1 });
    const d = await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(d).toEqual({ id: 1, accountId: 5, channels: ['whatsapp', 'tdlib'] });
  });

  test('не-объект от провайдера возвращается как есть', async () => {
    accounts.credentialsFor.mockResolvedValue({ ...CP, channel: 'tdlib' });
    chatpush.sendMessage.mockResolvedValueOnce(undefined);
    expect(await transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['tdlib'] })).toBeUndefined();
  });

  test('getDeliveryStatus с accountId → credentialsById, без credentialsFor', async () => {
    accounts.credentialsById.mockResolvedValueOnce({ ...GW, channel: 'tdlib' });
    chatpush.getDeliveryStatus.mockResolvedValueOnce({ id: 'g1' });
    expect(await transport.getDeliveryStatus(1, 'tdlib', 'g1', { accountId: 9 })).toEqual({ id: 'g1' });
    expect(accounts.credentialsById).toHaveBeenCalledWith(9);
    expect(accounts.credentialsFor).not.toHaveBeenCalled();
    expect(chatpush.getDeliveryStatus.mock.calls[0][0]).toMatchObject({ token: 'GW' });
  });

  test('getDeliveryStatus: credentialsById → null → фолбэк на credentialsFor', async () => {
    accounts.credentialsById.mockResolvedValueOnce(null);
    accounts.credentialsFor.mockResolvedValueOnce({ ...CP, channel: 'tdlib' });
    chatpush.getDeliveryStatus.mockResolvedValueOnce({ id: 'g1' });
    await transport.getDeliveryStatus(1, 'tdlib', 'g1', { accountId: 9 });
    expect(accounts.credentialsFor).toHaveBeenCalledWith(1, 'tdlib');
    expect(chatpush.getDeliveryStatus.mock.calls[0][0]).toMatchObject({ token: 'CP' });
  });

  test('пустой routing → ошибка', async () => {
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: [] })).rejects.toThrow(/dispatchRouting пуст/);
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x' })).rejects.toThrow(/dispatchRouting пуст/);
    expect(accounts.credentialsFor).not.toHaveBeenCalled();
  });
});
