'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({ lastConversation: jest.fn() }));
const { db } = require('./db');
const notif = require('./services/notifications/settings');
const rules = require('./services/notifications/rules');
const aud = require('./services/broadcast-messengers/audience');

const ALL = { tdlib: { enabled: true }, whatsapp: { enabled: true }, max: { enabled: true } };
const client = (o) => ({ client_id: 1, name: 'Анна', phone: '+79200000001', bonus_balance: 100, birthday: null, gender: null, is_blacklisted: false, last_visit_at: null, days_since_visit: null, segment_key: null, salon_name: 'PERI', ...o });

beforeEach(() => {
  jest.resetAllMocks();
  notif.getSettings.mockResolvedValue({ default_channels: ['tdlib', 'whatsapp', 'max'], prefer_last_channel: true });
  rules.lastConversation.mockResolvedValue({ lastChannel: null, chats: {} });
});

describe('matchesFilters', () => {
  test('сегмент и бонусы', () => {
    expect(aud.matchesFilters(client({ segment_key: 'champion' }), { segments: ['champion'] })).toBe(true);
    expect(aud.matchesFilters(client({ segment_key: 'sleeping' }), { segments: ['champion'] })).toBe(false);
    expect(aud.matchesFilters(client({ bonus_balance: 50 }), { bonusMin: 100 })).toBe(false);
    expect(aud.matchesFilters(client({ bonus_balance: 500 }), { bonusMax: 100 })).toBe(false);
    expect(aud.matchesFilters(client(), { bonusMin: 100, bonusMax: 100 })).toBe(true);
  });
  test('визит, месяц ДР (1-е число по локальной зоне), пол, фрагмент телефона', () => {
    expect(aud.matchesFilters(client({ days_since_visit: 10 }), { lastVisitDays: { gte: 30 } })).toBe(false);
    expect(aud.matchesFilters(client({ days_since_visit: null }), { lastVisitDays: { lte: 30 } })).toBe(false);
    expect(aud.matchesFilters(client({ birthday: new Date(2000, 10, 1) }), { birthMonth: 11 })).toBe(true);
    expect(aud.matchesFilters(client({ gender: 'male' }), { gender: 'female' })).toBe(false);
    expect(aud.matchesFilters(client({ gender: null }), { gender: 'female' })).toBe(true);
    expect(aud.matchesFilters(client(), { phone: '8 (920) 000' })).toBe(false);
    expect(aud.matchesFilters(client(), { phone: '920000' })).toBe(true);
  });
});

describe('resolveAudience', () => {
  test('фильтры: ЧС считается, каскад по умолчанию', async () => {
    db.any.mockResolvedValue([client(), client({ client_id: 2, phone: '+79200000002', is_blacklisted: true }), client({ client_id: 3, phone: 'abc' })]);
    const r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: ALL });
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0]).toMatchObject({ client_id: 1, phone: '79200000001', cascade: ['tdlib', 'whatsapp', 'max'], sort_order: 0 });
    expect(r.skipped).toEqual({ blacklist: 1, no_recipient: 0 });
  });
  test('список: имя из списка главнее карточки, неизвестный номер — client_id null, ЧС считается', async () => {
    db.any.mockResolvedValue([client({ name: 'Карточка' }), client({ client_id: 2, phone: '89200000002', is_blacklisted: true })]);
    db.oneOrNone.mockResolvedValue({ salon_name: 'PERI' });
    const list = [{ name: 'Из списка', phone: '79200000001' }, { name: '', phone: '79200000002' }, { name: 'Новый', phone: '79200000003' }];
    const r = await aud.resolveAudience(1, { source: 'list', list, channelSettings: ALL });
    expect(r.recipients.map(x => [x.client_id, x.name, x.phone, x.bonus_balance, x.salon_name])).toEqual([
      [1, 'Из списка', '79200000001', 100, 'PERI'], [null, 'Новый', '79200000003', 0, 'PERI']]);
    expect(r.skipped.blacklist).toBe(1);
  });
  test('cascadeEnabled=false — один шаг', async () => {
    db.any.mockResolvedValue([client()]);
    const r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: ALL, cascadeEnabled: false });
    expect(r.recipients[0].cascade).toEqual(['tdlib']);
  });
  test('выключенный мессенджер выпадает; ни одного — no_recipient', async () => {
    db.any.mockResolvedValue([client()]);
    let r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: { ...ALL, tdlib: { enabled: false } } });
    expect(r.recipients[0].cascade).toEqual(['whatsapp', 'max']);
    r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: { tdlib: { enabled: false } } });
    expect(r.recipients).toHaveLength(0);
    expect(r.skipped.no_recipient).toBe(1);
  });
  test('последняя переписка переставляет первым; сбой lastConversation не роняет', async () => {
    db.any.mockResolvedValue([client(), client({ client_id: 2, phone: '+79200000002' })]);
    rules.lastConversation.mockImplementation(async (s, p) => {
      if (p === '79200000001') return { lastChannel: 'max', chats: { max: '777' } };
      throw new Error('db down');
    });
    const r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: ALL });
    expect(r.recipients[0].cascade[0]).toBe('max');
    expect(r.recipients[1].cascade).toEqual(['tdlib', 'whatsapp', 'max']);
  });
  test('номер без переписки в салоне — lastConversation не зовётся (префильтр)', async () => {
    db.any
      .mockResolvedValueOnce([client(), client({ client_id: 2, phone: '+79200000002' })]) // клиенты
      .mockResolvedValueOnce([{ phone: '89200000002' }]); // номера из chatpush_messages
    const r = await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: ALL });
    expect(rules.lastConversation).toHaveBeenCalledTimes(1);
    expect(rules.lastConversation).toHaveBeenCalledWith(1, '79200000002');
    expect(r.recipients).toHaveLength(2);
  });
  test('сбой префильтра — lastConversation зовётся всем', async () => {
    db.any
      .mockResolvedValueOnce([client(), client({ client_id: 2, phone: '+79200000002' })])
      .mockRejectedValueOnce(new Error('db down'));
    await aud.resolveAudience(1, { source: 'filters', filters: {}, channelSettings: ALL });
    expect(rules.lastConversation).toHaveBeenCalledTimes(2);
  });
});
