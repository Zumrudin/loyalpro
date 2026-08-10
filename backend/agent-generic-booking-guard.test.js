'use strict';

const { check } = require('./services/agent/generic-booking-guard');

const CATALOG = [
  { yc_id: 99, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'] },
  { yc_id: 10, title: 'Биоревитализация Revi Silk 1 ml', category_path: ['Инъекционная косметология', 'Биоревитализация'] },
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
});
