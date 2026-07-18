'use strict';

const rag = require('./services/agent-rag');

describe('chunkArticle', () => {
  test('короткая статья → один чанк с заголовком', () => {
    const chunks = rag.chunkArticle({ title: 'Ботокс', body: 'Разглаживает морщины.' }, { maxChars: 1200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].content).toContain('Ботокс');
    expect(chunks[0].content).toContain('Разглаживает морщины.');
  });

  test('абзацы упаковываются в чанки по лимиту', () => {
    const body = ['A'.repeat(700), 'B'.repeat(700), 'C'.repeat(700)].join('\n\n');
    const chunks = rag.chunkArticle({ title: 'T', body }, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.content.length <= 1000 + 100)).toBe(true);
    chunks.forEach((c, i) => expect(c.chunk_index).toBe(i));
  });

  test('пустое тело → один чанк только с заголовком', () => {
    const chunks = rag.chunkArticle({ title: 'Только заголовок', body: '' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Только заголовок');
  });

  test('очень длинный абзац режется по maxChars', () => {
    const chunks = rag.chunkArticle({ title: 'T', body: 'X'.repeat(3000) }, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('hashChunk', () => {
  test('детерминирован и различает контент', () => {
    expect(rag.hashChunk('abc')).toBe(rag.hashChunk('abc'));
    expect(rag.hashChunk('abc')).not.toBe(rag.hashChunk('abd'));
  });
});

describe('vectorNorm & cosineSim', () => {
  test('норма считается корректно', () => {
    expect(rag.vectorNorm([3, 4])).toBeCloseTo(5, 6);
  });

  test('косинус одинаковых векторов = 1', () => {
    const a = [1, 2, 3];
    expect(rag.cosineSim(a, a, rag.vectorNorm(a), rag.vectorNorm(a))).toBeCloseTo(1, 6);
  });

  test('косинус ортогональных = 0', () => {
    const a = [1, 0], b = [0, 1];
    expect(rag.cosineSim(a, b, rag.vectorNorm(a), rag.vectorNorm(b))).toBeCloseTo(0, 6);
  });

  test('нулевая норма → 0 без деления на ноль', () => {
    expect(rag.cosineSim([0, 0], [1, 1], 0, rag.vectorNorm([1, 1]))).toBe(0);
  });
});

describe('reciprocalRankFusion', () => {
  test('id из обоих списков поднимается выше', () => {
    const merged = rag.reciprocalRankFusion([['a', 'b', 'c'], ['b', 'd']], 60);
    expect(merged[0]).toBe('b');           // встречается в обоих
    expect(merged).toContain('a');
    expect(merged).toContain('d');
  });

  test('пустые списки → пустой результат', () => {
    expect(rag.reciprocalRankFusion([[], []], 60)).toEqual([]);
  });
});
