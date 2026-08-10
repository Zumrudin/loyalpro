'use strict';

jest.mock('./services/kb-assistant', () => ({
  embedText: jest.fn(async () => [0.1, 0.2, 0.3]),
}));
jest.mock('./db', () => ({
  db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(async () => ({})) },
}));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));

const { db } = require('./db');
const kb = require('./services/kb-assistant');
const yc = require('./services/yclients');
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

  test('сбой эмбеддинга → деградация на FTS-only, поиск не падает', async () => {
    kb.embedText.mockRejectedValue(new Error('aitunnel embed: пустой ответ'));
    db.any.mockImplementation(async (sql) => {
      if (/FROM kb_chunks[\s\S]*embedding/i.test(sql) && !/search_vector/i.test(sql)) {
        return [
          { id: 10, article_id: 1, content: 'ботокс морщины', embedding: [1, 0, 0], embed_norm: 1 },
          { id: 11, article_id: 1, content: 'лазерная эпиляция', embedding: [0, 1, 0], embed_norm: 1 },
        ];
      }
      if (/search_vector/i.test(sql)) return [{ id: 11, article_id: 1 }]; // FTS нашёл эпиляцию
      return [];
    });
    const out = await rag.retrieveChunks(1, 'эпиляция', { limit: 4 });
    // вектор отвалился, но FTS-результат вернулся — функция не бросила
    expect(out.map(c => c.id)).toEqual([11]);
    expect(out[0].content).toBe('лазерная эпиляция');
  });

  test('вектор и FTS фильтруют по опубликованным статьям', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockResolvedValue([]);
    await rag.retrieveChunks(1, 'ботокс', { limit: 2 });
    const sqls = db.any.mock.calls.map(c => c[0]);
    const vectorSql = sqls.find(s => /FROM kb_chunks/i.test(s) && /embedding/i.test(s) && !/search_vector/i.test(s));
    const ftsSql = sqls.find(s => /search_vector/i.test(s));
    expect(vectorSql).toMatch(/is_published/i);
    expect(ftsSql).toMatch(/is_published/i);
  });

  // Диагностика 2026-08-10: search_knowledge_base отдал Миле внутреннюю статью
  // «Отдел заботы: … ИНСТРУКЦИЯ ДЛЯ АДМИНИСТРАТОРА» — у статей не было признака
  // аудитории, и внутренний регламент мог процитироваться пациенту. Поиск Милы
  // обязан отсеивать internal_only в ОБЕИХ ветках (вектор и FTS); админский
  // ассистент КБ этим фильтром не пользуется — сотрудникам статьи видны.
  test('вектор и FTS не отдают внутренние статьи (internal_only)', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockResolvedValue([]);
    await rag.retrieveChunks(1, 'ботокс', { limit: 2 });
    const sqls = db.any.mock.calls.map(c => c[0]);
    const vectorSql = sqls.find(s => /FROM kb_chunks/i.test(s) && /embedding/i.test(s) && !/search_vector/i.test(s));
    const ftsSql = sqls.find(s => /search_vector/i.test(s));
    expect(vectorSql).toMatch(/internal_only\s*=\s*false/i);
    expect(ftsSql).toMatch(/internal_only\s*=\s*false/i);
  });
});

describe('buildKnowledgeContext', () => {
  test('собирает контекст из чанков и живых цен связанных услуг', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockImplementation(async (sql) => {
      if (/FROM kb_chunks[\s\S]*embedding/i.test(sql) && !/search_vector/i.test(sql)) {
        return [{ id: 10, article_id: 1, content: 'Ботокс: разглаживает морщины', embedding: [1, 0, 0], embed_norm: 1 }];
      }
      if (/search_vector/i.test(sql)) return [];
      if (/kb_article_links/i.test(sql)) return [{ entity_yc_id: 555 }];
      return [];
    });
    db.oneOrNone.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    yc.ycGet.mockResolvedValue([
      { id: 555, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000, duration: 30 },
      { id: 999, title: 'Массаж', price_min: 2000, price_max: 2000, duration: 60 },
    ]);
    const ctx = await rag.buildKnowledgeContext(1, 'ботокс');
    expect(ctx.context).toContain('разглаживает морщины');
    expect(ctx.context).toContain('Ботулинотерапия');
    expect(ctx.context).toMatch(/5000/);
    expect(ctx.context).not.toContain('Массаж');   // не связана со статьёй
    expect(ctx.sources).toContain(1);   // article_id
  });

  test('нет чанков → пустой контекст', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockResolvedValue([]);
    const ctx = await rag.buildKnowledgeContext(1, 'нет-такого');
    expect(ctx.context).toBe('');
    expect(ctx.sources).toEqual([]);
  });
});
