'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), query: jest.fn() } }));
const { db } = require('./db');
const settings = require('./services/notifications/settings');

beforeEach(() => {
  jest.clearAllMocks();
  settings.invalidate();
  db.oneOrNone.mockResolvedValue(null);
  db.query.mockResolvedValue({ rowCount: 1 });
});

// Параметры INSERT: [salon, mode, default_channels(json), quiet_from, quiet_to, confirm, high, mid, low, escalate, prefer_last]
const written = () => db.query.mock.calls.find(([sql]) => /INSERT INTO notification_settings/.test(sql))[1];

describe('getSettings', () => {
  test('строки нет → дефолты, режим off (ничего не уходит без явного включения)', async () => {
    const s = await settings.getSettings(1);
    expect(s).toMatchObject({ salon_id: 1, mode: 'off', prefer_last_channel: true, quiet_from: '21:00', quiet_to: '09:00',
      default_channels: ['tdlib', 'whatsapp', 'max'], rating_escalate_low: true });
    expect(s.confirm_reply_text).toMatch(/подтверждена/);
  });
  test('строка перекрывает дефолты; NULL в тихих часах — «выключены», а не дефолт', async () => {
    db.oneOrNone.mockResolvedValue({ salon_id: 1, mode: 'live', quiet_from: null, quiet_to: null, default_channels: ['max'] });
    const s = await settings.getSettings(1);
    expect(s).toMatchObject({ mode: 'live', quiet_from: null, quiet_to: null, default_channels: ['max'] });
  });
  test('кэш: второй вызов без обращения к БД; invalidate сбрасывает', async () => {
    await settings.getSettings(1);
    await settings.getSettings(1);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    settings.invalidate();
    await settings.getSettings(1);
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
  });
  test('значение заморожено — вызывающий не может подменить режим в кэше', async () => {
    const s = await settings.getSettings(1);
    expect(() => { 'use strict'; s.mode = 'live'; }).toThrow();
  });
});

describe('updateSettings', () => {
  test('режим: только off|shadow|live, чужое значение игнорируется', async () => {
    await settings.updateSettings(1, { mode: 'live' });
    expect(written()[1]).toBe('live');
    settings.invalidate(); db.query.mockClear();
    await settings.updateSettings(1, { mode: 'turbo' });
    expect(written()[1]).toBe('off');
  });
  test('порядок каскада: только известные мессенджеры, без дублей, порядок сохраняется', async () => {
    await settings.updateSettings(1, { default_channels: ['max', 'sms', 'tdlib', 'max', 'telegram'] });
    expect(JSON.parse(written()[2])).toEqual(['max', 'tdlib']);
  });
  test('пустой каскад законен, но «не передано» оставляет прежний', async () => {
    await settings.updateSettings(1, { default_channels: [] });
    expect(JSON.parse(written()[2])).toEqual([]);
    settings.invalidate(); db.query.mockClear();
    await settings.updateSettings(1, { mode: 'shadow' });
    expect(JSON.parse(written()[2])).toEqual(['tdlib', 'whatsapp', 'max']);
  });
  test('тихие часы: HH:MM, пусто → NULL, мусор → BAD_TIME и ничего не пишется', async () => {
    await settings.updateSettings(1, { quiet_from: '22:30', quiet_to: '' });
    expect(written()[3]).toBe('22:30');
    expect(written()[4]).toBeNull();
    db.query.mockClear();
    await expect(settings.updateSettings(1, { quiet_from: '25:00' })).rejects.toMatchObject({ code: 'BAD_TIME' });
    await expect(settings.updateSettings(1, { quiet_to: '9:00' })).rejects.toMatchObject({ code: 'BAD_TIME' });
    expect(db.query).not.toHaveBeenCalled();
  });
  test('тексты режутся до 2000 символов, не-строки и не-булевы игнорируются', async () => {
    await settings.updateSettings(1, { confirm_reply_text: 'я'.repeat(2500), rating_high_text: 42, prefer_last_channel: 'yes', rating_escalate_low: false });
    const p = written();
    expect(p[5]).toHaveLength(2000);
    expect(p[6]).toMatch(/Спасибо за отличную оценку/);   // число не затёрло текст
    expect(p[9]).toBe(false);
    expect(p[10]).toBe(true);                              // 'yes' — не boolean: прежнее значение
  });
  test('patch=null не падает, настройки остаются прежними; кэш после записи сброшен', async () => {
    await settings.getSettings(1);
    db.oneOrNone.mockResolvedValue({ salon_id: 1, mode: 'shadow' });
    const s = await settings.updateSettings(1, null);
    expect(written()[1]).toBe('off');
    expect(s.mode).toBe('shadow');                         // после записи перечитано из БД, не из старого кэша
  });
});
