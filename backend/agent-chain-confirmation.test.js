'use strict';
const guard = require('./services/agent/chain-confirmation');
const offers = require('./services/agent/sequential-offers');
const link = (staff, name, time) => ({ staff_yc_id: staff, staff_name: name,
  service_yc_id: staff, service_title: `Услуга ${staff}`, datetime: `2026-10-01T${time}:00+03:00` });
const mixed = { chain: [link(1, 'Анна', '15:00'), link(2, 'Мария', '15:30')] };
const proposal = '01.10: 15:00 у Анны, затем 15:30 у Марии. Записать?';
const ctx = { previousAssistantText: proposal, patientLastText: 'Да, пожалуйста' };

test('matches the whole chain, preserving staff order and date', () => {
  expect(guard.matchingOffers({ o13: mixed }, proposal)).toEqual(['o13']);
  expect(guard.matchingOffers({ o13: mixed }, '01.10 15:00 у Марии, затем 15:30 у Анны')).toEqual([]);
  expect(guard.matchingOffers({ o13: mixed }, '02.10 15:00 у Анны, затем 15:30 у Марии')).toEqual([]);
  expect(guard.matchingOffers({ o13: mixed }, '1 октября: 15:00 у Анны, 15:30 у Марии')).toEqual(['o13']);
  expect(guard.matchingOffers({ o13: mixed }, '01.10: 15:00 Анна, 15:30 Мария')).toEqual(['o13']);
  expect(guard.matchingOffers({ o13: mixed }, '15:00 у Анны')).toEqual([]);
});

const competingOffers = {
  sameFirst: { chain: [mixed.chain[0], { ...mixed.chain[1], staff_yc_id: 1, staff_name: 'Анна' }] },
  sameSecond: { chain: [{ ...mixed.chain[0], staff_yc_id: 2, staff_name: 'Мария' }, mixed.chain[1]] },
  mixed,
};

test.each([
  proposal,
  '1 октября: первая услуга у Анны в 15:00, затем вторая у Марии в 15:30. Записать?',
  '1 октября: первая услуга у Анны в **15:00**, затем вторая у Марии в **15:30**. Записать?',
  '01.10: 15:00 Анна, затем 15:30 Мария. Записать?',
  'Первая услуга — к Анне. 1 октября: у неё в 15:00, затем у Марии в 15:30. Записать?',
  `Подтвердите, пожалуйста, этот вариант:\n${guard.formatFacts(mixed.chain).join('\n')}\nЗаписать?`,
])('does not confuse a mixed offer with same-time single-staff alternatives: %s', text => {
  expect(guard.matchingOffers(competingOffers, text)).toEqual(['mixed']);
  expect(guard.validateChoice(competingOffers, 'mixed', { ...ctx, previousAssistantText: text })).toBeNull();
  for (const id of ['sameFirst', 'sameSecond']) {
    expect(guard.validateChoice(competingOffers, id, { ...ctx, previousAssistantText: text }).needs_confirmation).toBe(true);
  }
});

test('a patient name in a greeting cannot authorize a different specialist', () => {
  const text = 'Анна, 01.10: обе услуги у Марии, в 15:00 и 15:30. Записать?';
  expect(guard.validateChoice(competingOffers, 'mixed', { ...ctx, previousAssistantText: text }).needs_confirmation).toBe(true);
});

test.each([
  '01.10 у Марии: 15:00 первая услуга, 15:30 вторая. Записать?',
  '01.10: 15:00 у Марии, затем 15:30 у Марии. Записать?',
])('still accepts a genuinely single-staff offer: %s', text => {
  expect(guard.matchingOffers(competingOffers, text)).toEqual(['sameSecond']);
  expect(guard.validateChoice(competingOffers, 'sameSecond', { ...ctx, previousAssistantText: text })).toBeNull();
});

test('a shared first name does not resolve genuinely ambiguous specialists', () => {
  const all = {
    a: { chain: [link(1, 'Анна Иванова', '15:00')] },
    b: { chain: [link(2, 'Анна Петрова', '15:00')] },
  };
  const ambiguous = { ...ctx, previousAssistantText: '01.10: 15:00 у Анны. Записать?' };
  expect(guard.validateChoice(all, 'a', ambiguous).needs_confirmation).toBe(true);
  expect(guard.validateChoice(all, 'a', { ...ambiguous,
    previousAssistantText: '01.10: 15:00 у Анны Ивановой. Записать?' })).toBeNull();
});

test.each(['Нет', 'Да, но к другой', 'Да, но в 16:00', 'Да на 02.10', 'Да на 2026-10-02', 'Ты точно меня к Анне записала?', ''])
('does not treat changed terms or a question as consent: %s', patientLastText => {
  expect(guard.validateChoice({ o13: mixed }, 'o13', { ...ctx, patientLastText }).needs_confirmation).toBe(true);
});

test('ambiguous dates and missing delivered offer fail closed', () => {
  const nextDay = { chain: mixed.chain.map(l => ({ ...l, datetime: l.datetime.replace('10-01', '10-02') })) };
  expect(guard.validateChoice({ o13: mixed, o14: nextDay }, 'o13',
    { ...ctx, previousAssistantText: proposal.replace('01.10:', '') }).needs_confirmation).toBe(true);
  expect(guard.validateChoice({ o13: mixed }, 'o13', { ...ctx, previousAssistantText: '' }).needs_confirmation).toBe(true);
  expect(guard.validateChoice({ o13: mixed, o14: nextDay }, 'o13', ctx)).toBeNull();
});

test('offered mixed option remains visible beyond the eight-option cap', () => {
  const all = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o${i + 1}`, mixed]));
  all.o13 = mixed;
  const lines = offers.renderOffers(all, { preferredIds: ['o13'], nowMs: Date.parse('2026-09-30T00:00:00Z') });
  expect(lines).toHaveLength(8);
  expect(lines[0]).toMatch(/^o13 —/);
});

test.each(['Ты меня к Анне записала?', 'К кому я записана?', 'Проверь, точно записала к разным специалистам?'])
('recognizes a request to check existing bookings: %s', text => expect(guard.isBookingCheck(text)).toBe(true));
test.each(['Запишите меня к Анне', 'Перенеси запись к Анне', 'Проверь запись моей мамы', 'Можно я запишусь к Анне?'])
('does not consume new/change/third-party booking requests: %s', text => expect(guard.isBookingCheck(text)).toBe(false));

test('confirmation contains actual staff and all services, but no internal identifiers', () => {
  const text = guard.confirmationReply({ booked_all: true, records: [{ ...mixed.chain[0], record_id: 987654,
    services: ['Первая услуга', 'Вторая услуга'] }] });
  expect(text).toContain('Анна');
  expect(text).toContain('Первая услуга, Вторая услуга');
  expect(text).not.toContain('Мария');
  expect(text).not.toContain('987654');
});

// Continuous multi-service visit: only its start was offered to the patient.
const compactOffer = { booking_mode: 'single_record', chain: [
  { ...link(1, 'Анна', '15:00'), seance_length: 1800 },
  { ...link(1, 'Анна', '15:30'), service_yc_id: 2, seance_length: 900 },
] };
const compactCtx = { previousAssistantText: '1 октября у Анны в 15:00: обе услуги подряд без перерыва. Записать?', patientLastText: 'Да' };
test.each(['Да', 'Запишите меня на 1 число просто', 'Давайте оформим, спасибо', 'Первый вариант подходит'])
('semantic consent accepts continuous visit: %s', patientLastText => {
  expect(guard.validateChoice({ one: compactOffer }, 'one', { ...compactCtx, patientLastText }, { patient_confirmed: true })).toBeNull();
});
test.each([false, 'true', null])('semantic consent must be boolean true: %p', patient_confirmed => {
  expect(guard.validateChoice({ one: compactOffer }, 'one', compactCtx, { patient_confirmed }).needs_confirmation).toBe(true);
});
test.each(['gap', 'different-staff', 'separate', 'wrong-start', 'ambiguous', 'wrong-date'])
('compact proposal does not bypass facts: %s', kind => {
  const offer = JSON.parse(JSON.stringify(compactOffer));
  const all = { one: offer };
  if (kind === 'gap') offer.chain[1].datetime = '2026-10-01T16:00:00+03:00';
  if (kind === 'different-staff') Object.assign(offer.chain[1], { staff_yc_id: 2, staff_name: 'Мария' });
  if (kind === 'separate') offer.booking_mode = 'separate_records';
  if (kind === 'wrong-start') offer.chain[0].datetime = '2026-10-01T14:00:00+03:00';
  if (kind === 'ambiguous') all.two = offer;
  if (kind === 'wrong-date') offer.chain.forEach(l => { l.datetime = l.datetime.replace('10-01', '10-02'); });
  expect(guard.validateChoice(all, 'one', compactCtx, { patient_confirmed: true }).needs_confirmation).toBe(true);
});
test('semantic consent cannot authorize a different specialist with the same times', () => {
  expect(guard.validateChoice(competingOffers, 'sameSecond', ctx, { patient_confirmed: true }).needs_confirmation).toBe(true);
});

// Регрессия 2026-10-02: «Давайте на 16:00, запишите» после реплики с ДВУМЯ вариантами
// одного специалиста и «первый вариант» после двух цепочек требовали второго «да».
describe('выбор пациента среди нескольких показанных вариантов', () => {
  const dt = (t) => `2026-10-15T${t}:00+03:00`;
  const two = [
    { staff_yc_id: 5, staff_name: 'Юлия', service_yc_id: 1, service_title: 'А', datetime: dt('16:00'), seance_length: 3600 },
    { staff_yc_id: 5, staff_name: 'Юлия', service_yc_id: 2, service_title: 'Б', datetime: dt('17:00'), seance_length: 3600 },
  ];
  const later = two.map((l, i) => ({ ...l, datetime: dt(i ? '14:00' : '13:00') }));
  const opts = { late: { booking_mode: 'single_record', chain: two }, early: { booking_mode: 'single_record', chain: later } };
  const text = '15 октября Юлия проведёт обе процедуры подряд: начало в 16:00 или в 13:00. Какое время удобнее?';
  const c = (patient, extra = {}) => ({ previousAssistantText: text, patientLastText: patient, ...extra });
  const input = { patient_confirmed: true };

  test('время пациента, совпадающее с началом варианта и с option_id, выбирает вариант', () => {
    expect(guard.validateChoice(opts, 'late', c('Давайте на 16:00, запишите.'), input)).toBeNull();
    expect(guard.validateChoice(opts, 'early', c('Давайте на 13:00, запишите.'), input)).toBeNull();
  });
  test('option_id, расходящийся со временем пациента, не проходит', () => {
    expect(guard.validateChoice(opts, 'early', c('Давайте на 16:00, запишите.'), input).needs_confirmation).toBe(true);
  });
  test('время второй услуги не выбирает вариант', () => {
    expect(guard.validateChoice(opts, 'late', c('Давайте в 17:00'), input)).not.toBeNull();
  });
  test('без времени и порядкового номера вариант не выбирается', () => {
    expect(guard.validateChoice(opts, 'late', c('Да, запишите'), input).needs_confirmation).toBe(true);
  });
  test('«первый вариант» работает только если совпал с option_id в порядке показа', () => {
    const t = '15 октября: 1) 16:00 Юлия, затем 17:00 Юлия; 2) 13:00 Юлия, затем 14:00 Юлия. Какой вариант?';
    const cc = p => ({ previousAssistantText: t, patientLastText: p });
    expect(guard.validateChoice(opts, 'late', cc('Первый вариант, пожалуйста'), input)).toBeNull();
    expect(guard.validateChoice(opts, 'early', cc('Второй вариант'), input)).toBeNull();
    expect(guard.validateChoice(opts, 'early', cc('Первый вариант, пожалуйста'), input).needs_confirmation).toBe(true);
  });
});

test('времена старых записей из уточнения не делают чужой вариант совпадающим', () => {
  const l = (t, id) => ({ staff_yc_id: 3, staff_name: 'Татьяна', service_yc_id: id, service_title: `С${id}`,
    datetime: `2026-10-31T${t}:00+03:00`, seance_length: 3600 });
  const opts = { evening: { booking_mode: 'single_record', chain: [l('18:00', 1), l('19:00', 2)] },
    morning: { booking_mode: 'single_record', chain: [l('10:00', 1), l('11:00', 2)] } };
  const prev = `У Вас уже есть запись:\n30.10 (пт) 10:00 — С1, С2.\nПеренести её или оформить дополнительный визит?\n${guard.VARIANT_MARK}\n${guard.formatFacts(opts.evening.chain).join('\n')}`;
  expect(guard.validateChoice(opts, 'evening', { previousAssistantText: prev, patientLastText: 'Дополнительный визит, прежние записи оставьте.' }, { patient_confirmed: true })).toBeNull();
});

test('вариант с названными временами всех звеньев приоритетнее совпавшего лишь по началу', () => {
  const l = (t, id) => ({ staff_yc_id: 5, staff_name: 'Юлия', service_yc_id: id, service_title: `С${id}`,
    datetime: `2026-10-29T${t}:00+03:00`, seance_length: 3600 });
  const opts = { a: { booking_mode: 'single_record', chain: [l('13:00', 1), l('14:00', 2)] },
    b: { booking_mode: 'single_record', chain: [l('14:00', 1), l('15:00', 2)] } };
  const text = '29 октября у Юлии: Золушка с 13:00, затем лифтинг с 14:00. Подойдёт?';
  expect(guard.matchingOffers(opts, text)).toEqual(['a']);
  expect(guard.validateChoice(opts, 'a', { previousAssistantText: text, patientLastText: 'Да, записывайте' }, { patient_confirmed: true })).toBeNull();
  expect(guard.validateChoice(opts, 'b', { previousAssistantText: text, patientLastText: 'Да, записывайте' }, { patient_confirmed: true }).needs_confirmation).toBe(true);
});

test('имя специалиста и дата в ответе пациента выбирают вариант среди одинаковых времён', () => {
  const l = (staff, name, day, t, id) => ({ staff_yc_id: staff, staff_name: name, service_yc_id: id, service_title: `С${id}`,
    datetime: `2026-10-${day}T${t}:00+03:00`, seance_length: 3600 });
  const opts = { yulia: { booking_mode: 'single_record', chain: [l(5, 'Юлия', 29, '13:00', 1), l(5, 'Юлия', 29, '14:00', 2)] },
    tanya: { booking_mode: 'single_record', chain: [l(6, 'Татьяна', 28, '13:00', 1), l(6, 'Татьяна', 28, '14:00', 2)] } };
  const text = '28 октября у Юлии выходной, 29 октября она свободна в 13:00. Если важна среда, у Татьяны есть 13:00. Какой вариант?';
  const ask = (patient, id) => guard.validateChoice(opts, id, { previousAssistantText: text, patientLastText: patient }, { patient_confirmed: true });
  expect(ask('К Юлии 29 октября на 13:00, запишите.', 'yulia')).toBeNull();
  expect(ask('К Юлии 29 октября на 13:00, запишите.', 'tanya').needs_confirmation).toBe(true);
  expect(ask('Давайте на 13:00', 'yulia').needs_confirmation).toBe(true);
});
