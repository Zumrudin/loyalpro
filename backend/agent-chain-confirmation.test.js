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
