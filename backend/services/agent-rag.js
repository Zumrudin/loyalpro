'use strict';

const crypto = require('crypto');

// ── Чистые хелперы RAG-слоя (без БД/HTTP, юнит-тестируемы) ──────
// Спека: docs/superpowers/specs/2026-07-18-kb-rag-retrieval-design.md

const DEFAULT_MAX_CHARS = 1200;   // ~300 токенов на чанк

// Режет строку на куски не длиннее maxChars по границам, ближе к концу.
function hardSplit(text, maxChars) {
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    out.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars);
  }
  if (rest) out.push(rest);
  return out;
}

// Бьёт статью на чанки: заголовок префиксом к каждому чанку, тело — по абзацам,
// жадно упаковывая в куски ≤ maxChars. Длинные абзацы дорезаются hardSplit.
function chunkArticle(article, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const title = String((article && article.title) || '').trim();
  const body = String((article && article.body) || '').trim();
  const prefix = title ? `${title}\n` : '';

  const paras = body ? body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean) : [];
  const pieces = [];
  for (const p of paras) {
    for (const piece of hardSplit(p, maxChars)) pieces.push(piece);
  }
  if (!pieces.length) pieces.push('');

  const chunks = [];
  let buf = '';
  for (const piece of pieces) {
    const candidate = buf ? `${buf}\n\n${piece}` : piece;
    if (candidate.length > maxChars && buf) {
      chunks.push(buf);
      buf = piece;
    } else {
      buf = candidate;
    }
  }
  if (buf || !chunks.length) chunks.push(buf);

  return chunks.map((content, i) => ({
    chunk_index: i,
    content: `${prefix}${content}`.trim(),
  }));
}

// SHA-256 hex контента чанка — чтобы не переэмбеддить неизменённое.
function hashChunk(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

// Евклидова норма вектора.
function vectorNorm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

// Косинус по предпосчитанным нормам. Нулевая норма → 0.
function cosineSim(a, b, normA, normB) {
  if (!normA || !normB) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

// Reciprocal Rank Fusion: score(id) = Σ 1/(k + rank). rank — 0-based позиция
// в каждом ранжированном списке id. Возвращает id, отсортированные по убыванию.
function reciprocalRankFusion(rankLists, k = 60) {
  const scores = new Map();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

module.exports = {
  DEFAULT_MAX_CHARS, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
};
