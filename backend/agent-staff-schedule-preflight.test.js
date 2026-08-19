'use strict';

const schedule = require('./services/agent/staff-schedule-preflight');

describe('staff schedule preflight', () => {
  const nowMs = Date.UTC(2026, 7, 19, 9, 0, 0);

  test('распознаёт вопрос о работе названного мастера завтра', () => {
    expect(schedule.requestedDate('Пери работает завтра?', nowMs))
      .toEqual({ date: '2026-08-20', label: 'Завтра' });
    expect(schedule.matchedStaff('Пери работает завтра?', [
      { yc_id: 10, name: 'Гаджиева Пери' }, { yc_id: 11, name: 'Астемир Боташев' },
    ])).toEqual({ yc_id: 10, name: 'Гаджиева Пери' });
  });

  test('отсутствие дня в свежем графике — не «всё занято»', async () => {
    const listStaff = jest.fn(async () => ({ staff: [{ yc_id: 10, name: 'Гаджиева Пери' }] }));
    const getAvailableDates = jest.fn(async () => ({
      schedule: [{ date: '2026-09-01', hours: [{ from: '10:00', to: '19:00' }] }],
    }));

    const out = await schedule.run({
      text: 'Пери работает завтра?', nowMs, salonId: 1, listStaff, getAvailableDates,
    });

    expect(getAvailableDates).toHaveBeenCalledWith(1, {
      staff_yc_id: 10, date_from: '2026-08-20', date_to: '2026-09-19',
    });
    expect(out.reply).toBe('Завтра Гаджиева Пери не принимает. Ближайший рабочий день — 1 сентября.');
  });

  test('вопрос о записи к названному врачу без смены отвечает графиком до выбора услуги', async () => {
    const listStaff = jest.fn(async () => ({ staff: [{ yc_id: 10, name: 'Гаджиева Пери' }] }));
    const getAvailableDates = jest.fn(async () => ({
      schedule: [{ date: '2026-09-01', hours: [{ from: '10:00', to: '19:00' }] }],
    }));

    const out = await schedule.run({
      text: 'Завтра можно к Пери записаться?', nowMs, salonId: 1, listStaff, getAvailableDates,
    });

    expect(out.reply).toBe('Завтра Гаджиева Пери не принимает. Ближайший рабочий день — 1 сентября.');
  });

  test('запрос записи в рабочий день оставляет подбор слотов обычному сценарию', async () => {
    const listStaff = jest.fn(async () => ({ staff: [{ yc_id: 10, name: 'Гаджиева Пери' }] }));
    const getAvailableDates = jest.fn(async () => ({
      schedule: [{ date: '2026-08-20', hours: [{ from: '10:00', to: '19:00' }] }],
    }));

    const out = await schedule.run({
      text: 'Завтра можно к Пери записаться?', nowMs, salonId: 1, listStaff, getAvailableDates,
    });

    expect(out).toBeNull();
  });

  test('не перехватывает вопрос о свободном времени: для него нужна услуга', async () => {
    const listStaff = jest.fn();
    const getAvailableDates = jest.fn();
    const out = await schedule.run({
      text: 'У Пери завтра в 15:00 свободно?', nowMs, salonId: 1, listStaff, getAvailableDates,
    });
    expect(out).toBeNull();
    expect(listStaff).not.toHaveBeenCalled();
  });
});
