'use strict';

// Регресс на инцидент 2026-08-10 (79166524647): у Гаджиевой Пери отпуск 12–31.08,
// get_available_slots на каждую дату отдавал голое `slots: []` — неотличимое от
// «работает, но всё занято». Модель этого различия не видела и принялась
// подставлять окна ДРУГОГО мастера как окна Пери. Первый слой фикса: пустая
// выдача обязана СКАЗАТЬ, что мастера нет в графике, и назвать ближайший
// приёмный день.
//
// Источник правды — management /schedule (тот же, что у get_available_dates):
// на живой прод-базе он отдаёт отпуск ЯВНЫМИ строками `is_working: 0`, а не
// пустым массивом, поэтому «не работает» и «API молчит» различимы.

const { summarizeWorkingDays } = require('./services/agent/staff-schedule');

const day = (date, from, to) => ({
  date, is_working: 1, slots: [{ from, to }],
});
const off = (date) => ({ date, is_working: 0, slots: [] });

describe('summarizeWorkingDays', () => {
  test('сетки нет вовсе (молчание API) → unknown, ничего не утверждаем', () => {
    expect(summarizeWorkingDays([], { date: '2026-08-14' })).toEqual({ unknown: true });
    expect(summarizeWorkingDays(null, { date: '2026-08-14' })).toEqual({ unknown: true });
    expect(summarizeWorkingDays('oops', { date: '2026-08-14' })).toEqual({ unknown: true });
  });

  test('запрошенной даты в выдаче нет (вне окна) → unknown, а не «не работает»', () => {
    const rows = [day('2026-08-11', '11:00', '20:00')];
    expect(summarizeWorkingDays(rows, { date: '2026-08-14' })).toEqual({ unknown: true });
  });

  test('мастер в этот день работает → working:true', () => {
    const rows = [off('2026-08-10'), day('2026-08-11', '11:00', '20:00')];
    const out = summarizeWorkingDays(rows, { date: '2026-08-11' });
    expect(out.unknown).toBe(false);
    expect(out.working).toBe(true);
  });

  test('день нерабочий → working:false и ближайший рабочий ПОСЛЕ него', () => {
    const rows = [
      off('2026-08-14'), off('2026-08-15'), off('2026-08-16'),
      day('2026-08-17', '10:00', '22:00'), day('2026-08-20', '10:00', '22:00'),
    ];
    const out = summarizeWorkingDays(rows, { date: '2026-08-14' });
    expect(out.unknown).toBe(false);
    expect(out.working).toBe(false);
    expect(out.nextWorkingDate).toBe('2026-08-17');
  });

  test('is_working=1, но смен нет → день НЕ рабочий (тот же предикат, что в get_available_dates)', () => {
    const rows = [{ date: '2026-08-14', is_working: 1, slots: [] }, day('2026-08-17', '10:00', '22:00')];
    const out = summarizeWorkingDays(rows, { date: '2026-08-14' });
    expect(out.working).toBe(false);
    expect(out.nextWorkingDate).toBe('2026-08-17');
  });

  // Ровно случай Пери: отпуск до конца окна выдачи. Сказать «выйдет тогда-то»
  // нечего, и молчать об этом нельзя — иначе модель снова пойдёт перебирать даты.
  test('рабочих дней в окне нет вовсе → nextWorkingDate null', () => {
    const rows = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17'].map(off);
    const out = summarizeWorkingDays(rows, { date: '2026-08-14' });
    expect(out.working).toBe(false);
    expect(out.nextWorkingDate).toBe(null);
    expect(out.checkedUntil).toBe('2026-08-17');
  });

  // Рабочий день РАНЬШЕ запрошенной даты ближайшим считаться не может: пациенту
  // предлагают время вперёд, а не назад.
  test('рабочий день строго ПОСЛЕ запрошенной даты, прошедшие не в счёт', () => {
    const rows = [day('2026-08-11', '11:00', '20:00'), off('2026-08-14'), off('2026-08-15')];
    const out = summarizeWorkingDays(rows, { date: '2026-08-14' });
    expect(out.working).toBe(false);
    expect(out.nextWorkingDate).toBe(null);
  });

  test('is_working булевым true (YClients отдаёт и 1, и true) читается так же', () => {
    const rows = [{ date: '2026-08-17', is_working: true, slots: [{ from: '10:00', to: '22:00' }] }];
    expect(summarizeWorkingDays(rows, { date: '2026-08-17' }).working).toBe(true);
  });
});
