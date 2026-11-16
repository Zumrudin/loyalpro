'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('./config', () => ({ TELEGRAM_API_BASE: 'https://telegram.invalid' }));
jest.mock('./services/mobile-otp', () => ({
  normalizePhone: jest.fn(value => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return `7${digits}`;
    if (digits.length === 11 && digits[0] === '8') return `7${digits.slice(1)}`;
    return digits.length === 11 && digits[0] === '7' ? digits : null;
  }),
  configuredSalonId: jest.fn(() => 17),
  findClientByPhone: jest.fn(),
  issueOtp: jest.fn(),
}));
jest.mock('./services/telegram-otp', () => ({
  linkVerifiedContact: jest.fn(),
  sendMessage: jest.fn(async () => ({})),
  sendOtpToChat: jest.fn(async () => ({})),
}));
jest.mock('./logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log, __log: log };
});

const mobileOtp = require('./services/mobile-otp');
const telegram = require('./services/telegram-otp');
const { handleUpdate } = require('./otp-bot-listener');
const { getBotLink } = require('./services/telegram');
const { __log: log } = require('./logger');

const phone = '7'.repeat(11);
const privateMessage = () => ({
  chat: { id: 101, type: 'private' },
  from: { id: 101, is_bot: false },
});
const update = message => ({ update_id: 1, message });
const ownContact = () => ({
  ...privateMessage(),
  contact: { user_id: 101, phone_number: phone },
});

beforeEach(() => {
  jest.clearAllMocks();
  mobileOtp.configuredSalonId.mockReturnValue(17);
  mobileOtp.findClientByPhone.mockResolvedValue({ status: 'ok', client: { id: 55 } });
  telegram.linkVerifiedContact.mockResolvedValue({ status: 'changed' });
  mobileOtp.issueOtp.mockResolvedValue({ issued: true, otp: String(Date.now()).slice(-6) });
});

test('deep-link and /start never carry or trust a phone number', async () => {
  expect(getBotLink(phone)).not.toContain(phone);
  expect(getBotLink()).not.toContain('start=');
  await handleUpdate(update({ ...privateMessage(), text: `/start ${phone}` }));
  expect(mobileOtp.findClientByPhone).not.toHaveBeenCalled();
  expect(telegram.linkVerifiedContact).not.toHaveBeenCalled();
  expect(mobileOtp.issueOtp).not.toHaveBeenCalled();
  expect(telegram.sendOtpToChat).not.toHaveBeenCalled();
  expect(telegram.sendMessage).toHaveBeenCalledWith(
    101,
    expect.any(String),
    expect.objectContaining({ reply_markup: expect.objectContaining({ keyboard: expect.any(Array) }) })
  );
  expect(JSON.stringify(telegram.sendMessage.mock.calls)).not.toContain(phone);
});

test.each([
  ['another Telegram user', { ...ownContact(), contact: { user_id: 202, phone_number: phone } }],
  ['forwarded contact', { ...ownContact(), forward_date: 1 }],
  ['group chat', { ...ownContact(), chat: { id: -303, type: 'group' } }],
  ['missing sender', { ...ownContact(), from: null }],
])('%s is rejected without link, OTP or session side effects', async (_name, message) => {
  await handleUpdate(update(message));
  expect(mobileOtp.findClientByPhone).not.toHaveBeenCalled();
  expect(telegram.linkVerifiedContact).not.toHaveBeenCalled();
  expect(mobileOtp.issueOtp).not.toHaveBeenCalled();
  expect(telegram.sendOtpToChat).not.toHaveBeenCalled();
});

test('own contact creates a verified link and sends only a newly issued OTP', async () => {
  const freshOtp = String(Date.now() + 1).slice(-6);
  mobileOtp.issueOtp.mockResolvedValue({ issued: true, otp: freshOtp });
  await handleUpdate(update(ownContact()));
  expect(mobileOtp.findClientByPhone).toHaveBeenCalledWith(phone, 17);
  expect(telegram.linkVerifiedContact).toHaveBeenCalledWith({
    salonId: 17, clientId: 55, phone, chatId: 101, telegramUserId: 101,
  });
  expect(mobileOtp.issueOtp).toHaveBeenCalledWith({ phone, salonId: 17 });
  expect(telegram.sendOtpToChat).toHaveBeenCalledWith(101, freshOtp);
  expect(telegram.sendOtpToChat).toHaveBeenCalledTimes(1);
});

test('repeat verification does not rebind or reset OTP issuance limits', async () => {
  telegram.linkVerifiedContact.mockResolvedValue({ status: 'unchanged' });
  await handleUpdate(update(ownContact()));
  expect(mobileOtp.issueOtp).not.toHaveBeenCalled();
  expect(telegram.sendOtpToChat).not.toHaveBeenCalled();
  expect(telegram.sendMessage).toHaveBeenCalledWith(101, expect.stringContaining('уже подтверждён'));
});

test('missing server configuration fails closed', async () => {
  mobileOtp.configuredSalonId.mockImplementation(() => {
    const error = new Error('not configured');
    error.code = 'MOBILE_AUTH_NOT_CONFIGURED';
    throw error;
  });
  await expect(handleUpdate(update(ownContact()))).rejects.toMatchObject({ code: 'MOBILE_AUTH_NOT_CONFIGURED' });
  expect(telegram.linkVerifiedContact).not.toHaveBeenCalled();
  expect(mobileOtp.issueOtp).not.toHaveBeenCalled();
});

test('technical logs contain neither contact data nor OTP', () => {
  const output = JSON.stringify(Object.values(log).flatMap(fn => fn.mock.calls));
  expect(output).not.toContain(phone);
  expect(output).not.toContain('chat_id');
  expect(output).not.toContain('otp=');
});
