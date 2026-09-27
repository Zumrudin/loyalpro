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
