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

module.exports = { DEFAULT_MAX_CHARS, chunkArticle, hashChunk };
