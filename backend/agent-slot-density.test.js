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

describe('pickOfferSlots: минимум мёртвого времени до/после', () => {
  const at = (time, seconds) => ({ time, datetime: `2026-08-07T${time}:00+03:00`, seance_length: seconds });

  // Боевой день Гаджиевой Пери 07.08: смена 11:00–21:00, сплошной блок
  // 14:30–21:00, свободно 11:00–14:30, ботулинотерапия 30 мин.
  const REAL_DAY_BUSY = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '21:00']]));
  const REAL_DAY_SLOTS = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']
    .map(t => at(t, 1800));

  test('инцидент 07.08: первым идёт 14:00, а не 11:00', () => {
    const offers = density.pickOfferSlots(REAL_DAY_SLOTS, REAL_DAY_BUSY, { durationMin: 30 });
    expect(offers.map(s => s.time)).toEqual(['14:00', '13:30']);
  });

  test('слот возвращается целым объектом — datetime нужен create_booking', () => {
    const [first] = density.pickOfferSlots(REAL_DAY_SLOTS, REAL_DAY_BUSY, { durationMin: 30 });
    expect(first).toEqual(at('14:00', 1800));
  });

  test('примыкание ПОСЛЕ записи считается так же, как ПЕРЕД', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['10:00', '12:00']]));
    const slots = ['12:00', '13:00', '17:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers[0].time).toBe('12:00');
  });

  // Второй ключ сортировки: слот, закрывающий дыру ЦЕЛИКОМ, обязан выигрывать у
  // примыкающего одной стороной — иначе «плотно» получается только наполовину.
  test('точное попадание в дыру между двумя записями выигрывает', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['10:00', '12:00'], ['13:00', '15:00']]));
    // 12:00 закрывает дыру 12:00–13:00 целиком; 15:00 примыкает только слева.
    const slots = ['12:00', '15:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers[0].time).toBe('12:00');
  });

  // Регресс на сегодняшнее поведение: у пустого дня анкоров нет, и порядок
  // обязан остаться хронологическим. Тут же ловится NaN-компаратор:
  // Infinity - Infinity = NaN, и sort с таким компаратором молча ломает порядок.
  test('день без единой записи → самые ранние слоты', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', []));
    const slots = ['10:00', '11:00', '12:00', '13:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers.map(s => s.time)).toEqual(['10:00', '11:00']);
  });

  test('длительность из слота главнее durationMin', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['14:00', '16:00']]));
    // Услуга 120 мин: вплотную к 14:00 встаёт старт 12:00, а не 13:00.
    const slots = ['12:00', '13:00'].map(t => at(t, 7200));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 30 });
    expect(offers[0].time).toBe('12:00');
  });

  test('кап берётся из модуля и уважает limit', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', []));
    const slots = ['10:00', '11:00', '12:00'].map(t => at(t, 3600));
    expect(density.pickOfferSlots(slots, busy, { durationMin: 60 }))
      .toHaveLength(density.MAX_OFFER_SLOTS);
    expect(density.pickOfferSlots(slots, busy, { durationMin: 60, limit: 1 })).toHaveLength(1);
  });

  test('пустой и мусорный вход не роняют', () => {
    expect(density.pickOfferSlots([], [], {})).toEqual([]);
    expect(density.pickOfferSlots(null, null, {})).toEqual([]);
    expect(density.pickOfferSlots([{ foo: 1 }], [], {})).toEqual([]);
  });
});
