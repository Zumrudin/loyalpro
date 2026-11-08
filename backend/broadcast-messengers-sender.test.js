'use strict';
// sender.sendToRecipient: одна отправка получателю рассылки (спека 2026-11-01 §5.3).
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./services/messaging/transport', () => ({
  sendMessage: jest.fn(), sendFile: jest.fn(),
  // Зеркало боевой isDefiniteRejection (как в notifications-worker.test.js, там же её проверка на реальном модуле):
  // 4xx — однозначный отказ; ошибка без status и code — наша собственная проверка; таймаут/5xx — нет.
  isDefiniteRejection: (e) => {
    const st = e && Number(e.status);
    if (st >= 400 && st < 500) return true;
    return !!e && !e.status && !e.code;
  },
}));
jest.mock('./services/notifications/rules', () => ({ lastConversation: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn() }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn(), readFileSync: jest.fn() };
});

const fs = require('fs');
const path = require('path');
const transport = require('./services/messaging/transport');
const { lastConversation } = require('./services/notifications/rules');
const authorship = require('./services/outgoing-authorship');
const pendingReplies = require('./services/agent/pending-replies');
const { persistWhatsappOutgoing } = require('./services/chat-persist');
const { sendToRecipient } = require('./services/broadcast-messengers/sender');

const PHONE = '79200255591';
const UPLOADS = path.join(__dirname, '../frontend/uploads');
const BUF = Buffer.from('img');

beforeEach(() => {
  jest.clearAllMocks();
  lastConversation.mockResolvedValue({ lastChannel: null, chats: {} });
  authorship.remember.mockResolvedValue();
  transport.sendMessage.mockResolvedValue({ id: 501, accountId: 9 });
  transport.sendFile.mockResolvedValue({ id: 777, accountId: 8 });
  persistWhatsappOutgoing.mockResolvedValue();
  fs.existsSync.mockReturnValue(true);
  fs.readFileSync.mockReturnValue(BUF);
});

const err = (props, msg = 'boom') => Object.assign(new Error(msg), props);

describe('sendToRecipient', () => {
  test('текст без картинки: authorship ДО отправки, успех с delivery_id/account_id', async () => {
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'Привет' });
    expect(r).toEqual({ ok: true, delivery_id: '501', account_id: '9' });
    expect(authorship.remember).toHaveBeenCalledWith(1, PHONE, 'Привет', 'system');
    expect(transport.sendMessage).toHaveBeenCalledWith(1, { dispatchRouting: ['whatsapp'], phone: PHONE, text: 'Привет' });
    expect(authorship.remember.mock.invocationCallOrder[0])
      .toBeLessThan(transport.sendMessage.mock.invocationCallOrder[0]);
    expect(pendingReplies.remember).toHaveBeenCalledWith(1, PHONE, 'Привет');
  });

  test('сбой authorship не мешает отправке', async () => {
    authorship.remember.mockRejectedValue(new Error('db down'));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x' });
    expect(r.ok).toBe(true);
    expect(transport.sendMessage).toHaveBeenCalled();
  });

  test('картинка с короткой подписью: sendFile с caption, второго сообщения нет; путь — basename внутри uploads', async () => {
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'max', text: 'Акция', imageUrl: '/uploads/../../etc/bc_1.png' });
    expect(r).toEqual({ ok: true, delivery_id: '777', account_id: '8' });
    expect(fs.readFileSync).toHaveBeenCalledWith(path.join(UPLOADS, 'bc_1.png'));
    expect(transport.sendFile).toHaveBeenCalledWith(1,
      { dispatchRouting: ['max'], phone: PHONE, fileName: 'bc_1.png', caption: 'Акция', type: 'image' }, BUF, 'image/png');
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(authorship.remember.mock.invocationCallOrder[0])
      .toBeLessThan(transport.sendFile.mock.invocationCallOrder[0]);
  });

  test('длинный текст: картинка без подписи + текст вторым сообщением', async () => {
    const long = 'а'.repeat(1500);
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: long, imageUrl: '/uploads/bc.jpg' });
    expect(r.ok).toBe(true);
    expect(transport.sendFile.mock.calls[0][1].caption).toBe('');
    expect(transport.sendFile.mock.calls[0][3]).toBe('image/jpeg');
    expect(transport.sendMessage).toHaveBeenCalledWith(1, { dispatchRouting: ['whatsapp'], phone: PHONE, text: long });
    expect(transport.sendFile.mock.invocationCallOrder[0])
      .toBeLessThan(transport.sendMessage.mock.invocationCallOrder[0]);
  });

  test('сбой второго сообщения → ok:true (картинка ушла) и WARN', async () => {
    transport.sendMessage.mockRejectedValue(err({ status: 500 }));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'б'.repeat(1500), imageUrl: 'bc.webp' });
    expect(r).toEqual({ ok: true, delivery_id: '777', account_id: '8' });
    expect(mockLog.warn).toHaveBeenCalled();
  });

  test('whatsapp: persistWhatsappOutgoing с authoredBy system', async () => {
    await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'Акция', imageUrl: '/uploads/bc.png' });
    expect(persistWhatsappOutgoing).toHaveBeenCalledWith(1, {
      delivery: { id: 777, accountId: 8 }, phone: PHONE, chatId: null, text: 'Акция',
      msgType: 'image', fileUrl: '/uploads/bc.png', mimeType: 'image/png', authoredBy: 'system',
    });
  });

  test('не whatsapp — без persist; сбой persist/pending не ломает успех', async () => {
    await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'tdlib', text: 'x' });
    expect(persistWhatsappOutgoing).not.toHaveBeenCalled();
    pendingReplies.remember.mockImplementation(() => { throw new Error('mem'); });
    persistWhatsappOutgoing.mockRejectedValue(new Error('db'));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x' });
    expect(r.ok).toBe(true);
  });

  test('tdlib: id чата из lastConversation главнее номера', async () => {
    lastConversation.mockResolvedValue({ lastChannel: 'tdlib', chats: { tdlib: '385578542' } });
    await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'tdlib', text: 'x' });
    expect(lastConversation).toHaveBeenCalledWith(1, PHONE);
    expect(transport.sendMessage).toHaveBeenCalledWith(1, { dispatchRouting: ['tdlib'], tdlib_user_id: '385578542', text: 'x' });
  });

  test('ошибка lastConversation → адресат по номеру', async () => {
    lastConversation.mockRejectedValue(new Error('db'));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'tdlib', text: 'x' });
    expect(r.ok).toBe(true);
    expect(transport.sendMessage.mock.calls[0][1]).toEqual({ dispatchRouting: ['tdlib'], phone: PHONE, text: 'x' });
  });

  test('нет адресата → rejected без отправки', async () => {
    const r = await sendToRecipient({ salonId: 1, phone: '', channel: 'whatsapp', text: 'x' });
    expect(r).toEqual({ ok: false, kind: 'rejected', error: 'нет адресата' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('файла картинки нет → rejected без вызова транспорта', async () => {
    fs.existsSync.mockReturnValue(false);
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x', imageUrl: '/uploads/nope.png' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rejected');
    expect(transport.sendFile).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('ошибка чтения файла → rejected', async () => {
    fs.readFileSync.mockImplementation(() => { throw err({ code: 'EACCES' }); });
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x', imageUrl: 'bc.png' });
    expect(r.kind).toBe('rejected');
    expect(transport.sendFile).not.toHaveBeenCalled();
  });

  test.each([
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ENOTFOUND' }, 'unreachable'],
    [{ code: 'EAI_AGAIN' }, 'unreachable'],
    [{ status: 422 }, 'rejected'],
    [{}, 'rejected'],                      // нет аккаунта мессенджера — наша проверка без status/code
    [{ status: 502 }, 'ambiguous'],
    [{ code: 'ECONNRESET' }, 'ambiguous'],
    [{ code: 'ETIMEDOUT' }, 'ambiguous'],
  ])('классификация ошибки %j → %s', async (props, kind) => {
    transport.sendMessage.mockRejectedValue(err(props, 'x'.repeat(400)));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe(kind);
    expect(r.error.length).toBe(300);
    expect(pendingReplies.remember).not.toHaveBeenCalled();
    expect(persistWhatsappOutgoing).not.toHaveBeenCalled();
  });

  test('ошибка первой отправки картинки классифицируется так же; второго сообщения нет', async () => {
    transport.sendFile.mockRejectedValue(err({ status: 422 }));
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'в'.repeat(1500), imageUrl: 'bc.png' });
    expect(r.kind).toBe('rejected');
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('никогда не бросает и при ответе транспорта без id', async () => {
    transport.sendMessage.mockResolvedValue(undefined);
    const r = await sendToRecipient({ salonId: 1, phone: PHONE, channel: 'whatsapp', text: 'x' });
    expect(r).toEqual({ ok: true, delivery_id: null, account_id: null });
    await expect(sendToRecipient(undefined)).resolves.toMatchObject({ ok: false });
  });
});
