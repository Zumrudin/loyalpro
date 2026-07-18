'use strict';

const { db } = require('../db');
const config = require('../config');
const { buildPrefixTsQuery } = require('./knowledge-base');

// ── RAG-ассистент базы знаний ─────────────────────────────────
// Спека: docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md

const CONTEXT_CHAR_BUDGET = 12000;   // сколько символов статей максимум шлём модели

const SYSTEM_PROMPT =
  'Ты — ассистент базы знаний косметологической клиники PERI CLINIC ' +
  '(это косметологическая клиника, а НЕ салон красоты — так её и называй). ' +
  'Отвечай ТОЛЬКО по тексту статей ниже. Ничего не выдумывай и не добавляй от себя. ' +
  'Если ответа в тексте нет — честно ответь "В базе знаний нет ответа на этот вопрос". ' +
  'Отвечай по-русски, кратко, по делу и единообразно.\n' +
  'Если вопрос про процедуру или услугу — после краткого описания добавь блок ' +
  '(включай только те строки, данные для которых реально есть в статьях; ' +
  'если ни одной из этих данных в статьях нет — блок не добавляй):\n' +
  '💰 Стоимость: <по прайсу из статьи>\n' +
  '👩‍⚕️ Кто выполняет: <специалист из статьи>\n' +
  '⏱️ Длительность: <из статьи>\n' +
  'Не придумывай стоимость, исполнителя или длительность — бери только из текста статей. ' +
  'ВАЖНО: если под вопрос подходит несколько услуг из статей (например, общий запрос ' +
  'вроде «массаж» или «коррекция фигуры»), перечисли ВСЕ подходящие услуги — по каждой ' +
  'отдельный краткий блок с описанием и данными. Не ограничивайся одной услугой и не ' +
  'молчи про остальные подходящие. ' +
  'На остальные вопросы отвечай обычным связным текстом.';

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
  // Таймаут через AbortController — иначе повисший запрос держит соединение
  // до OS-таймаута (минуты). На abort callGemini попробует следующий ключ.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parseGeminiResponse(await res.json());
}

// Dual-key: сначала free, затем paid на ЛЮБОЙ ошибке (429/5xx/сеть). Пустые ключи пропускаются.
// opts: { free, paid, model, fetchFn }. fetchFn по умолчанию — глобальный fetch.
async function callGeminiDirect(prompt, opts) {
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

// Relay-режим: регион прод-сервера не поддерживается бесплатным Gemini API
// ("User location is not supported"), поэтому прод не зовёт Google напрямую, а
// проксирует промпт на dev-сервер (в поддерживаемом регионе), где ключ и вызов.
// Тело: { prompt:{system,user} }; ответ: { answer }. Защита — общий секрет в заголовке.
async function callViaRelay(prompt, { fetchFn }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(config.KB_GEMINI_RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': config.KB_GEMINI_RELAY_SECRET || '',
      },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Relay HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json && json.answer) || '';
}

// Диспетчер: если задан KB_GEMINI_RELAY_URL (прод) — идём через relay; иначе прямой вызов.
async function callGemini(prompt, opts) {
  if (config.KB_GEMINI_RELAY_URL) {
    return callViaRelay(prompt, { fetchFn: (opts && opts.fetchFn) || fetch });
  }
  return callGeminiDirect(prompt, opts);
}

// ── Эмбеддинги (RAG) ───────────────────────────────────────────
// Один вызов embedContent конкретным ключом. Возвращает массив чисел. Бросает {status}.
async function embedContentOnce(text, { key, model, fetchFn }) {
  const url = `${GEMINI_BASE}/${model}:embedContent?key=${key}`;
  const body = { model: `models/${model}`, content: { parts: [{ text }] } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Gemini embed HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const values = json && json.embedding && json.embedding.values;
  if (!Array.isArray(values)) throw new Error('Gemini embed: пустой ответ');
  return values;
}

// Dual-key эмбеддинг: free → paid на любой ошибке. Пустые ключи пропускаются.
async function embedTextDirect(text, opts) {
  const { free, paid, model } = opts;
  const fetchFn = opts.fetchFn || fetch;
  const keys = [free, paid].filter(Boolean);
  if (!keys.length) throw new Error('Gemini embed: не задан ни один ключ');
  let lastErr;
  for (const key of keys) {
    try {
      return await embedContentOnce(text, { key, model, fetchFn });
    } catch (e) { lastErr = e; continue; }
  }
  throw lastErr || new Error('Gemini embed: все ключи недоступны');
}

// Топ-N опубликованных статей салона по релевантности вопросу (FTS + ILIKE fallback).
async function retrieveArticles(salonId, question, limit = 4) {
  const tsq = buildPrefixTsQuery(question);
  if (tsq) {
    const ftsQuery = (tsQuery) => db.any(
      `SELECT id, title, body, category_id,
              ts_rank(search_vector, to_tsquery('russian', $2)) AS rank
         FROM kb_articles
        WHERE salon_id = $1 AND is_published = true
          AND (search_vector @@ to_tsquery('russian', $2)
               OR title ILIKE '%'||$3||'%' OR body ILIKE '%'||$3||'%')
        ORDER BY rank DESC NULLS LAST, display_order ASC
        LIMIT $4`,
      [salonId, tsQuery, question, limit]);
    // Сначала строгий AND (все слова). Вопросы-предложения так почти не находятся,
    // поэтому если пусто — повторяем в режиме OR (любое слово), ранжируя по ts_rank.
    let rows = await ftsQuery(tsq);
    if (!rows.length && tsq.includes(' & ')) {
      rows = await ftsQuery(tsq.replace(/ & /g, ' | '));
    }
    return rows;
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
  callGeminiOnce, callGemini, callGeminiDirect, callViaRelay,
  retrieveArticles, logChat, ask,
  embedContentOnce, embedTextDirect,
};
