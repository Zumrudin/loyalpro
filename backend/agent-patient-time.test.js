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
