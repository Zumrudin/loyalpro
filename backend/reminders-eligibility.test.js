'use strict';
// «Клиент уже записан на аналогичную услугу» — утверждённый критерий:
// будущая запись попадает под ТЕ ЖЕ условия правила (мастер/категория/услуга).
const { hasFutureMatchingBooking } = require('./services/reminders/eligibility');

const CAT_MAP = new Map([['101', '9'], ['102', '9'], ['200', '7']]);
const BY_CATEGORY = { logic: 'and', items: [{ type: 'category', ids: [9] }] };
const BY_SERVICE  = { logic: 'and', items: [{ type: 'service',  ids: [101] }] };

const rec = (serviceId, staffId) => ({
  services: [{ id: serviceId, title: 'услуга' }],
  staff: { id: staffId || 55 },
});

test('другая услуга той же категории считается аналогичной', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_CATEGORY, CAT_MAP)).toBe(true);
});

test('услуга чужой категории аналогичной не считается', () => {
  expect(hasFutureMatchingBooking([rec(200)], BY_CATEGORY, CAT_MAP)).toBe(false);
});

test('правило по конкретной услуге не ловит соседнюю', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_SERVICE, CAT_MAP)).toBe(false);
  expect(hasFutureMatchingBooking([rec(101)], BY_SERVICE, CAT_MAP)).toBe(true);
});

test('пустой список будущих записей → false', () => {
  expect(hasFutureMatchingBooking([], BY_CATEGORY, CAT_MAP)).toBe(false);
  expect(hasFutureMatchingBooking(null, BY_CATEGORY, CAT_MAP)).toBe(false);
});

// Пустая карта категорий — это сбой getServiceCategoryMap, а не «категорий
// нет». Условие по категории не сматчится, и напоминание уйдёт — осознанный
// fail-open, но он обязан быть виден в тесте.
test('пустая карта категорий не матчит условие по категории', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_CATEGORY, new Map())).toBe(false);
});

test('условие по мастеру работает', () => {
  const byStaff = { logic: 'and', items: [{ type: 'staff', ids: [55] }] };
  expect(hasFutureMatchingBooking([rec(200, 55)], byStaff, CAT_MAP)).toBe(true);
  expect(hasFutureMatchingBooking([rec(200, 77)], byStaff, CAT_MAP)).toBe(false);
});

// YClients кладёт мастера то в staff.id, то в staff_id — оба пути обязаны
// работать, иначе часть записей молча не сматчится.
test('мастер читается и из staff_id, и из staff.id', () => {
  const byStaff = { logic: 'and', items: [{ type: 'staff', ids: [55] }] };
  expect(hasFutureMatchingBooking([{ services: [], staff_id: 55 }], byStaff, CAT_MAP)).toBe(true);
});
