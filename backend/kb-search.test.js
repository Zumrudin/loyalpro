'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn() } }));
jest.mock('./services/kb-assistant', () => ({ embedText: jest.fn() }));
const { db } = require('./db');
const kb = require('./services/kb-assistant');
const { searchArticles, isTeamOverview, packContext } = require('./services/kb-search');
beforeEach(() => jest.clearAllMocks());
test.each(['какие специалисты у нас работают ?', 'кто у нас работает?', 'наши врачи', 'Расскажи о команде', 'перечисли всех специалистов клиники'])('overview: %s', q => expect(isTeamOverview(q)).toBe(true));
test.each(['кто выполняет Lumecca?', 'какие специалисты делают массаж?', 'расскажи о враче Ивановой', 'какой врач работает на аппарате X', 'какие противопоказания'])('targeted: %s', q => expect(isTeamOverview(q)).toBe(false));
test('whole team section, more than four profiles', async () => {
  const profiles = Array.from({ length: 7 }, (_, id) => ({ id, title: `Врач ${id}`, body: 'Описание' }));
  db.any.mockResolvedValueOnce([{ id: 19, title: 'Специалисты клиники' }, { id: 1, title: 'Услуги' }]).mockResolvedValueOnce(profiles);
  expect(await searchArticles(23, 'какие специалисты у нас работают?')).toEqual(profiles);
  expect(db.any.mock.calls[1][1]).toEqual([23, [19]]);
  expect(db.any.mock.calls[1][0]).toMatch(/a.is_published=true/);
  expect(db.any.mock.calls[1][0]).not.toMatch(/LIMIT/);
  expect(kb.embedText).not.toHaveBeenCalled();
});
test('hybrid fusion deduplicates; tenant and publication filters, staff audience', async () => {
  kb.embedText.mockResolvedValue([1, 0]);
  db.any.mockResolvedValueOnce([{ id: 2 }]).mockResolvedValueOnce([
    { article_id: 1, embedding: [1, 0], embed_norm: 1 },
    { article_id: 1, embedding: [1, 0], embed_norm: 1 },
    { article_id: 2, embedding: [0.8, 0.2], embed_norm: 1 },
  ]).mockResolvedValueOnce([{ id: 1 }, { id: 2, internal_only: true }]);
  expect((await searchArticles(23, 'убрать морщинки')).map(a => a.id)).toEqual([2, 1]);
  for (const [sql, params] of db.any.mock.calls) {
    expect(params[0]).toBe(23);
    expect(sql).toMatch(/salon_id=\$1/);
    expect(sql).toMatch(/is_published=true/);
    expect(sql).not.toMatch(/internal_only\s*=\s*false/);
  }
  expect(db.any.mock.calls[0][0]).toContain('c.salon_id=a.salon_id');
  expect(db.any.mock.calls[0][0]).toContain('a.tags');
});
test('embedding outage preserves keyword results', async () => {
  kb.embedText.mockRejectedValue(new Error('offline'));
  db.any.mockResolvedValueOnce([{ id: 3 }]).mockResolvedValueOnce([{ article_id: 3, embedding: [1], embed_norm: 1 }]).mockResolvedValueOnce([{ id: 3 }]);
  expect(await searchArticles(23, 'массаж')).toEqual([{ id: 3 }]);
});
test('missing index preserves lexical results', async () => {
  db.any.mockResolvedValueOnce([{ id: 3 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 3 }]);
  expect(await searchArticles(23, 'массаж')).toEqual([{ id: 3 }]);
  expect(kb.embedText).not.toHaveBeenCalled();
});
test('empty team section falls back to hybrid', async () => {
  db.any.mockResolvedValueOnce([{ id: 1, title: 'Специалисты' }]).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 3 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 3 }]);
  expect(await searchArticles(23, 'наши врачи')).toEqual([{ id: 3 }]);
});
test('no matches gives no sources', async () => {
  db.any.mockResolvedValue([]);
  expect(await searchArticles(23, 'несуществующий термин')).toEqual([]);
});
test('every profile fits; truncated content is marked', () => {
  const profiles = Array.from({ length: 7 }, (_, id) => ({ id, title: `Врач ${id}`, category_title: 'Специалисты', body: 'Описание '.repeat(1000) }));
  const p = packContext(profiles, 4000);
  expect(p.context.length).toBeLessThanOrEqual(4000);
  expect(p.truncated).toBe(true);
  expect(p.articles).toHaveLength(7);
  for (const a of profiles) expect(p.context).toContain(a.title);
});
test('only included articles are sources', () => {
  const p = packContext(Array.from({ length: 45 }, (_, id) => ({ id, title: `Врач ${id}`, body: 'Описание' })));
  expect(p.articles).toHaveLength(40);
  expect(p.truncated).toBe(true);
});

describe('source relevance selection', () => {
  const { rerank } = require('./services/kb-search');
  const candidates = [{ id: 1, title: 'Процедура' }, { id: 2, title: 'Врач' }];
  test('selects only relevant sources', async () => {
    kb.callGemini = jest.fn().mockResolvedValue('{"ids":[2,2]}');
    expect(await rerank('вопрос', candidates, new Map(), 8)).toEqual([candidates[1]]);
  });
  test('rejects unrelated semantic matches', async () => {
    kb.callGemini = jest.fn().mockResolvedValue('{"ids":[]}');
    expect(await rerank('нет ответа', candidates, new Map(), 8)).toEqual([]);
  });
  test.each(['{"ids":[999]}', '{"ids":["2"]}', 'not json'])('invalid selection: %s', async raw => {
    kb.callGemini = jest.fn().mockResolvedValue(raw);
    expect(await rerank('вопрос', candidates, new Map(), 1)).toEqual([candidates[0]]);
  });
});
