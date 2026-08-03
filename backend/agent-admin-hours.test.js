'use strict';

const ah = require('./services/agent/admin-hours');

// Аудит 2026-08-01: Мила работает и ночью (окно расписания «для всех»), когда
// живого администратора нет — «подключится с минуты на минуту» в 3 часа ночи ложь.
describe('admin-hours', () => {
  describe('isAdminOffHours', () => {
    test('внутри окна — false (администратор на месте)', () => {
      expect(ah.isAdminOffHours('12:00', '09:00-21:00')).toBe(false);
      expect(ah.isAdminOffHours('09:00', '09:00-21:00')).toBe(false); // начало включительно
    });
    test('вне окна — true', () => {
      expect(ah.isAdminOffHours('03:15', '09:00-21:00')).toBe(true);
      expect(ah.isAdminOffHours('21:00', '09:00-21:00')).toBe(true); // конец исключительно
      expect(ah.isAdminOffHours('23:59', '09:00-21:00')).toBe(true);
    });
    test('окно через полночь (start > end) поддержано', () => {
      expect(ah.isAdminOffHours('23:00', '21:00-03:00')).toBe(false);
      expect(ah.isAdminOffHours('02:00', '21:00-03:00')).toBe(false);
      expect(ah.isAdminOffHours('12:00', '21:00-03:00')).toBe(true);
    });
    test('битое окно или битое время → fail-open false (дневная фраза безопаснее)', () => {
      expect(ah.isAdminOffHours('03:00', 'кривое')).toBe(false);
      expect(ah.isAdminOffHours('03:00', '')).toBe(false);
      expect(ah.isAdminOffHours('03:00', '09:00-09:00')).toBe(false); // пустое окно
      expect(ah.isAdminOffHours('мусор', '09:00-21:00')).toBe(false);
      expect(ah.isAdminOffHours('', '09:00-21:00')).toBe(false);
    });
  });

  describe('фразы эскалации', () => {
    test('в рабочее время — прежние тексты («с минуты на минуту»)', () => {
      expect(ah.handoverText(false)).toBe(
        'Передаю ваш диалог администратору клиники — он подключится с минуты на минуту 🤍');
      expect(ah.silentFallbackText(false)).toMatch(/с минуты на минуту/);
    });
    test('вне рабочего времени — без обещания немедленного ответа', () => {
      expect(ah.handoverText(true)).not.toMatch(/с минуты на минуту/);
      expect(ah.handoverText(true)).toMatch(/в начале рабочего дня/);
      expect(ah.silentFallbackText(true)).not.toMatch(/с минуты на минуту/);
      expect(ah.silentFallbackText(true)).toMatch(/в начале рабочего дня/);
    });
  });

  test('nowHHMMMoscow формат HH:MM', () => {
    expect(ah.nowHHMMMoscow()).toMatch(/^\d{2}:\d{2}$/);
    // фиксированный момент: 2026-08-01T00:00:00Z = 03:00 мск
    expect(ah.nowHHMMMoscow(Date.UTC(2026, 7, 1, 0, 0))).toBe('03:00');
  });
});
