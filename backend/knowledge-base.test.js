'use strict';

const { buildPrefixTsQuery } = require('./services/knowledge-base');

describe('buildPrefixTsQuery', () => {
  test('одно слово → префикс', () => {
    expect(buildPrefixTsQuery('мани')).toBe('мани:*');
  });

  test('несколько слов → & между префиксами', () => {
    expect(buildPrefixTsQuery('мани стриж')).toBe('мани:* & стриж:*');
  });

  test('схлопывает лишние пробелы', () => {
    expect(buildPrefixTsQuery('  запись   клиента ')).toBe('запись:* & клиента:*');
  });

  test('вычищает спецсимволы tsquery внутри токена', () => {
    expect(buildPrefixTsQuery('a:b|c')).toBe('abc:*');
  });

  test('токены только из спецсимволов отбрасываются', () => {
    expect(buildPrefixTsQuery('!() & |')).toBe('');
  });

  test('пустой ввод → пустая строка', () => {
    expect(buildPrefixTsQuery('   ')).toBe('');
    expect(buildPrefixTsQuery('')).toBe('');
  });

  test('не-строка → пустая строка', () => {
    expect(buildPrefixTsQuery(null)).toBe('');
    expect(buildPrefixTsQuery(undefined)).toBe('');
    expect(buildPrefixTsQuery(123)).toBe('');
  });

  test('латиница поддерживается', () => {
    expect(buildPrefixTsQuery('hello world')).toBe('hello:* & world:*');
  });
});
