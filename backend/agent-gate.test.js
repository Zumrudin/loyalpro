'use strict';
const { normalizePhoneKey, decideGate } = require('./services/agent-gate');

describe('normalizePhoneKey', () => {
  test('РФ 8→7 для 11 цифр', () => {
    expect(normalizePhoneKey('89200255591')).toBe('79200255591');
  });
  test('оставляет 7XXXXXXXXXX как есть', () => {
    expect(normalizePhoneKey('79200255591')).toBe('79200255591');
  });
  test('чистит форматирование и +', () => {
    expect(normalizePhoneKey('+7 (920) 025-55-91')).toBe('79200255591');
  });
  test('10-значное ядро → префикс 7', () => {
    expect(normalizePhoneKey('9200255591')).toBe('79200255591');
  });
  test('пустой/мусор → пустая строка', () => {
    expect(normalizePhoneKey('')).toBe('');
    expect(normalizePhoneKey(null)).toBe('');
  });
});

describe('decideGate', () => {
  const base = { enabled: true, mode: 'all', allow: [], block: [], phone: '79200255591' };

  test('выключен → deny', () => {
    expect(decideGate({ ...base, enabled: false })).toEqual({ allow: false, reason: 'disabled' });
  });
  test('режим all пропускает незнакомый номер', () => {
    expect(decideGate({ ...base })).toEqual({ allow: true, reason: 'ok' });
  });
  test('чёрный список сильнее (даже в режиме all)', () => {
    expect(decideGate({ ...base, block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
  test('whitelist: номер в белом (после 8→7) → allow', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '89200255591' }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('whitelist: номера нет в белом → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79990001122'] }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('whitelist: пустой номер (Telegram chat_id) → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '' }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('чёрный список срабатывает и в whitelist', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
});
