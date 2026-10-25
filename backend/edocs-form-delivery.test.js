'use strict';
// Доставка ссылки на анкету в мессенджер (services/edocs/form-delivery.js).
jest.mock('./services/messaging/transport', () => ({
  sendMessage: jest.fn(),
  isDefiniteRejection: (e) => !!(e && Number(e.status) >= 400 && Number(e.status) < 500),
}));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({ lastConversation: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn() }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('./config', () => ({ EDOCS_TEST_PHONES: [] }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const transport = require('./services/messaging/transport');
const notifSettings = require('./services/notifications/settings');
const { lastConversation } = require('./services/notifications/rules');
const authorship = require('./services/outgoing-authorship');
const pendingReplies = require('./services/agent/pending-replies');
const { persistWhatsappOutgoing } = require('./services/chat-persist');
const config = require('./config');
const { deliverText } = require('./services/edocs/form-delivery');

const TEXT = 'Здравствуйте, Анна! Заполните данные: https://dev.zumrudin.ru/anketa/abc';
const order = [];

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  config.EDOCS_TEST_PHONES = [];
  notifSettings.getSettings.mockResolvedValue({ default_channels: ['tdlib', 'whatsapp', 'max'], prefer_last_channel: true });
  lastConversation.mockResolvedValue({ lastChannel: null, chats: { tdlib: '5245186003' } });
  authorship.remember.mockImplementation(async () => { order.push('authorship'); });
  transport.sendMessage.mockImplementation(async (sid, target) => { order.push(`send:${target.dispatchRouting[0]}`); return { id: 777, accountId: 8 }; });
});

test('первый мессенджер каскада принял: авторство «system» ДО отправки, Мила видит реплику', async () => {
  const r = await deliverText({ salonId: 1, phone: '+7 (920) 025-55-91', text: TEXT });
  expect(r).toEqual({ channel: 'tdlib', deliveryId: '777', steps: [] });
  expect(order).toEqual(['authorship', 'send:tdlib']);
  expect(authorship.remember).toHaveBeenCalledWith(1, '79200255591', TEXT, 'system');
  expect(transport.sendMessage.mock.calls[0][1]).toMatchObject({ text: TEXT, dispatchRouting: ['tdlib'] });
  expect(pendingReplies.remember).toHaveBeenCalledWith(1, '79200255591', TEXT);
  expect(persistWhatsappOutgoing).not.toHaveBeenCalled();
});

test('«сначала мессенджер последней переписки»: WhatsApp первым, строка в «Чат» с автором system', async () => {
  lastConversation.mockResolvedValue({ lastChannel: 'whatsapp', chats: {} });
  const r = await deliverText({ salonId: 1, phone: '79200255591', text: TEXT });
  expect(r.channel).toBe('whatsapp');
  expect(persistWhatsappOutgoing).toHaveBeenCalledWith(1, { delivery: { id: 777, accountId: 8 }, phone: '79200255591', chatId: null, text: TEXT, msgType: 'text', authoredBy: 'system' });
});

test('однозначный отказ — следующий мессенджер; неоднозначный — стоп без повтора', async () => {
  transport.sendMessage
    .mockRejectedValueOnce(Object.assign(new Error('422 нет аккаунта'), { status: 422 }))
    .mockResolvedValueOnce({ id: 9 });
  const r = await deliverText({ salonId: 1, phone: '79200255591', text: TEXT });
  expect(r).toEqual({ channel: 'whatsapp', deliveryId: '9', steps: ['tdlib=отказ'] });

  transport.sendMessage.mockReset();
  transport.sendMessage.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'form_delivery_unknown', status: 502 });
  expect(transport.sendMessage).toHaveBeenCalledTimes(1);
});

test('сбой соединения ДО запроса (ECONNREFUSED) — однозначный, каскад идёт дальше', async () => {
  transport.sendMessage
    .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    .mockResolvedValueOnce({ id: 10 });
  expect((await deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).channel).toBe('whatsapp');
});

test('все отказали — form_not_delivered с шагами; нет номера; нет мессенджеров; тестовый режим', async () => {
  transport.sendMessage.mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({
    code: 'form_not_delivered', steps: ['tdlib=отказ', 'whatsapp=отказ', 'max=отказ'] });
  await expect(deliverText({ salonId: 1, phone: '', text: TEXT })).rejects.toMatchObject({ code: 'form_no_phone' });
  notifSettings.getSettings.mockResolvedValueOnce({ default_channels: [], prefer_last_channel: true });
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'form_no_channels' });
  config.EDOCS_TEST_PHONES = ['79000000000'];
  transport.sendMessage.mockClear();
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'test_phone_blocked' });
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('переписка не прочиталась — каскад по настройкам, без падения', async () => {
  lastConversation.mockRejectedValue(new Error('db down'));
  expect((await deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).channel).toBe('tdlib');
});
