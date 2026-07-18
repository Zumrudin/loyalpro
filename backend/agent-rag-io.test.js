'use strict';

jest.mock('./services/kb-assistant', () => ({
  embedText: jest.fn(async () => [0.1, 0.2, 0.3]),
}));
jest.mock('./db', () => ({
  db: { any: jest.fn(), one: jest.fn(), query: jest.fn(async () => ({})) },
}));

const { db } = require('./db');
const kb = require('./services/kb-assistant');
const rag = require('./services/agent-rag');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reembedArticle', () => {
  test('эмбеддит новые чанки и апсертит', async () => {
    db.one.mockResolvedValue({ id: 7, salon_id: 1, title: 'Ботокс', body: 'Разглаживает морщины.' });
    db.any.mockResolvedValue([]); // существующих чанков нет
    await rag.reembedArticle(1, 7);
    expect(kb.embedText).toHaveBeenCalledTimes(1);        // один короткий чанк
    // upsert выполнен (INSERT ... ON CONFLICT)
    const upsertCalls = db.query.mock.calls.filter(c => /INSERT INTO kb_chunks/i.test(c[0]));
    expect(upsertCalls.length).toBe(1);
  });

  test('неизменённый чанк (совпал hash) не переэмбеддивается', async () => {
    const { hashChunk, chunkArticle } = rag;
    const art = { id: 7, salon_id: 1, title: 'Ботокс', body: 'Разглаживает морщины.' };
    const existingHash = hashChunk(chunkArticle({ title: art.title, body: art.body })[0].content);
    db.one.mockResolvedValue(art);
    db.any.mockResolvedValue([{ chunk_index: 0, content_hash: existingHash }]);
    await rag.reembedArticle(1, 7);
    expect(kb.embedText).not.toHaveBeenCalled();
  });

  test('нет статьи → тихо выходит', async () => {
    db.one.mockResolvedValue(null);
    await rag.reembedArticle(1, 999);
    expect(kb.embedText).not.toHaveBeenCalled();
  });
});

describe('retrieveChunks', () => {
  test('сливает вектор и FTS через RRF, отдаёт top-K', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    // Все чанки салона (для JS-косинуса):
    db.any.mockImplementation(async (sql) => {
      if (/FROM kb_chunks[\s\S]*embedding/i.test(sql) && !/search_vector/i.test(sql)) {
        return [
          { id: 10, article_id: 1, content: 'ботокс морщины', embedding: [1, 0, 0], embed_norm: 1 },
          { id: 11, article_id: 1, content: 'массаж спины',   embedding: [0, 1, 0], embed_norm: 1 },
        ];
      }
      if (/search_vector/i.test(sql)) {
        return [{ id: 11, article_id: 1 }]; // FTS нашёл второй
      }
      return [];
    });
    const out = await rag.retrieveChunks(1, 'ботокс', { limit: 2 });
    expect(out.map(c => c.id)).toContain(10);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[0]).toHaveProperty('content');
  });

  test('пустой запрос → пусто без вызова эмбеддинга', async () => {
    const out = await rag.retrieveChunks(1, '   ', { limit: 4 });
    expect(out).toEqual([]);
    expect(kb.embedText).not.toHaveBeenCalled();
  });
});
