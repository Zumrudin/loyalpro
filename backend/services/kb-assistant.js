'use strict';

const { db } = require('../db');
const config = require('../config');
const { buildPrefixTsQuery } = require('./knowledge-base');

// ── RAG-ассистент базы знаний ─────────────────────────────────
// Спека: docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md

const CONTEXT_CHAR_BUDGET = 12000;   // сколько символов статей максимум шлём модели

const SYSTEM_PROMPT =
  'Ты ассистент базы знаний салона красоты. Отвечай ТОЛЬКО по тексту статей ниже. ' +
  'Если ответа в тексте нет — честно ответь "В базе знаний нет ответа на этот вопрос". ' +
  'Ничего не выдумывай и не добавляй от себя. Отвечай кратко, по-русски, по делу.';

// Склеивает статьи в единый контекст, обрезая по бюджету символов.
function buildContext(articles, budget = CONTEXT_CHAR_BUDGET) {
  if (!Array.isArray(articles) || !articles.length) return '';
  let out = '';
  for (const a of articles) {
    const block = `### ${a.title}\n${a.body || ''}\n\n`;
    if (out.length + block.length > budget) {
      out += block.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += block;
  }
  return out.slice(0, budget);
}

// Собирает system + user промпт для Gemini.
function buildPrompt(question, context) {
  return {
    system: SYSTEM_PROMPT,
    user: `СТАТЬИ:\n${context}\n\nВОПРОС: ${question}`,
  };
}

// Достаёт текст ответа из JSON-ответа generateContent.
function parseGeminiResponse(json) {
  const parts = json && json.candidates && json.candidates[0]
    && json.candidates[0].content && json.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && p.text) || '').join('');
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 20000;

// Один вызов generateContent конкретным ключом. Бросает {status} на не-2xx.
async function callGeminiOnce(prompt, { key, model, fetchFn }) {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
  const body = {
    system_instruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
  };
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parseGeminiResponse(await res.json());
}

// Dual-key: сначала free, затем paid на ЛЮБОЙ ошибке (429/5xx/сеть). Пустые ключи пропускаются.
// opts: { free, paid, model, fetchFn }. fetchFn по умолчанию — глобальный fetch.
async function callGemini(prompt, opts) {
  const { free, paid, model } = opts;
  const fetchFn = opts.fetchFn || fetch;
  const keys = [free, paid].filter(Boolean);
  if (!keys.length) throw new Error('Gemini: не задан ни один ключ');

  let lastErr;
  for (const key of keys) {
    try {
      return await callGeminiOnce(prompt, { key, model, fetchFn });
    } catch (e) {
      lastErr = e;
      // На 429 (лимит) пробуем следующий ключ; на прочих ошибках — тоже пробуем,
      // но если ключей больше нет — пробросим ошибку ниже.
      continue;
    }
  }
  throw lastErr || new Error('Gemini: все ключи недоступны');
}

// Топ-N опубликованных статей салона по релевантности вопросу (FTS + ILIKE fallback).
async function retrieveArticles(salonId, question, limit = 4) {
  const tsq = buildPrefixTsQuery(question);
  if (tsq) {
    return db.any(
      `SELECT id, title, body, category_id,
              ts_rank(search_vector, to_tsquery('russian', $2)) AS rank
         FROM kb_articles
        WHERE salon_id = $1 AND is_published = true
          AND (search_vector @@ to_tsquery('russian', $2)
               OR title ILIKE '%'||$3||'%' OR body ILIKE '%'||$3||'%')
        ORDER BY rank DESC NULLS LAST, display_order ASC
        LIMIT $4`,
      [salonId, tsq, question, limit]);
  }
  // Ввод из одних спецсимволов → только ILIKE.
  return db.any(
    `SELECT id, title, body, category_id, NULL::real AS rank
       FROM kb_articles
      WHERE salon_id = $1 AND is_published = true
        AND (title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%')
      ORDER BY display_order ASC
      LIMIT $3`,
    [salonId, question, limit]);
}

// Пишет запись в kb_chat_logs. Ошибку логирования глотаем — не роняем ответ.
async function logChat(salonId, userId, question, answer, sourceIds) {
  try {
    await db.query(
      `INSERT INTO kb_chat_logs (salon_id, user_id, question, answer, source_ids)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, userId, question, answer, sourceIds]);
  } catch (_) { /* лог не критичен */ }
}

// Оркестратор: retrieve → guard → prompt → LLM → log → { answer, sources }.
// Бросает ошибку с .code для дифференциации на уровне роута.
async function ask(salonId, userId, question) {
  const free  = config.KB_GEMINI_KEY_FREE;
  const paid  = config.KB_GEMINI_KEY_PAID;
  const model = config.KB_LLM_MODEL;
  if (!free && !paid) {
    const e = new Error('Ассистент не настроен'); e.code = 'NOT_CONFIGURED'; throw e;
  }

  const articles = await retrieveArticles(salonId, question, 4);
  const sources = articles.map(a => ({ id: a.id, title: a.title, category_id: a.category_id }));
  const sourceIds = articles.map(a => a.id);

  if (!articles.length) {
    const answer = 'В базе знаний нет статей по этому вопросу.';
    await logChat(salonId, userId, question, answer, []);
    return { answer, sources: [] };
  }

  const context = buildContext(articles);
  const prompt = buildPrompt(question, context);

  let answer;
  try {
    answer = await callGemini(prompt, { free, paid, model });
  } catch (e) {
    // LLM недоступен/лимит → деградация: отдаём источники, помечаем degraded.
    await logChat(salonId, userId, question, '[LLM error] ' + e.message, sourceIds);
    const err = new Error('LLM недоступен'); err.code = 'LLM_UNAVAILABLE'; err.sources = sources;
    throw err;
  }

  answer = (answer || '').trim() || 'Не удалось сформировать ответ.';
  await logChat(salonId, userId, question, answer, sourceIds);
  return { answer, sources };
}

module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini,
  retrieveArticles, logChat, ask,
};
