// backend/revenue-classify.test.js
'use strict';

const { classifyExpense } = require('./services/revenue');

describe('classifyExpense', () => {
  test('Оказание услуг → services', () => {
    expect(classifyExpense('Оказание услуг')).toBe('services');
  });

  test('Продажа товаров → goods', () => {
    expect(classifyExpense('Продажа товаров')).toBe('goods');
  });

  test('Продажа абонементов → abonement', () => {
    expect(classifyExpense('Продажа абонементов')).toBe('abonement');
  });

  test('Продажа сертификатов → certificate', () => {
    expect(classifyExpense('Продажа сертификатов')).toBe('certificate');
  });

  test('Пополнение счета → deposit', () => {
    expect(classifyExpense('Пополнение счета')).toBe('deposit');
  });

  test('Закупка материалов → null (expense, not revenue)', () => {
    expect(classifyExpense('Закупка материалов')).toBeNull();
  });

  test('Закупка товаров → null', () => {
    expect(classifyExpense('Закупка товаров')).toBeNull();
  });

  test('Зарплата персонала → null', () => {
    expect(classifyExpense('Зарплата персонала')).toBeNull();
  });

  test('Прочие расходы → null', () => {
    expect(classifyExpense('Прочие расходы')).toBeNull();
  });

  test('null → null', () => {
    expect(classifyExpense(null)).toBeNull();
  });

  test('empty string → null', () => {
    expect(classifyExpense('')).toBeNull();
  });

  test('unknown title → other (with warning intent)', () => {
    expect(classifyExpense('Новый неизвестный тип')).toBe('other');
  });
});
