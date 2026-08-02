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
    expect(parseCareDecision('{"action":"escalate","reason":"x"}'))
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
});
