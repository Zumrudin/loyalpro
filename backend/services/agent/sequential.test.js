'use strict';

const seq = require('./sequential');

// Интервалы в минутах от полуночи, [start, end). 600=10:00, 630=10:30, 720=12:00.
const R = (start, end) => ({ start, end });

describe('fitChain', () => {
  test('две услуги встык в одном окне', () => {
    // Окно 10:00–13:00 у обоих мастеров; био 30 мин + чистка 90 мин.
    const entries = [
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 630], totalGap: 0 });
  });

  test('первая услуга не влезает в t — null', () => {
    const entries = [
      { ranges: [R(600, 620)], durationMin: 30 },   // окно 20 мин < 30
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    expect(seq.fitChain(entries, 600)).toBeNull();
  });

  test('зазор ≤15 мин допустим и попадает в totalGap', () => {
    // Чистка может начаться не раньше 10:40 (окно второй услуги с 640) → зазор 10 мин.
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(640, 780)], durationMin: 90 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 640], totalGap: 10 });
  });

  test('зазор >15 мин по умолчанию отвергается', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(650, 780)], durationMin: 90 },   // зазор 20 мин
    ];
    expect(seq.fitChain(entries, 600)).toBeNull();
  });

  test('maxLinkGap=Infinity пропускает большой перерыв', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(1230, 1320)], durationMin: 90 },  // 20:30–22:00
    ];
    const fit = seq.fitChain(entries, 600, { maxLinkGap: Infinity });
    expect(fit).toEqual({ starts: [600, 1230], totalGap: 600 });
  });

  test('старт следующей услуги выравнивается к 5-мин сетке', () => {
    // Первая заканчивается в 10:33 → следующая не в 10:33, а в 10:35.
    const entries = [
      { ranges: [R(600, 633)], durationMin: 33 },
      { ranges: [R(600, 780)], durationMin: 60 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 635], totalGap: 2 });
  });

  test('три услуги цепочкой', () => {
    const entries = [
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 60 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 630, 660], totalGap: 0 });
  });

  test('зазор ровно 15 мин — принимается (граница включительно)', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(645, 780)], durationMin: 90 },   // зазор 15 мин
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 645], totalGap: 15 });
  });

  test('вторая услуга перескакивает слишком маленькое окно', () => {
    // Первое окно второй услуги (600–620) мало для 90 мин — берётся 650, но зазор 20 > 15 → null;
    // с maxLinkGap: Infinity — собирается в 650.
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(600, 620), R(650, 780)], durationMin: 90 },
    ];
    expect(seq.fitChain(entries, 600)).toBeNull();
    expect(seq.fitChain(entries, 600, { maxLinkGap: Infinity }))
      .toEqual({ starts: [600, 650], totalGap: 20 });
  });
});

describe('fitChain — anchorFirst (первая услуга уже забронирована)', () => {
  test('первая услуга фиксирована вне свободных окон мастера, вторая стыкуется после', () => {
    // Чистка уже стоит 15:30–16:30 (930–990). В графике это ЗАНЯТО собственной
    // записью, поэтому ranges первой услуги пусты — обычный fitChain бы её отверг.
    // Врач-консультант свободен 17:00–18:00 (1020–1080) → минимальный перерыв, старт 17:00.
    const entries = [
      { ranges: [], durationMin: 60 },
      { ranges: [R(1020, 1080)], durationMin: 30 },
    ];
    const fit = seq.fitChain(entries, 930, { anchorFirst: true, maxLinkGap: Infinity });
    expect(fit).toEqual({ starts: [930, 1020], totalGap: 30 });
  });

  test('вторая услуга встык (зазор ≤15) при закреплённой первой', () => {
    // Чистка 930–990; врач свободен с 990 → консультация ровно встык, gap 0.
    const entries = [
      { ranges: [], durationMin: 60 },
      { ranges: [R(990, 1080)], durationMin: 30 },
    ];
    const fit = seq.fitChain(entries, 930, { anchorFirst: true });
    expect(fit).toEqual({ starts: [930, 990], totalGap: 0 });
  });

  test('без anchorFirst та же цепочка невозможна (окно первой услуги пусто) → null', () => {
    const entries = [
      { ranges: [], durationMin: 60 },
      { ranges: [R(1020, 1080)], durationMin: 30 },
    ];
    expect(seq.fitChain(entries, 930, { maxLinkGap: Infinity })).toBeNull();
  });

  test('anchorFirst: вторая услуга вообще не влезает после якоря → null', () => {
    const entries = [
      { ranges: [], durationMin: 60 },
      { ranges: [R(600, 700)], durationMin: 30 },   // окно врача ДО чистки — после 990 пусто
    ];
    expect(seq.fitChain(entries, 930, { anchorFirst: true, maxLinkGap: Infinity })).toBeNull();
  });
});

describe('chainStarts', () => {
  test('перебирает сетку 30 мин и требует полного размещения', () => {
    // Окно 10:00–12:30. Цепочка 30+90=120 мин → старты только 10:00 и 10:30.
    const entries = [
      { ranges: [R(600, 750)], durationMin: 30 },
      { ranges: [R(600, 750)], durationMin: 90 },
    ];
    const starts = seq.chainStarts(entries).map(c => c.start);
    expect(starts).toEqual([600, 630]);
  });

  test('окна разных мастеров учитываются раздельно', () => {
    // У первого мастера окно 10:00–10:30, у второго 10:30–12:00 → единственный старт 10:00.
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(630, 720)], durationMin: 90 },
    ];
    const chains = seq.chainStarts(entries);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toEqual({ start: 600, starts: [600, 630], totalGap: 0 });
  });

  test('пустые окна → пусто', () => {
    const entries = [
      { ranges: [], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    expect(seq.chainStarts(entries)).toEqual([]);
  });
});

describe('bestGapChain', () => {
  test('выбирает минимальный суммарный перерыв', () => {
    // Старт 10:00 → чистка ждёт до 20:30 (перерыв 600 мин).
    // Старт 19:30 (окно 19:30–20:00) → чистка в 20:30 (перерыв 30 мин) — лучше.
    const entries = [
      { ranges: [R(600, 630), R(1170, 1200)], durationMin: 30 },
      { ranges: [R(1230, 1320)], durationMin: 90 },
    ];
    const best = seq.bestGapChain(entries);
    expect(best).toEqual({ start: 1170, starts: [1170, 1230], totalGap: 30 });
  });

  test('ничего не собирается → null', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [], durationMin: 90 },
    ];
    expect(seq.bestGapChain(entries)).toBeNull();
  });
});
