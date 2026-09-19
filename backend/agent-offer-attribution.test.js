'use strict';

// Третий живой прогон 2026-09-19: «Либо к вашему мастеру Татьяне на среду,
// 23 сентября. У неё есть свободное время, например, в 10:00» — 10:00 было
// у ЮЛИИ на ПОНЕДЕЛЬНИК (журнал), у Татьяны в среду старты с 13:30. Плоские
// allowedTimes/verifiedTimes сверяют один HH:MM и пропускали это. Теперь
// предложенное время сверяется по паре «дата + мастер» из контекста клаузы.

const oa = require('./services/agent/offer-attribution');
const { createSlotEvidence } = require('./services/agent/slot-evidence');

// Суббота 19.09.2026, 12:50 мск.
const NOW = Date.parse('2026-09-19T12:50:00+03:00');
const slot = (date, t) => ({ time: t, datetime: `${date}T${t}:00+03:00`, seance_length: 3000 });

function evidence() {
  const ev = createSlotEvidence();
  // Понедельник: Татьяна не работает, у Юлии (alternative) 10:00–11:30.
  ev.add('get_available_slots', { staff_yc_id: 3356928, date: '2026-09-21' }, {
    slots: [], staff_name: 'Богатырева Татьяна', staff_not_working: true,
    alternative_staff: [{ staff_yc_id: 1914276, name: 'Гатауллина Юлия',
      slots: ['10:00', '10:30', '11:00', '11:30'].map(t => slot('2026-09-21', t)) }],
  });
  // Среда: Татьяна 13:30–15:00 (стыковка).
  ev.add('get_sequential_slots', { date: '2026-09-23', preferred_staff_yc_id: 3356928 }, {
    variants: [{ type: 'same_staff', date: '2026-09-23', staff: [{ yc_id: 3356928, name: 'Богатырева Татьяна' }],
      starts: ['13:30', '14:00', '14:30', '15:00'].map(t => ({ time: t, chain: [
        { datetime: `2026-09-23T${t}:00+03:00`, staff_yc_id: 3356928, staff_name: 'Богатырева Татьяна' }] })) }],
  });
  return ev;
}

describe('resolveDate', () => {
  test('день недели → ближайшая дата вперёд (сегодня суббота 19.09)', () => {
    expect(oa.resolveDate('в среду', { nowMs: NOW })).toBe('2026-09-23');
    expect(oa.resolveDate('во вторник', { nowMs: NOW })).toBe('2026-09-22');
    expect(oa.resolveDate('на понедельник', { nowMs: NOW })).toBe('2026-09-21');
    expect(oa.resolveDate('в субботу', { nowMs: NOW })).toBe('2026-09-19');   // тот же день недели — сегодня
  });
  test('«DD месяца» главнее дня недели; DD.MM; сегодня/завтра', () => {
    expect(oa.resolveDate('в среду, 23 сентября', { nowMs: NOW })).toBe('2026-09-23');
    expect(oa.resolveDate('на 1 октября', { nowMs: NOW })).toBe('2026-10-01');
    expect(oa.resolveDate('23.09', { nowMs: NOW })).toBe('2026-09-23');
    expect(oa.resolveDate('завтра', { nowMs: NOW })).toBe('2026-09-20');
    expect(oa.resolveDate('сегодня', { nowMs: NOW })).toBe('2026-09-19');
  });
  test('без даты → null; «средство»/«среди» — не среда', () => {
    expect(oa.resolveDate('в 10:00', { nowMs: NOW })).toBeNull();
    expect(oa.resolveDate('средство среди прочих', { nowMs: NOW })).toBeNull();
  });
});

describe('checkOfferAttribution', () => {
  const opts = () => ({ evidence: evidence(), nowMs: NOW, patientTimes: new Set() });

  test('боевая реплика: «к Татьяне на среду … 10:00» → unverified_offer_date с реальными временами', () => {
    const v = oa.checkOfferAttribution(
      'Могу предложить перенести запись к Юлии на понедельник, 21 сентября, в 10:00.\n' +
      'Либо к вашему мастеру Татьяне на среду, 23 сентября. У неё есть свободное время, например, в **10:00**.',
      opts());
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe('unverified_offer_date');
    expect(v[0].value).toMatch(/23\.09/);
    expect(v[0].value).toMatch(/10:00/);
    expect(v[0].value).toMatch(/Татьян/);
    expect(v[0].value).toMatch(/13:30/);   // реальная выдача на эту дату у этого мастера
  });

  test('честная реплика проходит: Юлия пн 10:00, Татьяна ср 13:30/14:00', () => {
    const v = oa.checkOfferAttribution(
      'Во вторник у Татьяны выходной. Ближайший рабочий день — среда, 23 сентября: могу предложить к ней 13:30 или 14:00. ' +
      'Если принципиален вторник — Юлия в понедельник в 10:00.',
      opts());
    expect(v).toEqual([]);
  });

  test('контекст даты и мастера переносится на следующие строки (список времён)', () => {
    const ok = oa.checkOfferAttribution(
      'В среду, 23 сентября, у Татьяны есть свободное время:\n*   **13:30**\n*   **14:00**\nКакой вариант удобнее?',
      opts());
    expect(ok).toEqual([]);
    const bad = oa.checkOfferAttribution(
      'В среду, 23 сентября, у Татьяны есть свободное время:\n*   **10:00**\n*   **13:30**',
      opts());
    expect(bad.map(x => x.type)).toEqual(['unverified_offer_date']);
    expect(bad[0].value).toMatch(/10:00/);
  });

  test('дата есть, мастер не назван → сверка по дате с любым мастером', () => {
    expect(oa.checkOfferAttribution('В понедельник есть окошко в 10:00.', opts())).toEqual([]);
    expect(oa.checkOfferAttribution('В понедельник есть окошко в 13:30.', opts()).map(x => x.type))
      .toEqual(['unverified_offer_date']);
  });

  test('мастер назван, даты нет → сверка по мастеру на любую дату', () => {
    expect(oa.checkOfferAttribution('У Юлии есть 10:30.', opts())).toEqual([]);
    expect(oa.checkOfferAttribution('У Татьяны есть 10:30.', opts()).map(x => x.type)).toEqual(['unverified_offer_date']);
  });

  test('ни даты, ни мастера → проверка молчит (её ведёт плоский unverified_offer)', () => {
    expect(oa.checkOfferAttribution('Есть окошко в 19:00.', opts())).toEqual([]);
  });

  test('не предложения: занятость, часы работы, существующая запись, время пациента', () => {
    const o = opts();
    expect(oa.checkOfferAttribution('В среду у Татьяны 10:00 уже занято.', o)).toEqual([]);
    expect(oa.checkOfferAttribution('Клиника работает ежедневно с 10:00 до 22:00.', o)).toEqual([]);
    expect(oa.checkOfferAttribution('Вы записаны на воскресенье, 20 сентября, в 17:30 к Татьяне.', o)).toEqual([]);
    expect(oa.checkOfferAttribution('Ваша запись в среду на 17:30 к Татьяне остаётся.', o)).toEqual([]);
    expect(oa.checkOfferAttribution('Да, в среду к Татьяне на 10:00 — записываю.',
      { ...o, patientTimes: new Set(['10:00']) })).toEqual([]);
  });

  test('без evidence или без nowMs — молчит', () => {
    expect(oa.checkOfferAttribution('В среду у Татьяны 10:00.', { nowMs: NOW })).toEqual([]);
    expect(oa.checkOfferAttribution('В среду у Татьяны 10:00.', { evidence: evidence() })).toEqual([]);
  });
});

test('склонение короткого имени: «к Юлии» переключает контекст мастера', () => {
  const ev = createSlotEvidence();
  ev.add('get_available_slots', { staff_yc_id: 3356928, date: '2026-09-21' }, {
    slots: [], staff_name: 'Богатырева Татьяна',
    alternative_staff: [{ staff_yc_id: 1914276, name: 'Гатауллина Юлия', slots: [slot('2026-09-21', '10:00')] }],
  });
  ev.add('get_available_slots', { staff_yc_id: 3356928, date: '2026-09-23' }, {
    staff_name: 'Богатырева Татьяна', slots: [slot('2026-09-23', '13:30')],
  });
  const v = oa.checkOfferAttribution(
    'Во вторник у Татьяны выходной. К Юлии в понедельник в 10:00, либо к Татьяне в среду, 23 сентября, в 13:30.',
    { evidence: ev, nowMs: NOW, patientTimes: new Set() });
  expect(v).toEqual([]);
});
