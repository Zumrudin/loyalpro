'use strict';

// Мила предлагала САМОЕ РАННЕЕ свободное окно и рвала день мастера.
// Инцидент 2026-08-06 (диалог 79037504378): у Гаджиевой Пери на 07.08 сплошной
// блок 14:30–21:00 и свободно 11:00–14:30, а запись ушла на 11:30 — огрызок
// 11:00–11:30 плюс 2.5 часа простоя. Вплотную к блоку встаёт только 14:00.

const density = require('./services/agent/slot-density');

// Сетка /timetable/seances: точки через 5 минут с флагом is_free.
// from/to — 'HH:MM', to ЭКСКЛЮЗИВНО. busy — интервалы [['HH:MM','HH:MM']].
function grid(from, to, busy = []) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cuts = busy.map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (let m = toMin(from); m < toMin(to); m += 5) {
    out.push({ time: toHHMM(m), is_free: !cuts.some(([a, b]) => m >= a && m < b) });
  }
  return out;
}

describe('seancesToBusy: занятость мастера из сетки сеансов', () => {
  test('интервалы склеиваются, свободное не попадает', () => {
    const busy = density.seancesToBusy(grid('11:00', '15:00', [['12:00', '13:00']]));
    expect(busy).toEqual([{ start: 12 * 60, end: 13 * 60 }]);
  });

  test('две занятости не склеиваются между собой', () => {
    const busy = density.seancesToBusy(grid('10:00', '16:00', [['11:00', '11:30'], ['14:00', '15:00']]));
    expect(busy).toEqual([
      { start: 11 * 60, end: 11 * 60 + 30 },
      { start: 14 * 60, end: 15 * 60 },
    ]);
  });

  // ГЛАВНАЯ ГОТЧА. Сетка ограничена сменой (проверено на проде: для смены
  // 11:00–21:00 пришли ровно точки 11:00…20:55). Если бы края смены попали в
  // занятость, слот в начале смены получил бы разрыв 0 «вплотную к занятому»
  // и снова побеждал бы — то есть фикс молча не работал бы на инцидентном кейсе.
  test('края смены занятостью НЕ становятся', () => {
    const busy = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '21:00']]));
    expect(busy).toEqual([{ start: 14 * 60 + 30, end: 21 * 60 }]);
    expect(busy.some(b => b.start === 11 * 60)).toBe(false);
  });

  test('пустой и мусорный вход не роняют', () => {
    expect(density.seancesToBusy([])).toEqual([]);
    expect(density.seancesToBusy(null)).toEqual([]);
    expect(density.seancesToBusy([null, { is_free: true }])).toEqual([]);
  });
});
