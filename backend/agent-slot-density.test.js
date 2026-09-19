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

  // Правка 07.08: ОДНО время на анкор. Раньше топ-2 по стоимости давал 14:00 и
  // 13:30 — соседние окошки одного и того же свободного куска: если пациент
  // возьмёт 13:30, между ним и блоком останется дыра 30 минут, то есть второе
  // время не просто бесполезно, а вредно.
  test('инцидент 07.08: ровно одно время — 14:00, соседнего 13:30 рядом нет', () => {
    const offers = density.pickOfferSlots(REAL_DAY_SLOTS, REAL_DAY_BUSY, { durationMin: 30 });
    expect(offers.map(s => s.time)).toEqual(['14:00']);
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

  // ── Одно время на КАЖДЫЙ край занятого блока ──
  // Ровно то, о чём просил салон: одно вплотную ПЕРЕД началом занятого периода и
  // одно вплотную ПОСЛЕ его конца. Два соседних окошка одного куска — нет.
  test('свободно до и после блока → перед началом и после конца, а не два соседних', () => {
    const busy = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '18:00']]));
    const slots = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00',
      '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'].map(t => at(t, 1800));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 30 });
    expect(offers.map(s => s.time)).toEqual(['14:00', '18:00']);
  });

  // Дыра в середине дня закрывается с ДВУХ сторон, и это два разных анкора:
  // 11:30 подпирает начало блока, 13:00 продолжает его конец.
  test('запись в середине дня → 11:30 (перед) и 13:00 (после)', () => {
    const busy = density.seancesToBusy(grid('11:00', '21:00', [['12:00', '13:00']]));
    const slots = ['11:00', '11:30', '13:00', '13:30', '14:00'].map(t => at(t, 1800));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 30 });
    expect(offers.map(s => s.time)).toEqual(['11:30', '13:00']);
  });

  // Дедуп идёт по КРАЮ, к которому слот примыкает, а не по блоку: у одного блока
  // два края, и оба законны. Обратное (дедуп по блоку) выбросило бы «после конца».
  test('два блока → по одному времени, самые плотные', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['11:00', '12:00'], ['16:00', '17:00']]));
    const slots = ['10:00', '10:30', '12:00', '12:30', '15:30', '17:00', '17:30'].map(t => at(t, 1800));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 30 });
    // Анкоров четыре (по два края у каждого блока), кап отдаёт два лучших. Разрыв
    // 0 у всех четырёх, поэтому решает ВТОРАЯ сторона: 12:00 и 15:30 подпирают
    // серединную дыру 12:00–16:00 с обоих концов, а у 10:30/17:00 с внешней
    // стороны занятости нет вовсе (far=Infinity) — они дальше в очереди.
    expect(offers).toHaveLength(density.MAX_OFFER_SLOTS);
    expect(offers.map(s => s.time)).toEqual(['12:00', '15:30']);
  });

  // Регресс на fail-open: занятость НЕ известна (сетка не ответила) — анкоров нет,
  // и порядок обязан остаться хронологическим. Тут же ловится NaN-компаратор:
  // Infinity - Infinity = NaN, и sort с таким компаратором молча ломает порядок.
  // На РЕАЛЬНО свободном дне инструмент времени уже не называет (chooseOffer →
  // freeDay), но сам примитив обязан деградировать в «самые ранние», а не в пустоту.
  test('занятости нет вовсе → самые ранние слоты', () => {
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

// ── Половина дня: пациент назвал её сам, дальше время подбираем внутри неё ──
describe('filterByDayPart', () => {
  const at = (time) => ({ time, datetime: `2026-08-07T${time}:00+03:00` });
  const DAY = ['11:00', '13:30', '14:00', '16:30', '17:00', '20:30'].map(at);

  test('утро — старты строго ДО 14:00', () => {
    expect(density.filterByDayPart(DAY, 'morning').map(s => s.time)).toEqual(['11:00', '13:30']);
  });

  test('после обеда — с 14:00 и до конца смены', () => {
    expect(density.filterByDayPart(DAY, 'afternoon').map(s => s.time))
      .toEqual(['14:00', '16:30', '17:00', '20:30']);
  });

  // «Вечером» пациенты говорят чаще, чем «во второй половине», и вечер — не то же
  // самое, что после обеда: 14:00 вечером никто не назовёт.
  test('вечер — с 17:00', () => {
    expect(density.filterByDayPart(DAY, 'evening').map(s => s.time)).toEqual(['17:00', '20:30']);
  });

  // Неизвестное значение НЕ фильтрует: модель могла прислать 'утро' или 'day'.
  // Пустой список означал бы «в этой половине ничего нет» — то есть выдуманный
  // отказ клиники из-за опечатки модели.
  test('незнакомая половина дня фильтром не считается', () => {
    expect(density.filterByDayPart(DAY, 'вечер')).toHaveLength(DAY.length);
    expect(density.filterByDayPart(DAY, null)).toHaveLength(DAY.length);
  });

  // Дизъюнкция («или утро, или ближе к вечеру», инцидент 79651442032) — dayPart
  // массивом, слот проходит, если попал ХОТЯ БЫ в одну из частей. 14:00 и 16:30
  // остаются исключены — это и есть «днём», от которого пациентка отказалась
  // словами «Днем не могу».
  test('массив частей — объединение, а не пересечение', () => {
    expect(density.filterByDayPart(DAY, ['morning', 'evening']).map(s => s.time))
      .toEqual(['11:00', '13:30', '17:00', '20:30']);
  });

  test('массив с одной неизвестной частью — считается только валидная', () => {
    expect(density.filterByDayPart(DAY, ['morning', 'обед']).map(s => s.time))
      .toEqual(['11:00', '13:30']);
  });

  test('массив без единой валидной части / пустой массив — фильтром не считается', () => {
    expect(density.filterByDayPart(DAY, ['обед', 'вечер'])).toHaveLength(DAY.length);
    expect(density.filterByDayPart(DAY, [])).toHaveLength(DAY.length);
  });
});

describe('chooseOffer: свободный день, половина дня, деградация', () => {
  const at = (time, seconds = 1800) => ({ time, datetime: `2026-08-07T${time}:00+03:00`, seance_length: seconds });
  const FREE_DAY = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30',
    '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30',
    '20:00', '20:30'].map(t => at(t));
  const BUSY_DAY_SLOTS = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'].map(t => at(t));
  const BUSY_DAY = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '21:00']]));

  // Утверждено с салоном: у мастера без единой записи «плотного» времени не
  // существует — любое создаёт две дыры. Вместо угадывания спрашиваем половину дня.
  test('день без записей → времени не предлагаем, freeDay', () => {
    const r = density.chooseOffer(FREE_DAY, [], { busyKnown: true, durationMin: 30 });
    expect(r).toEqual({ offer: [], freeDay: true, dayPartEmpty: false });
  });

  test('пациент назвал половину дня → края этой половины, freeDay снят', () => {
    const r = density.chooseOffer(FREE_DAY, [], { busyKnown: true, durationMin: 30, dayPart: 'morning' });
    expect(r.offer.map(s => s.time)).toEqual(['11:00', '13:30']);
    expect(r.freeDay).toBe(false);
  });

  // Половина дня названа — второй раз спрашивать нельзя (модель зациклилась бы на
  // том же вопросе), поэтому freeDay не выставляется НИКОГДА при заданном day_part.
  test('вечер на свободном дне → края вечера', () => {
    const r = density.chooseOffer(FREE_DAY, [], { busyKnown: true, durationMin: 30, dayPart: 'evening' });
    expect(r.offer.map(s => s.time)).toEqual(['17:00', '20:30']);
    expect(r.freeDay).toBe(false);
  });

  // Занятость НЕ известна (сетка не ответила) — «день свободен» утверждать нельзя:
  // деградируем в прежнее поведение (самые ранние), а не в вопрос о половине дня.
  test('занятость неизвестна → прежние самые ранние, freeDay не выставляется', () => {
    const r = density.chooseOffer(FREE_DAY, [], { busyKnown: false, durationMin: 30 });
    expect(r.offer.map(s => s.time)).toEqual(['11:00', '11:30']);
    expect(r.freeDay).toBe(false);
  });

  test('день с записями → анкоры, половина дня их сужает', () => {
    expect(density.chooseOffer(BUSY_DAY_SLOTS, BUSY_DAY, { busyKnown: true, durationMin: 30 }).offer
      .map(s => s.time)).toEqual(['14:00']);
    // Просьба пациента важнее плотности: 14:00 «до обеда» уже не относится (граница
    // 14:00 исключительна), поэтому внутри утра самое плотное — 13:30.
    const r = density.chooseOffer(BUSY_DAY_SLOTS, BUSY_DAY, { busyKnown: true, durationMin: 30, dayPart: 'morning' });
    expect(r.offer.map(s => s.time)).toEqual(['13:30']);
    expect(r.dayPartEmpty).toBe(false);
  });

  // Пациент назвал половину, в которой у мастера всё занято. Молчать нельзя, но и
  // спрашивать заново нечего: отдаём время из ОСТАЛЬНОГО дня и флаг, по которому
  // промпт велит честно сказать «в это время всё занято».
  test('в названной половине дня пусто → dayPartEmpty + время из остального дня', () => {
    const r = density.chooseOffer(BUSY_DAY_SLOTS, BUSY_DAY, { busyKnown: true, durationMin: 30, dayPart: 'evening' });
    expect(r.dayPartEmpty).toBe(true);
    expect(r.offer.map(s => s.time)).toEqual(['14:00']);
    expect(r.freeDay).toBe(false);
  });

  // Смена начинается после обеда, а пациент просит утро: половина пуста, день при
  // этом свободен целиком — вопрос о половине дня уже задавался, поэтому здесь
  // именно времена (края смены), а не второй такой же вопрос.
  test('свободный день + пустая половина → края смены, а не повторный вопрос', () => {
    const afternoonOnly = ['15:00', '15:30', '16:00', '16:30', '17:00'].map(t => at(t));
    const r = density.chooseOffer(afternoonOnly, [], { busyKnown: true, durationMin: 30, dayPart: 'morning' });
    expect(r.dayPartEmpty).toBe(true);
    expect(r.freeDay).toBe(false);
    expect(r.offer.map(s => s.time)).toEqual(['15:00', '17:00']);
  });

  test('слотов нет вовсе → ни freeDay, ни времени', () => {
    expect(density.chooseOffer([], [], { busyKnown: true })).toEqual({ offer: [], freeDay: false, dayPartEmpty: false });
    expect(density.chooseOffer(null, null, {})).toEqual({ offer: [], freeDay: false, dayPartEmpty: false });
  });

  // ── Дизъюнкция «или утро, или вечер» (инцидент 79651442032) ──
  describe('dayPart массивом — обе части union', () => {
    // Один блок занятости 09:00–09:30, свободно до и после в пределах утра, и
    // отдельный блок 12:00–12:30 — у утра ДВА чистых анкора (near=0 у обоих:
    // 08:30 примыкает к первому блоку, 11:30 — ко второму). У вечера ОДИН анкор
    // похуже (near=30 у 17:00). Глобальный ранкер без разбивки по частям взял бы
    // ОБА лучших анкора из утра (near=0 у обоих бьёт near=30 у вечера) и вечер
    // выпал бы целиком — ровно тот дефект, который эта спека чинит.
    const busy = density.seancesToBusy(grid('08:00', '20:00',
      [['09:00', '09:30'], ['12:00', '12:30'], ['18:00', '18:30']]));
    const slots = ['08:30', '11:30', '17:00'].map(t => at(t));

    test('обе части непустые → в offer есть время и из утра, и из вечера', () => {
      const r = density.chooseOffer(slots, busy,
        { busyKnown: true, durationMin: 30, dayPart: ['morning', 'evening'] });
      const times = r.offer.map(s => s.time);
      expect(times.some(t => t < '14:00')).toBe(true);
      expect(times.some(t => t >= '17:00')).toBe(true);
      expect(r.dayPartEmpty).toBe(false);
    });

    // Вечер в этой выдаче пуст (BUSY_DAY_SLOTS не заходит за 14:00) — union
    // непуст только за счёт утра, весь лимит достаётся ему, как одиночному
    // dayPart: результат обязан совпасть с чистым 'morning'.
    test('только одна часть непустая → полный лимит достаётся ей, как одиночному dayPart', () => {
      const single = density.chooseOffer(BUSY_DAY_SLOTS, BUSY_DAY,
        { busyKnown: true, durationMin: 30, dayPart: 'morning' });
      const union = density.chooseOffer(BUSY_DAY_SLOTS, BUSY_DAY,
        { busyKnown: true, durationMin: 30, dayPart: ['morning', 'evening'] });
      expect(union.offer.map(s => s.time)).toEqual(single.offer.map(s => s.time));
      expect(union.dayPartEmpty).toBe(false);
    });

    // Ни утра, ни вечера в выдаче нет вовсе (только середина дня) — dayPartEmpty
    // на ОБЪЕДИНЕНИИ, тот же контракт, что у одиночной части.
    test('обе части пусты → dayPartEmpty на объединении', () => {
      const afternoonOnly = ['15:00', '15:30', '16:00', '16:30'].map(t => at(t));
      const r = density.chooseOffer(afternoonOnly, [],
        { busyKnown: true, durationMin: 30, dayPart: ['morning', 'evening'] });
      expect(r.dayPartEmpty).toBe(true);
      expect(r.offer.length).toBeGreaterThan(0);
    });

    // Свободный день (busy=[]) + обе части — края КАЖДОЙ части, freeDay снят
    // (вопрос о половине дня уже отвечен дизъюнкцией).
    test('свободный день + обе части → края каждой части, а не повторный вопрос', () => {
      const r = density.chooseOffer(FREE_DAY, [],
        { busyKnown: true, durationMin: 30, dayPart: ['morning', 'evening'] });
      expect(r.freeDay).toBe(false);
      const times = r.offer.map(s => s.time);
      expect(times.some(t => t < '14:00')).toBe(true);
      expect(times.some(t => t >= '17:00')).toBe(true);
    });
  });
});
