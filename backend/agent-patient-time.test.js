'use strict';

// Инцидент 2026-09-16 (79774224184): пациентка попросила «Давайте на четверг на
// 21:30», инструмент вернул 21:30 в полном slots, но подобранный offer_slots
// (плотность) был [18:00, 13:00] — и модель объявила 21:30 занятым. Правило
// промпта «названное пациентом время подтверждай, если оно есть в slots» она
// проиграла правилу «называй ТОЛЬКО из offer_slots». Решение принимает код:
// время, названное пациентом и реально свободное, встаёт ПЕРВЫМ в offer_slots.

const pt = require('./services/agent/patient-time');

const slot = (t) => ({ time: t, datetime: `2026-09-17T${t}:00+03:00`, seance_length: 900 });
const SLOTS = ['10:00', '13:00', '18:00', '21:30'].map(slot);
const OFFER = ['18:00', '13:00'].map(slot);

describe('promotePatientTime', () => {
  test('боевой случай: 21:30 названо пациентом и есть в slots → первым в offer_slots', () => {
    const r = pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: 'Давайте на четверг на 21:30' });
    expect(r.matched).toEqual(['21:30']);
    expect(r.offer.map(s => s.time)).toEqual(['21:30', '18:00', '13:00']);
    // Объект — ИЗ slots (тот же datetime/seance_length для reschedule_booking).
    expect(r.offer[0]).toBe(SLOTS[3]);
  });

  test('названное время не в slots → offer не меняется, matched пуст', () => {
    const r = pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: 'можно на 19:00?' });
    expect(r.matched).toEqual([]);
    expect(r.offer).toEqual(OFFER);
  });

  test('без текста пациента / без времени в нём — как было', () => {
    expect(pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: '' }).offer).toEqual(OFFER);
    expect(pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: 'а вечером есть?' }).offer).toEqual(OFFER);
    expect(pt.promotePatientTime({ slots: SLOTS, offer: OFFER }).matched).toEqual([]);
  });

  test('точечная форма «21.30» распознаётся как время', () => {
    const r = pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: 'давайте в 21.30' });
    expect(r.matched).toEqual(['21:30']);
  });

  test('время уже в offer_slots → поднимается вперёд без дубля', () => {
    const r = pt.promotePatientTime({ slots: SLOTS, offer: OFFER, patientText: 'на 13:00' });
    expect(r.offer.map(s => s.time)).toEqual(['13:00', '18:00']);
  });

  test('offer пуст (free_day) → названное свободное время всё равно встаёт в offer', () => {
    const r = pt.promotePatientTime({ slots: SLOTS, offer: [], patientText: 'в 18:00 удобно' });
    expect(r.offer.map(s => s.time)).toEqual(['18:00']);
    expect(r.matched).toEqual(['18:00']);
  });

  test('дата «17.09» временем не считается', () => {
    const r = pt.promotePatientTime({ slots: ['17:09'].map(slot), offer: [], patientText: 'на 17.09' });
    expect(r.matched).toEqual([]);
  });
});

describe('hintPatientTimeFree', () => {
  test('хинт называет время и запрещает объявлять его занятым', () => {
    const h = pt.hintPatientTimeFree(['21:30']);
    expect(h).toContain('21:30');
    expect(h).toMatch(/СВОБОДН/);
    expect(h).toMatch(/занят/i);
  });
});

// Инцидент 2026-09-19 (79651442032), ход 3: пациентка просила утро, у Юлии
// свободно с 10:00, а модель предложила 18:00/20:30 из offer_slots плотности —
// day_part не передала. Половину дня из СЛОВ пациента теперь читает код.
describe('parseDayPart', () => {
  test('утро / вечер / день', () => {
    expect(pt.parseDayPart('Можно перенести на пн утро?')).toBe('morning');
    expect(pt.parseDayPart('В среду утром возможно?')).toBe('morning');
    expect(pt.parseDayPart('лучше вечером')).toBe('evening');
    expect(pt.parseDayPart('ближе к вечеру')).toBe('evening');
    expect(pt.parseDayPart('днём')).toBe('afternoon');
    expect(pt.parseDayPart('после обеда')).toBe('afternoon');
  });

  // Инцидент 79651442032, реплей 19.09 19:31: «Или утро или ближе к вечеру» —
  // корректное ограничение «подходит A ИЛИ B», а не противоречие. Массив в
  // порядке упоминания, а не набор/объект — дальше он идёт как есть в
  // filterByDayPart и в порядок офферов.
  test('дизъюнкция «или A или B» → массив обеих частей', () => {
    expect(pt.parseDayPart('Или утро или ближе к вечеру')).toEqual(['morning', 'evening']);
    expect(pt.parseDayPart('либо днём, либо вечером')).toEqual(['afternoon', 'evening']);
    expect(pt.parseDayPart('вечером или утром')).toEqual(['evening', 'morning']);
  });

  test('две половины БЕЗ разделительного союза → null (как раньше)', () => {
    expect(pt.parseDayPart('утро, вечер — как получится')).toBeNull();
  });

  test('три половины в тексте, даже с «или» → null (это «любое время»)', () => {
    expect(pt.parseDayPart('утром, днём или вечером — как угодно')).toBeNull();
  });

  test('отрицание в тексте → null («утром не могу» — не просьба об утре)', () => {
    expect(pt.parseDayPart('утром не могу')).toBeNull();
    expect(pt.parseDayPart('кроме утра')).toBeNull();
    expect(pt.parseDayPart('нет, вечером')).toBeNull();
  });

  test('без указания половины дня — null; не-строка — null', () => {
    expect(pt.parseDayPart('Вт время?')).toBeNull();
    expect(pt.parseDayPart('')).toBeNull();
    expect(pt.parseDayPart(null)).toBeNull();
    expect(pt.parseDayPart(['утром'])).toBeNull();
  });

  test('«доброе утро» — приветствие, не половина дня', () => {
    expect(pt.parseDayPart('Доброе утро. Можно перенести на пн?')).toBeNull();
    expect(pt.parseDayPart('Добрый вечер! Есть время в четверг?')).toBeNull();
  });
});

// Инцидент 79651442032, ход 6 реплея 19.09 19:32: «Нет» + «Днем не могу» после
// «Или утро или ближе к вечеру» двумя сообщениями раньше. Текущее сообщение
// само по себе даёт null (отрицание), но патиентка уже назвала обе устраивающие
// её половины — короткая память досматривает предыдущие сообщения ПАЦИЕНТА.
describe('parseDayPartFromRecent', () => {
  test('текущее сообщение без сигнала → берёт метку из предыдущего', () => {
    const texts = ['Или утро или ближе к вечеру', 'Днем не могу'];
    expect(pt.parseDayPartFromRecent(texts)).toEqual(['morning', 'evening']);
  });

  test('текущее сообщение само даёт сигнал → берётся оно, дальше не смотрим', () => {
    const texts = ['Или утро или ближе к вечеру', 'а давайте утром'];
    expect(pt.parseDayPartFromRecent(texts)).toBe('morning');
  });

  test('нигде в окне сигнала нет → null', () => {
    expect(pt.parseDayPartFromRecent(['Вт время?', 'Нет', 'Днем не могу'])).toBeNull();
  });

  test('окно ограничено DAY_PART_LOOKBACK — дальше не заглядывает', () => {
    // 3 «пустых» сообщения между меткой и текущим — метка уже за окном (лимит 4).
    const texts = ['лучше вечером', 'а', 'б', 'в', 'Днем не могу'];
    expect(pt.parseDayPartFromRecent(texts)).toBeNull();
  });

  test('реплики бота в этот массив не подмешиваются — функция им не доверяет', () => {
    // Если бы в texts случайно попал ответ Милы «на вечер тоже всё расписано»,
    // он не должен читаться как просьба пациента — но это ответственность
    // вызывающего кода (орекстратора), сама функция принимает массив как есть.
    expect(pt.parseDayPartFromRecent(['на вечер тоже всё расписано'])).toBe('evening');
  });

  test('пустой/битый вход → null', () => {
    expect(pt.parseDayPartFromRecent([])).toBeNull();
    expect(pt.parseDayPartFromRecent(null)).toBeNull();
    expect(pt.parseDayPartFromRecent(undefined)).toBeNull();
  });
});
