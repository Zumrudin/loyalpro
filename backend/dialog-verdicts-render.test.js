// backend/dialog-verdicts-render.test.js
'use strict';
// Вердикты ИИ по перепискам: таксономия статусов и признак автоуведомления о записи.
// Спека docs/superpowers/specs/2026-10-04-dialog-verdicts-design.md.
const { STATUSES, STATUS_CODES, TAXONOMY_VERSION, BOOKING_NOTICE_RE, UNANALYZED } =
  require('./services/dialog-verdicts/taxonomy');

describe('taxonomy', () => {
  test('восемь стартовых статусов, other последний, версия 1', () => {
    expect(STATUS_CODES).toEqual(['booked', 'declined', 'pending', 'reschedule', 'question', 'broadcast_reply', 'no_dialog', 'other']);
    expect(TAXONOMY_VERSION).toBe(1);
    expect(UNANALYZED).toBe('unanalyzed');
    expect(STATUS_CODES).not.toContain(UNANALYZED);
  });
  test('у каждого статуса есть label, short и определение для промпта', () => {
    for (const s of STATUSES) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.short).toBe('string');
      expect(s.def.length).toBeGreaterThan(10);
    }
  });
});

describe('BOOKING_NOTICE_RE', () => {
  test('ловит реальный текст уведомления YClients', () => {
    expect(BOOKING_NOTICE_RE.test('Вы записаны на прием 09.10.2026 19:00 в «PERI CLINIC».\nПо адресу: ул. Генерала Белова')).toBe(true);
  });
  test('не ловит напоминание о записи и подтверждение', () => {
    expect(BOOKING_NOTICE_RE.test('Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись 09.10.2026 19:00')).toBe(false);
    expect(BOOKING_NOTICE_RE.test('✅ Ваша запись подтверждена.\nБудем ждать вас!')).toBe(false);
  });
});
