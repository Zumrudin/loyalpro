'use strict';
const { parseCareDecision } = require('./services/care/decision');

describe('parseCareDecision', () => {
  test('send с текстом', () => {
    const d = parseCareDecision('{"action":"send","text":"Добрый день!","reason":"ок"}');
    expect(d).toEqual({ action: 'send', text: 'Добрый день!', reason: 'ок' });
  });
  test('JSON в ```-заборе', () => {
    const d = parseCareDecision('```json\n{"action":"skip","reason":"жалоба в переписке"}\n```');
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('жалоба в переписке');
  });
  test('send без текста → fail-safe skip', () => {
    const d = parseCareDecision('{"action":"send","text":"","reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('не-JSON → fail-safe skip, НЕ отправка', () => {
    expect(parseCareDecision('Здравствуйте! Как самочувствие?'))
      .toMatchObject({ action: 'skip', failSafe: true });
  });
  test('неизвестный action → fail-safe skip', () => {
    // Ревизия 2026-08-02: раньше здесь стоял action:"escalate" как пример
    // НЕИЗВЕСТНОГО значения — с тех пор escalate стал настоящим действием
    // (см. описание ACTIONS выше), поэтому фикстура заменена на заведомо
    // выдуманное имя, чтобы тест продолжал проверять именно fail-safe на
    // незнакомом action, а не поведение escalate.
    expect(parseCareDecision('{"action":"reboot","reason":"x"}'))
      .toMatchObject({ action: 'skip', failSafe: true });
  });
  test('stop_program со статусом', () => {
    const d = parseCareDecision('{"action":"stop_program","status":"declined","reason":"просил не писать"}');
    expect(d).toEqual({ action: 'stop_program', status: 'declined', reason: 'просил не писать' });
  });
  test('stop_program с левым статусом → stopped', () => {
    const d = parseCareDecision('{"action":"stop_program","status":"banana","reason":"x"}');
    expect(d.status).toBe('stopped');
  });
  test('escalate с reason разбирается', () => {
    const d = parseCareDecision('{"action":"escalate","reason":"жалоба на отёк после процедуры"}');
    expect(d).toEqual({ action: 'escalate', reason: 'жалоба на отёк после процедуры' });
  });
  test('escalate без reason тоже валиден (reason пустой)', () => {
    const d = parseCareDecision('{"action":"escalate"}');
    expect(d).toEqual({ action: 'escalate', reason: '' });
  });
});

describe('parseCareDecision — fail-safe на нестроковом/длинном/bidi тексте', () => {
  test('text — объект → fail-safe skip', () => {
    const d = parseCareDecision('{"action":"send","text":{"a":1},"reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('text — массив строк → fail-safe skip (правдоподобный текст опаснее объекта)', () => {
    const d = parseCareDecision('{"action":"send","text":["Добрый день!","ещё"],"reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('text — число → fail-safe skip', () => {
    const d = parseCareDecision('{"action":"send","text":42,"reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('text длиной 2000 символов → fail-safe skip, НЕ обрезанная отправка', () => {
    const longText = 'а'.repeat(2000);
    const d = parseCareDecision(JSON.stringify({ action: 'send', text: longText, reason: 'x' }));
    expect(d).toMatchObject({ action: 'skip', failSafe: true, reason: 'llm_text_too_long' });
  });
  test('text с U+202E (bidi-override, спуфинг «50%»→«05%») → символ вырезан из результата', () => {
    const d = parseCareDecision(JSON.stringify({ action: 'send', text: 'Скидка 50\u202E%', reason: 'x' }));
    expect(d.action).toBe('send');
    expect(d.text).not.toMatch(/\u202E/);
    expect(d.text).toBe('Скидка 50%');
  });
  test('reason не-строка при валидном send → отправка проходит, reason пустой', () => {
    const d = parseCareDecision('{"action":"send","text":"ok","reason":123}');
    expect(d).toEqual({ action: 'send', text: 'ok', reason: '' });
  });
  test('raw не строка (null/undefined/объект/массив) → fail-safe skip, не throw', () => {
    expect(parseCareDecision(null)).toMatchObject({ action: 'skip', failSafe: true });
    expect(parseCareDecision(undefined)).toMatchObject({ action: 'skip', failSafe: true });
    expect(parseCareDecision({ action: 'send', text: 'x' })).toMatchObject({ action: 'skip', failSafe: true });
    expect(parseCareDecision(['a', 'b'])).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('честный skip → без флага failSafe, reason дословно', () => {
    const d = parseCareDecision('{"action":"skip","reason":"клиент попросил не писать сегодня"}');
    expect(d).toEqual({ action: 'skip', reason: 'клиент попросил не писать сегодня' });
    expect(d.failSafe).toBeUndefined();
  });
  test('несколько JSON-объектов в ответе → fail-safe skip', () => {
    const d = parseCareDecision('{"action":"skip","reason":"draft"} {"action":"send","text":"real","reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
});
