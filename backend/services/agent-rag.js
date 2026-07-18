'use strict';

const crypto = require('crypto');
const { db } = require('../db');
const kbAssistant = require('./kb-assistant');
const { buildPrefixTsQuery } = require('./knowledge-base');
const { ycGet } = require('./yclients');
const { createLogger } = require('../logger');
const logger = createLogger('AgentRAG');

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

// ── IO: переэмбеддинг статьи ────────────────────────────────────
// Разбивает статью на чанки, переэмбеддит только изменённые (по content_hash),
// апсертит kb_chunks, удаляет лишние старые чанки. Безопасно вызывать асинхронно.
async function reembedArticle(salonId, articleId) {
  const art = await db.one(
    `SELECT id, salon_id, title, body FROM kb_articles WHERE id=$1 AND salon_id=$2`,
    [articleId, salonId]);
  if (!art) return;

  const chunks = chunkArticle({ title: art.title, body: art.body });
  const existing = await db.any(
    `SELECT chunk_index, content_hash FROM kb_chunks WHERE article_id=$1`,
    [articleId]);
  const oldHash = new Map(existing.map(r => [r.chunk_index, r.content_hash]));

  for (const ch of chunks) {
    const hash = hashChunk(ch.content);
    if (oldHash.get(ch.chunk_index) === hash) continue;   // не изменился
    const embedding = await kbAssistant.embedText(ch.content);
    const norm = vectorNorm(embedding);
    await db.query(
      `INSERT INTO kb_chunks
         (salon_id, article_id, chunk_index, content, content_hash, embedding, embed_norm, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (article_id, chunk_index) DO UPDATE
         SET content=$4, content_hash=$5, embedding=$6, embed_norm=$7, updated_at=now()`,
      [salonId, articleId, ch.chunk_index, ch.content, hash, embedding, norm]);
  }

  // Удаляем чанки, которых больше нет (статья стала короче).
  await db.query(
    `DELETE FROM kb_chunks WHERE article_id=$1 AND chunk_index >= $2`,
    [articleId, chunks.length]);
}

const VECTOR_TOPN = 12;   // сколько кандидатов брать из каждого поиска до слияния

// Гибридный поиск чанков: JS-косинус (pgvector недоступен) + Postgres FTS → RRF.
// Возвращает top-K чанков { id, article_id, content }.
async function retrieveChunks(salonId, query, opts = {}) {
  const limit = opts.limit || 4;
  const q = String(query || '').trim();
  if (!q) return [];

  // 1) Вектор: эмбеддим запрос, тянем все чанки салона, косинус в JS.
  // Эмбеддинг-провайдер (aitunnel) изредка флапает — при его сбое НЕ роняем
  // поиск целиком, а деградируем на FTS-only (ниже). Слово из запроса часто
  // есть в статьях буквально, так что FTS всё равно находит релевантное.
  const all = await db.any(
    `SELECT c.id, c.article_id, c.content, c.embedding, c.embed_norm
       FROM kb_chunks c
       JOIN kb_articles a ON a.id = c.article_id
      WHERE c.salon_id = $1 AND c.embedding IS NOT NULL AND a.is_published = true`,
    [salonId]);
  const byId = new Map(all.map(c => [c.id, c]));
  let vectorRanked = [];
  try {
    const qvec = await kbAssistant.embedText(q);
    const qnorm = vectorNorm(qvec);
    vectorRanked = all
      .map(c => ({ id: c.id, score: cosineSim(qvec, c.embedding, qnorm, c.embed_norm) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_TOPN)
      .map(r => r.id);
  } catch (e) {
    logger.warn(`эмбеддинг недоступен (${e.message}) — деградация на FTS-only поиск`);
  }

  // 2) FTS по search_vector чанков (prefix-tsquery; при пустом — пропускаем).
  let ftsRanked = [];
  const tsq = buildPrefixTsQuery(q);
  if (tsq) {
    const ftsRows = await db.any(
      `SELECT c.id, c.article_id,
              ts_rank(c.search_vector, to_tsquery('russian', $2)) AS rank
         FROM kb_chunks c
         JOIN kb_articles a ON a.id = c.article_id
        WHERE c.salon_id = $1 AND c.search_vector @@ to_tsquery('russian', $2)
          AND a.is_published = true
        ORDER BY rank DESC NULLS LAST
        LIMIT $3`,
      [salonId, tsq, VECTOR_TOPN]);
    ftsRanked = ftsRows.map(r => r.id);
    for (const r of ftsRows) if (!byId.has(r.id)) byId.set(r.id, r);
  }

  // 3) Слияние RRF → top-K, восстанавливаем контент.
  const merged = reciprocalRankFusion([vectorRanked, ftsRanked]).slice(0, limit);
  return merged
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(c => ({ id: c.id, article_id: c.article_id, content: c.content }));
}

const CONTEXT_CHAR_BUDGET = 12000;

// Живые цены/длительность услуг, привязанных к статьям через kb_article_links.
// Цен в БД нет (services_config хранит только теги) → тянем из YClients live по
// entity_yc_id. Любая ошибка/отсутствие интеграции → [] (контекст без блока цен).
async function liveServicesForArticles(salonId, articleIds) {
  if (!articleIds.length) return [];
  const links = await db.any(
    `SELECT DISTINCT entity_yc_id
       FROM kb_article_links
      WHERE salon_id = $1 AND entity_type = 'service'
        AND article_id = ANY($2::int[])`,
    [salonId, articleIds]);
  if (!links.length) return [];
  const wanted = new Set(links.map(l => String(l.entity_yc_id)));
  try {
    const salon = await db.oneOrNone(`SELECT * FROM salons WHERE id=$1`, [salonId]);
    if (!salon || !salon.yclients_company_id) return [];
    const data = await ycGet(salon, `/services/${salon.yclients_company_id}`);
    const services = Array.isArray(data) ? data : [];
    return services
      .filter(s => wanted.has(String(s.id)))
      .map(s => ({
        title: s.title,
        price_min: s.price_min,
        price_max: s.price_max,
        duration: s.duration,
      }));
  } catch (_) {
    return [];   // YClients недоступен → контекст без цен
  }
}

// Формат строки цены из услуги: "Ботулинотерапия — 5000–8000 ₽, 30 мин".
function formatServiceLine(s) {
  const parts = [];
  if (s.price_min != null && s.price_max != null && s.price_min !== s.price_max) {
    parts.push(`${s.price_min}–${s.price_max} ₽`);
  } else if (s.price_min != null) {
    parts.push(`${s.price_min} ₽`);
  }
  if (s.duration != null) parts.push(`${s.duration} мин`);
  return `${s.title}${parts.length ? ' — ' + parts.join(', ') : ''}`;
}

// Собирает grounded-контекст для агента: релевантные чанки + блок живых цен.
// Возвращает { context, sources: number[] (article_id) }.
async function buildKnowledgeContext(salonId, query, opts = {}) {
  const budget = opts.budget || CONTEXT_CHAR_BUDGET;
  const chunks = await retrieveChunks(salonId, query, { limit: opts.limit || 4 });
  if (!chunks.length) return { context: '', sources: [] };

  const articleIds = [...new Set(chunks.map(c => c.article_id))];
  const services = await liveServicesForArticles(salonId, articleIds);

  let context = '';
  for (const c of chunks) {
    const block = `${c.content}\n\n`;
    if (context.length + block.length > budget) break;
    context += block;
  }
  if (services.length) {
    context += 'АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:\n' +
      services.map(formatServiceLine).join('\n') + '\n';
  }

  return { context: context.trim(), sources: articleIds };
}

module.exports = {
  DEFAULT_MAX_CHARS, CONTEXT_CHAR_BUDGET, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
  reembedArticle, retrieveChunks,
  liveServicesForArticles, formatServiceLine, buildKnowledgeContext,
};
