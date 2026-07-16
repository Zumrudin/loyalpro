'use strict';

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

module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini,
};
