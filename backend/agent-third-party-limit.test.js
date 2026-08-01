'use strict';

const tp = require('./services/agent/third-party-limit');

// Аудит 2026-08-01: create_booking принимает произвольный client_phone («запись
// другого человека») — без лимита один диалог может насоздавать записей на чужие
// номера (людям начнут звонить из клиники). Лимит — по РАЗНЫМ номерам, не по
// записям: цепочка book_chain для одной гостьи делает несколько create_booking
// с одним номером и не должна съедать лимит.
describe('third-party-limit (чистый модуль)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00+03:00');
  beforeEach(() => tp.reset());

  describe('isThirdParty', () => {
    test('номер совпадает с номером диалога (в т.ч. 8→7) — не третье лицо', () => {
      expect(tp.isThirdParty('79200255591', '79200255591')).toBe(false);
      expect(tp.isThirdParty('89200255591', '79200255591')).toBe(false);
      expect(tp.isThirdParty('+7 920 025-55-91', '79200255591')).toBe(false);
    });
    test('другой номер — третье лицо', () => {
      expect(tp.isThirdParty('79995554433', '79200255591')).toBe(true);
    });
    test('канал без номера (ctx пуст) — любой продиктованный номер считается третьим лицом', () => {
      expect(tp.isThirdParty('79995554433', '')).toBe(true);
      expect(tp.isThirdParty('79995554433', null)).toBe(true);
    });
    test('номер не передан моделью — не третье лицо (пойдёт ctx-номер)', () => {
      expect(tp.isThirdParty('', '79200255591')).toBe(false);
      expect(tp.isThirdParty(null, null)).toBe(false);
    });
  });

  describe('allowed/record', () => {
    test('до LIMIT разных номеров — разрешено', () => {
      for (let i = 0; i < tp.LIMIT; i++) {
        const phone = `7999555443${i}`;
        expect(tp.allowed(1, 'dlg', phone, NOW)).toBe(true);
        tp.record(1, 'dlg', phone, NOW);
      }
      expect(tp.allowed(1, 'dlg', `799955544${tp.LIMIT}9`, NOW)).toBe(false);
    });
    test('повторная запись на УЖЕ записанный номер не блокируется (цепочка услуг)', () => {
      for (let i = 0; i < tp.LIMIT; i++) tp.record(1, 'dlg', `7999555443${i}`, NOW);
      expect(tp.allowed(1, 'dlg', '79995554430', NOW)).toBe(true);
    });
    test('нормализация: 8… и +7… — один и тот же номер', () => {
      tp.record(1, 'dlg', '89995554430', NOW);
      expect(tp.allowed(1, 'dlg', '+7 999 555-44-30', NOW)).toBe(true);
      tp.record(1, 'dlg', '79995554431', NOW);
      tp.record(1, 'dlg', '79995554432', NOW);
      expect(tp.allowed(1, 'dlg', '79995554433', NOW)).toBe(false);
    });
    test('окно 24 часа: старые номера выпадают', () => {
      for (let i = 0; i < tp.LIMIT; i++) tp.record(1, 'dlg', `7999555443${i}`, NOW);
      const later = NOW + 24 * 60 * 60 * 1000 + 1000;
      expect(tp.allowed(1, 'dlg', '79995554439', later)).toBe(true);
    });
    test('лимит на диалог, не глобальный', () => {
      for (let i = 0; i < tp.LIMIT; i++) tp.record(1, 'dlg-a', `7999555443${i}`, NOW);
      expect(tp.allowed(1, 'dlg-b', '79995554439', NOW)).toBe(true);
      expect(tp.allowed(2, 'dlg-a', '79995554439', NOW)).toBe(true);
    });
  });
});
