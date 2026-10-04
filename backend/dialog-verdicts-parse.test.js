// backend/dialog-verdicts-parse.test.js
'use strict';
const { parseVerdicts } = require('./services/dialog-verdicts/parse');
const { SYSTEM_PROMPT, buildUserMessage, retrySuffix } = require('./services/dialog-verdicts/prompt');
const { STATUSES } = require('./services/dialog-verdicts/taxonomy');

describe('prompt', () => {
  test('системный промпт перечисляет каждый статус с определением и переопределяет роль', () => {
    for (const s of STATUSES) expect(SYSTEM_PROMPT).toContain(`- ${s.code} — `);
    expect(SYSTEM_PROMPT).toMatch(/аналитик переписок/i);
    expect(SYSTEM_PROMPT).toMatch(/НЕ отвечаешь клиенту/);
    expect(SYSTEM_PROMPT).toContain('"verdicts"');
  });
  test('user-сообщение — блоки ### dN с текстами', () => {
    expect(buildUserMessage([{ id: 'd1', text: 'A' }, { id: 'd2', text: 'B' }])).toBe('### d1\nA\n\n### d2\nB');
  });
  test('retrySuffix называет причины', () => {
    expect(retrySuffix(['нет вердикта для d2'])).toContain('нет вердикта для d2');
  });
});

describe('parseVerdicts', () => {
  const ids = ['d1', 'd2'];
  test('валидный ответ → ok, порядок как в expectedIds', () => {
    const r = parseVerdicts('{"verdicts":[{"id":"d2","status":"booked","note":"подтвердили 12:00"},{"id":"d1","status":"PENDING","note":"ушла думать"}]}', ids);
    expect(r).toEqual({ ok: true, verdicts: [
      { id: 'd1', status: 'pending', label: null, note: 'ушла думать' },
      { id: 'd2', status: 'booked', label: null, note: 'подтвердили 12:00' },
    ] });
  });
  test('обёртка ```json и текст вокруг допускаются', () => {
    const r = parseVerdicts('Вот ответ:\n```json\n{"verdicts":[{"id":"d1","status":"question","note":"адрес"}]}\n```', ['d1']);
    expect(r.ok).toBe(true);
  });
  test('other с label → label сохраняется; other без label → ошибка', () => {
    expect(parseVerdicts('{"verdicts":[{"id":"d1","status":"other","label":"жалоба","note":"x"}]}', ['d1']).verdicts[0].label).toBe('жалоба');
    const bad = parseVerdicts('{"verdicts":[{"id":"d1","status":"other","note":"x"}]}', ['d1']);
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toEqual(expect.arrayContaining([expect.stringContaining('other без label')]));
  });
  test('label у не-other отбрасывается', () => {
    expect(parseVerdicts('{"verdicts":[{"id":"d1","status":"booked","label":"x"}]}', ['d1']).verdicts[0].label).toBeNull();
  });
  test('пропущенный, лишний и повторный id → причины', () => {
    const r = parseVerdicts('{"verdicts":[{"id":"d1","status":"booked"},{"id":"d1","status":"booked"},{"id":"d9","status":"booked"}]}', ids);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('d1 повторяется'),
      expect.stringContaining('неизвестный id d9'),
      expect.stringContaining('нет вердикта для d2'),
    ]));
  });
  test('статус вне списка → причина', () => {
    const r = parseVerdicts('{"verdicts":[{"id":"d1","status":"maybe"}]}', ['d1']);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('вне списка');
  });
  test('не JSON / нет массива → ok:false', () => {
    expect(parseVerdicts('не могу', ['d1'])).toEqual({ ok: false, reasons: ['ответ не является JSON'] });
    expect(parseVerdicts('{"x":1}', ['d1'])).toEqual({ ok: false, reasons: ['нет массива verdicts'] });
    expect(parseVerdicts('', ['d1']).ok).toBe(false);
  });
  test('note режется до 120 символов и чистится от управляющих символов', () => {
    const r = parseVerdicts(JSON.stringify({ verdicts: [{ id: 'd1', status: 'booked', note: 'a\nb' + 'x'.repeat(200) }] }), ['d1']);
    expect(r.verdicts[0].note.length).toBe(120);
    expect(r.verdicts[0].note.startsWith('a b')).toBe(true);
  });
});
