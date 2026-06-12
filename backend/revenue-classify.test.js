// backend/revenue-classify.test.js
'use strict';

const { classifyExpense, goodsTransactionRef } = require('./services/revenue');

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

describe('goodsTransactionRef', () => {
  test('webhook-форма: data.sold_item_* внутри payload.data (плоский data)', () => {
    expect(goodsTransactionRef({ sold_item_type: 'goods_transaction', sold_item_id: 1684236813 }))
      .toBe(1684236813);
  });

  test('payload целиком: sold_item_* под вложенным data', () => {
    expect(goodsTransactionRef({ data: { sold_item_type: 'goods_transaction', sold_item_id: 42 } }))
      .toBe(42);
  });

  test('строковый sold_item_id парсится в число', () => {
    expect(goodsTransactionRef({ sold_item_type: 'goods_transaction', sold_item_id: '77' })).toBe(77);
  });

  test('другой sold_item_type → null', () => {
    expect(goodsTransactionRef({ sold_item_type: 'service', sold_item_id: 5 })).toBeNull();
  });

  test('нет sold_item_id → null', () => {
    expect(goodsTransactionRef({ sold_item_type: 'goods_transaction' })).toBeNull();
  });

  test('sold_item_id=0 → null', () => {
    expect(goodsTransactionRef({ sold_item_type: 'goods_transaction', sold_item_id: 0 })).toBeNull();
  });

  test('null/пустой payload → null', () => {
    expect(goodsTransactionRef(null)).toBeNull();
    expect(goodsTransactionRef({})).toBeNull();
  });
});
