'use strict';
// ============================================================
// Справка об услуге из базы знаний — ПРЕДВЫЗОВОМ кода, не вызовом модели.
// ЧИСТЫЙ модуль: ни БД, ни сети (сам поход в RAG делает оркестратор).
// Тесты: agent-service-fact.test.js.
//
// ЗАЧЕМ: главная молчаливая потеря воронки 02.10.2026 — «цена → тишина»:
// цифра без «что входит» и без шага. В блоке каталога описаний услуг нет,
// статьи КБ модель читает только собственным вызовом, то есть правило
// «добавь факт» без материала невыполнимо. Тот же приём, что promo-interest:
// код находит статью заранее и кладёт её в хвост промпта.
//
// ФИЛЬТР РЕЛЕВАНТНОСТИ ОБЯЗАТЕЛЕН: у retrieveChunks порога нет, выдача
// непуста всегда. Судим по ЗАГОЛОВКУ топ-чанка (chunkArticle префиксит
// `${title}\n` к каждому чанку, buildKnowledgeContext склеивает по убыванию
// релевантности → первая непустая строка = заголовок лучшего чанка): он обязан
// делить стем хотя бы с одним словом пациента (или с его алиасом). Служебные
// слова вопроса («сколько», «стоит», «цена»…) в сверке не участвуют — иначе
// статья «Стоимость консультации» легализовалась бы на любой вопрос о цене.
// Не прошло → null, блока нет, ход идёт как до фичи (модель может позвать КБ сама).
//
// Предложения с ЧЧ:ММ выбрасываются: блок стоит после «ТЕКУЩИЙ КОНТЕКСТ:», а
// всё, что там, засевает allowedTimes reply-guard (часы работы из статьи стали
// бы «подтверждённым временем приёма»). Режем ПРЕДЛОЖЕНИЕ, а не строку: абзац
// статьи — одна строка, и выброс целиком терял бы соседние факты.
// ============================================================
const { detectPromptScenarios, SCENARIOS } = require('./prompt-scenarios');
const { stripAllStamps } = require('./transcript-time');

const MAX_FACT_CHARS = 600;
const MAX_QUERY_CHARS = 200;
const STEM_LEN = 4;
const TIME_RE = /\d{1,2}:\d{2}/;
// Хвост контекста buildKnowledgeContext (agent-rag.js) — цены из каталога, не
// статья: цены модель берёт из каталога промпта.
const SERVICES_HEADER_RE = /^АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:/;

// Бытовые названия → стем заголовка статьи. Узкий список, расширять по логу
// «справка не найдена» (оркестратор пишет его INFO).
const ALIASES = {
  'ботокс': 'ботул', 'диспорт': 'ботул', 'релатокс': 'ботул', 'ксеомин': 'ботул', 'ботулин': 'ботул',
  'лазер': 'лазер', 'лазерк': 'лазер', 'эпиляц': 'эпиляц',
  'гиалурон': 'контурн', 'филлер': 'контурн', 'губы': 'губ', 'губ': 'губ',
  'био': 'биоревит', 'мезо': 'мезотерап',
  'полимолочк': 'полимолочн', 'коллаген': 'коллаген',
  'плазм': 'плазм', 'чистк': 'чист', 'пилинг': 'пилинг',
};

// Слова самого вопроса (цена/выбор) и служебные — стемами в сверке заголовка
// не участвуют. Сравнение по началу токена.
const STOP_PREFIXES = [
  'скольк', 'стои', 'цен', 'прайс', 'почем', 'скидк', 'подскаж', 'скаж',
  'знаю', 'выбра', 'выбор', 'посовет', 'помоги', 'подойд', 'подбер', 'лучш',
  'хочу', 'хотел', 'можно', 'нужн', 'мне', 'для', 'что', 'как', 'это', 'эта',
  'здравств', 'добр', 'пожалуйст', 'спасиб', 'процедур', 'услуг', 'сеанс',
];

function wantsServiceFact(lastUserText) {
  if (typeof lastUserText !== 'string' || !lastUserText.trim()) return false;
  const sc = detectPromptScenarios(stripAllStamps(lastUserText));
  return sc.includes(SCENARIOS.PRICE) || sc.includes(SCENARIOS.UNDECIDED);
}

function kbQuery(lastUserText) {
  return stripAllStamps(String(lastUserText || '')).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е');
}

function tokens(text) {
  return norm(text).match(/[\p{L}]{3,}/gu) || [];
}

function stems(userText) {
  const out = new Set();
  for (const t of tokens(userText)) {
    if (STOP_PREFIXES.some(p => t.startsWith(p))) continue;
    out.add(t.slice(0, Math.min(t.length, STEM_LEN + 1)));
    for (const [alias, stem] of Object.entries(ALIASES)) {
      if (t.startsWith(alias)) out.add(stem);
    }
  }
  return [...out];
}

function dropTimedSentences(line) {
  if (!TIME_RE.test(line)) return line;
  return line.split(/(?<=[.!?…])\s+/).filter(s => !TIME_RE.test(s)).join(' ').trim();
}

/**
 * @param {string} context — выдача search_knowledge_base (kb.context)
 * @param {string} userText — последнее сообщение пациента
 * @returns {{title:string, text:string}|null}
 */
function pickServiceFact(context, userText) {
  if (typeof context !== 'string' || !context.trim()) return null;
  const lines = context.split('\n').map(l => l.trim());
  const titleIdx = lines.findIndex(Boolean);
  if (titleIdx < 0) return null;
  const title = lines[titleIdx];
  if (SERVICES_HEADER_RE.test(title) || TIME_RE.test(title)) return null;
  const titleLc = norm(title);
  const st = stems(userText);
  if (!st.length || !st.some(s => titleLc.includes(s))) return null;

  const body = [];
  let total = 0;
  for (const raw of lines.slice(titleIdx + 1)) {
    if (!raw) continue;
    if (SERVICES_HEADER_RE.test(raw)) break;
    // Следующий чанк той же статьи начинается с того же заголовка — дальше не читаем.
    if (body.length && raw === title) break;
    const l = dropTimedSentences(raw);
    if (!l) continue;
    const piece = l.slice(0, MAX_FACT_CHARS - total);
    body.push(piece);
    total += piece.length + 1;
    if (total >= MAX_FACT_CHARS) break;
  }
  if (!body.length) return null;
  return { title, text: body.join('\n').slice(0, MAX_FACT_CHARS) };
}

module.exports = { wantsServiceFact, kbQuery, pickServiceFact, MAX_FACT_CHARS, ALIASES };
