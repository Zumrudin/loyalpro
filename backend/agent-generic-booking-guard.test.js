'use strict';

const { check, GUARDED_GENERICS } = require('./services/agent/generic-booking-guard');
const { GENERIC_SERVICE_TITLES, UNIT_PRICE_SERVICE_TITLE } = require('./services/agent/catalog-data');

// staff у обобщённой услуги обязателен: guard молчит при пустом/отсутствующем
// списке (иначе hint отправлял бы модель в тупик «мастер не выполняет услугу»).
const CATALOG = [
  { yc_id: 99, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
  { yc_id: 10, title: 'Биоревитализация Revi Silk 1 ml', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
];

describe('generic-booking-guard.check', () => {
  test('конкретный препарат, которого пациент не называл → нарушение с id обобщённой услуги', () => {
    const v = check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию на завтра',
      services: CATALOG,
    });
    expect(v).toEqual({ genericTitle: 'Биоревитализация', genericYcId: 99, brands: ['revi', 'silk'] });
  });

  test('пациент называл бренд (в любом регистре) → нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'запишите на REVI silk пожалуйста',
      services: CATALOG,
    })).toBe(null);
  });

  test('сама обобщённая услуга → нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: CATALOG,
    })).toBe(null);
  });

  test('направление не охраняется (ботулинотерапия/зоны, чистки) → нарушения нет', () => {
    expect(check({
      title: 'Лоб+Межбровье',
      categoryPath: ['Инъекционная косметология', 'Ботулинотерапия'],
      patientText: 'ботокс',
      services: CATALOG,
    })).toBe(null);
  });

  test('в названии нет латинского бренда → судить не по чему, нарушения нет', () => {
    expect(check({
      title: 'Биоревитализация классическая',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: CATALOG,
    })).toBe(null);
  });

  test('обобщённой услуги нет в каталоге → правило невыполнимо, нарушения нет (fail-open)', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу био',
      services: [CATALOG[1]],
    })).toBe(null);
  });

  test('пустой patientText → нарушения нет (сверять не с чем)', () => {
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: '',
      services: CATALOG,
    })).toBe(null);
  });

  test('у обобщённой услуги пустой staff → guard молчит (иначе hint вёл бы в тупик «мастер не выполняет»)', () => {
    const services = [{ ...CATALOG[0], staff: [] }, CATALOG[1]];
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию',
      services,
    })).toBe(null);
    // Отсутствующий staff — тот же fail-open.
    const noStaff = [{ yc_id: 99, title: 'Биоревитализация', category_path: CATALOG[0].category_path }, CATALOG[1]];
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию',
      services: noStaff,
    })).toBe(null);
  });

  // ЗАФИКСИРОВАННЫЙ КРАЙ, а не дефект: любой ЕДИНСТВЕННЫЙ токен названия в тексте
  // пациента снимает guard («special» при «Stylage Special Lips»). Это осознанная
  // цена эвристики — ложное срабатывание стоит лишний проход провайдера, а обход
  // patient_named_service у модели и так есть. Будущая правка «все токены, а не
  // some» обязана осознанно поменять ЭТОТ тест, а не проехать молча.
  test('край brands.some: один токен названия в тексте пациента снимает guard', () => {
    const services = [
      { yc_id: 88, title: 'Увеличение губ', category_path: ['Инъекционная косметология', 'Увеличение губ'],
        staff: [{ yc_id: 5, name: 'Пери' }] },
      { yc_id: 44, title: 'Увеличение губ Stylage Special Lips', category_path: ['Инъекционная косметология', 'Увеличение губ'],
        staff: [{ yc_id: 5, name: 'Пери' }] },
    ];
    expect(check({
      title: 'Увеличение губ Stylage Special Lips',
      categoryPath: ['Инъекционная косметология', 'Увеличение губ'],
      patientText: 'хочу что-то special для губ',
      services,
    })).toBe(null);
  });

  test('дешёвые края: пустой вызов, без categoryPath, services:null, нестроковый title — всюду null', () => {
    expect(check({})).toBe(null);
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: undefined,
      patientText: 'хочу биоревитализацию',
      services: CATALOG,
    })).toBe(null);
    expect(check({
      title: 'Биоревитализация Revi Silk 1 ml',
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию',
      services: null,
    })).toBe(null);
    expect(check({
      title: undefined,
      categoryPath: ['Инъекционная косметология', 'Биоревитализация'],
      patientText: 'хочу биоревитализацию',
      services: CATALOG,
    })).toBe(null);
  });
});

describe('generic-booking-guard.GUARDED_GENERICS', () => {
  test('производен от GENERIC_SERVICE_TITLES: каждый элемент есть в списке catalog-data', () => {
    expect(GUARDED_GENERICS.length).toBeGreaterThan(0);
    for (const title of GUARDED_GENERICS) {
      expect(GENERIC_SERVICE_TITLES).toContain(title);
    }
  });

  test('Ботулакс (зоны — русские слова) исключён осмысленно', () => {
    expect(GENERIC_SERVICE_TITLES).toContain(UNIT_PRICE_SERVICE_TITLE);
    expect(GUARDED_GENERICS).not.toContain(UNIT_PRICE_SERVICE_TITLE);
  });
});
