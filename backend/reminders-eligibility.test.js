'use strict';
// «Клиент уже записан на аналогичную услугу» — утверждённый критерий:
// будущая запись попадает под ТЕ ЖЕ условия правила (мастер/категория/услуга).
const fs = require('fs');
const path = require('path');
const { hasFutureMatchingBooking, visitReallyHappened } = require('./services/reminders/eligibility');

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

// Найдено ревью качества (2026-08-07): голого isVisitCompleted() мало для
// «визит состоялся». Предикат общий для боевого планировщика (enroll.js) и
// догона по базе (backfill.js) — тесты ниже проверяют его напрямую.
describe('visitReallyHappened', () => {
  test('обычный состоявшийся визит — true', () => {
    expect(visitReallyHappened({ attendance: 1 })).toBe(true);
    expect(visitReallyHappened({ attendance: 0, paid_full: 1 })).toBe(true);
  });

  test('обычный несостоявшийся визит — false', () => {
    expect(visitReallyHappened({ attendance: 0 })).toBe(false);
  });

  // Предоплаченная неявка: paid_full=1 стоит ОДНОВРЕМЕННО с attendance=-1
  // (депозит удержан, клиент не пришёл) — isVisitCompleted() наивно сказала
  // бы «состоялся».
  test('предоплаченная неявка — false', () => {
    expect(visitReallyHappened({ attendance: -1, paid_full: 1 })).toBe(false);
  });

  // Удалённая запись: attendance может остаться 1 (отменили после визита или
  // задним числом) — deleted=true обязан перебить его.
  test('удалённая запись при живом attendance — false', () => {
    expect(visitReallyHappened({ deleted: true, attendance: 1 })).toBe(false);
  });

  test('payloadStatus="delete" тоже гасит состоявшийся визит', () => {
    expect(visitReallyHappened({ attendance: 1 }, 'delete')).toBe(false);
  });

  test('payloadStatus по умолчанию null — признаки самой записи достаточно', () => {
    // Вызов без второго аргумента (как делает backfill.js) обязан ловить
    // deleted/attendance=-1 БЕЗ payloadStatus от вебхука.
    expect(visitReallyHappened({ deleted: true, attendance: 1 })).toBe(false);
    expect(visitReallyHappened({ attendance: -1, paid_full: 1 })).toBe(false);
  });
});

// Цель: будущая правка одного места (enroll.js ИЛИ backfill.js) не должна
// суметь молча разъехаться с общим предикатом — ни своей копией функции, ни
// импортом из другого источника. Статическая проверка исходников (а не
// require-идентичность объекта: она гарантирована кэшем Node модулей и сама
// по себе не ловит регресс «кто-то дописал локальную функцию рядом»).
describe('enroll.js и backfill.js используют ОДИН экспортированный предикат', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('оба импортируют visitReallyHappened из ./eligibility', () => {
    const enrollSrc = read('services/reminders/enroll.js');
    const backfillSrc = read('services/reminders/backfill.js');
    const importsFromEligibility = (src) =>
      /require\(['"]\.\/eligibility['"]\)/.test(src) && /visitReallyHappened/.test(src);
    expect(importsFromEligibility(enrollSrc)).toBe(true);
    expect(importsFromEligibility(backfillSrc)).toBe(true);
  });

  test('ни одно из мест не переопределяет visitReallyHappened локально', () => {
    const enrollSrc = read('services/reminders/enroll.js');
    const backfillSrc = read('services/reminders/backfill.js');
    const redefines = (src) => /function\s+visitReallyHappened\s*\(/.test(src);
    expect(redefines(enrollSrc)).toBe(false);
    expect(redefines(backfillSrc)).toBe(false);
  });
});
