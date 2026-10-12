'use strict';

jest.mock('./db', () => ({ db: {} }));
jest.mock('./services/agent-rag', () => ({}));

const data = require('./scripts/kb-content/patient-questions-by-service-2026-10');
const { buildUpdatedBody, containsMoney } = require('./scripts/kb-import-patient-questions');

describe('patient questions KB import', () => {
  test('FAQ-контент не содержит конкретных денежных сумм', () => {
    expect(data.appends.length).toBeGreaterThan(0);
    for (const item of data.appends) expect(containsMoney(item.section)).toBe(false);
  });

  test('каждое дополнение имеет уникальный ключ и общий маркер', () => {
    const keys = data.appends.map(item => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of data.appends) expect(item.section).toContain(data.SECTION_HEADING);
  });

  test('добавление идемпотентно по маркеру раздела', () => {
    const section = data.appends[0].section;
    const once = buildUpdatedBody('Исходная статья', section);
    expect(once).toContain(section.trim());
    expect(buildUpdatedBody(once, section)).toBeNull();
  });

  test('детектор блокирует суммы в рублях и ценовые диапазоны', () => {
    expect(containsMoney('Стоимость берётся из актуального прайса.')).toBe(false);
    expect(containsMoney('Цена 6 500 ₽.')).toBe(true);
    expect(containsMoney('Стоимость от 19000 до 24000.')).toBe(true);
  });
});
