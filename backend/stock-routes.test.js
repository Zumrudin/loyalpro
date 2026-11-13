'use strict';
const { parseGoodsQuery, parseDocsQuery, parseTurnoverQuery } = require('./services/stock/query');
const { StockError } = require('./services/stock/model');

describe('parseGoodsQuery', () => {
  test('пустой запрос', () => {
    expect(parseGoodsQuery({})).toEqual({ search: '', category: null, storage: null, onlyCritical: false, onlyNegative: false, active: null, source: null });
    expect(parseGoodsQuery(undefined).search).toBe('');
  });
  test('search режется до 100, не-строка игнорируется', () => {
    expect(parseGoodsQuery({ search: 'x'.repeat(150) }).search).toHaveLength(100);
    expect(parseGoodsQuery({ search: ['a'] }).search).toBe('');
  });
  test('category: число или строка, storage: число', () => {
    expect(parseGoodsQuery({ category: '12' }).category).toBe(12);
    expect(parseGoodsQuery({ category: 'Мыло' }).category).toBe('Мыло');
    expect(parseGoodsQuery({ category: '' }).category).toBeNull();
    expect(parseGoodsQuery({ category: 'x'.repeat(300) }).category).toBeNull();
    expect(parseGoodsQuery({ storage: '5' }).storage).toBe(5);
    expect(parseGoodsQuery({ storage: 'abc' }).storage).toBeNull();
    expect(parseGoodsQuery({ storage: '-1' }).storage).toBeNull();
    expect(parseGoodsQuery({ storage: '1.5' }).storage).toBeNull();
  });
  test('флаги строго "1"', () => {
    const r = parseGoodsQuery({ only_critical: '1', only_negative: 'true', active: '1' });
    expect(r.onlyCritical).toBe(true); expect(r.onlyNegative).toBe(false); expect(r.active).toBe(true);
    expect(parseGoodsQuery({ active: '0' }).active).toBe(false);
    expect(parseGoodsQuery({ active: 'true' }).active).toBeNull();
  });
  test('source', () => {
    expect(parseGoodsQuery({ source: 'loyalpro' }).source).toBe('loyalpro');
    expect(parseGoodsQuery({ source: 'yclients' }).source).toBe('yclients');
    expect(parseGoodsQuery({ source: 'other' }).source).toBeNull();
  });
});

describe('parseDocsQuery', () => {
  test('дефолты', () => {
    const r = parseDocsQuery({});
    expect(r).toMatchObject({ kind: null, status: null, origin: null, from: null, to: null, client: null, record: null, page: 1, limit: 50 });
  });
  test('перечисления', () => {
    expect(parseDocsQuery({ kind: 'sale', status: 'posted', origin: 'yclients' })).toMatchObject({ kind: 'sale', status: 'posted', origin: 'yclients' });
    expect(parseDocsQuery({ kind: 'x', status: 'y', origin: 'z' })).toMatchObject({ kind: null, status: null, origin: null });
  });
  test('даты и период', () => {
    expect(parseDocsQuery({ from: '2026-11-01', to: '2026-11-10' })).toMatchObject({ from: '2026-11-01', to: '2026-11-10' });
    expect(() => parseDocsQuery({ from: '2026-02-30', to: '2026-03-01' })).toThrow(StockError);
    expect(() => parseDocsQuery({ from: '2024-01-01', to: '2026-11-10' })).toThrow(StockError);
    try { parseDocsQuery({ from: '2024-01-01', to: '2026-11-10' }); } catch (e) { expect(e.status).toBe(400); }
    expect(parseDocsQuery({ from: '2025-01-01', to: '2026-11-10' }).from).toBe('2025-01-01'); // ≤ 731 дня
    expect(() => parseDocsQuery({ from: '2026-11-01' })).toThrow(StockError); // одна граница
  });
  test('client/record/page/limit', () => {
    expect(parseDocsQuery({ client: '7', record: '99' })).toMatchObject({ client: 7, record: 99 });
    expect(parseDocsQuery({ client: 'a', record: '0' })).toMatchObject({ client: null, record: null });
    expect(parseDocsQuery({ page: '0' }).page).toBe(1);
    expect(parseDocsQuery({ page: '3' }).page).toBe(3);
    expect(parseDocsQuery({ page: 'x' }).page).toBe(1);
    expect(parseDocsQuery({ limit: '500' }).limit).toBe(200);
    expect(parseDocsQuery({ limit: '0' }).limit).toBe(50);
    expect(parseDocsQuery({ limit: '10' }).limit).toBe(10);
  });
});

describe('parseTurnoverQuery', () => {
  test('from/to обязательны', () => {
    expect(() => parseTurnoverQuery({})).toThrow(StockError);
    expect(() => parseTurnoverQuery({ from: '2026-11-01' })).toThrow(StockError);
  });
  test('нормальный', () => {
    expect(parseTurnoverQuery({ from: '2026-11-01', to: '2026-11-14', storage: '3', category: '9' }))
      .toEqual({ from: '2026-11-01', to: '2026-11-14', storage: 3, category: 9 });
  });
  test('перевёрнутый период меняется местами, длинный — 400', () => {
    expect(parseTurnoverQuery({ from: '2026-11-14', to: '2026-11-01' }).from).toBe('2026-11-01');
    expect(() => parseTurnoverQuery({ from: '2020-01-01', to: '2026-11-01' })).toThrow(StockError);
  });
});
