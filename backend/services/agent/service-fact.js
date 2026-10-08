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
const { extractTimes, PRICE_SUM_RE } = require('./reply-guard');

const MAX_FACT_CHARS = 600;
const MAX_QUERY_CHARS = 200;
const STEM_LEN = 4;
// «Есть время» — РОВНО по правилу reply-guard (extractTimes: «10:00» И
// «10.00», но не дата «11.08»): важно то, что засеет allowedTimes, а не своя
// копия регулярки, которая разъедется с ним.
function hasTime(text) {
  return extractTimes(text).length > 0;
}
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
  if (!hasTime(line)) return line;
  return line.split(/(?<=[.!?…])\s+/).filter(s => !hasTime(s)).join(' ').trim();
}

// ── Отбор ОПИСАТЕЛЬНОГО абзаца топ-чанка (живой прогон 08.10.2026) ─────────
// Первый абзац реальных статей — мусор для пациента: редакторская пометка
// («Цены в статье обновлены в строгом соответствии с представленным
// прайс-листом.» — статьи 5 и 7), разделитель `---`, markdown-заголовок, строка
// прайса «* **Подбородок** — 4 000 ₽ (врач)…». Брать первый абзац значило
// дописывать пометку пациенту (price-followthrough) и класть её в промпт
// напоминания. Теперь — первый абзац из ОПИСАТЕЛЬНЫХ строк: законченное
// предложение ≥40 символов, без списка/заголовка/сумм/служебных слов, вне
// разделов «Кто выполняет», «Стоимость», «Показания/Противопоказания»,
// «Подготовка», «Ссылка» и FAQ-вопросов. Нет такого — null (блока нет).
const LIST_RE = /^(?:[*\-•#>]|\d+[.)](?:\s|$)|---)/u;
// «обновлен(ы/а/о)» — целым словом: «по обновлению кожи» — описание, не пометка.
const META_RE = /стать[еяи]|прайс|(?<![\p{L}])обновлен[аоы]?(?![\p{L}])|актуальн|уточняйте|(?<![\p{L}])см\.|ссылк/iu;
// «руб» — только рубли («рубл…», «руб.», «руб»), не «рубцы/рубцов».
const MONEY_RE = /₽|(?<![\p{L}])руб(?:л|\.|(?![\p{L}]))/iu;
const SKIP_SECTION_RE = /кто\s+выполня|стоимост|цен[аыуе]|противопоказ|показани|подготовк|ссылк/iu;
const SENTENCE_END_RE = /[.!…]$/u;
// Строка-«заголовок» (не markdown, без конечной пунктуации) — это первая строка
// СЛЕДУЮЩЕГО чанка (chunkArticle префиксит заголовок статьи без точки): граница
// топ-чанка, дальше чужой текст.
const PLAIN_END_RE = /[.!?…:;»)]$/u;
const MIN_DESCRIPTIVE = 40;
const MAX_PARAGRAPHS = 12;

function stripEmphasis(line) {
  return String(line || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

function isMarkdownLine(raw) {
  return LIST_RE.test(raw) || raw.startsWith('**');
}

function isDescriptive(raw) {
  if (!raw || isMarkdownLine(raw)) return false;
  // Непарные ** — остаток разметки (обрезанный жирный ярлык), не текст.
  if ((raw.match(/\*\*/g) || []).length % 2) return false;
  if (PRICE_SUM_RE.test(raw) || MONEY_RE.test(raw) || META_RE.test(raw)) return false;
  const text = stripEmphasis(raw);
  return text.length >= MIN_DESCRIPTIVE && SENTENCE_END_RE.test(text);
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
  if (SERVICES_HEADER_RE.test(title) || hasTime(title)) return null;
  const titleLc = norm(title);
  const st = stems(userText);
  if (!st.length || !st.some(s => titleLc.includes(s))) return null;

  // Идём по строкам ТОЛЬКО топ-чанка. Границы: блок цен каталога, повтор
  // заголовка (следующий чанк той же статьи), строка-заголовок чужого чанка
  // (PLAIN_END_RE), и страховочный кап по числу абзацев. Берём первый абзац
  // из подряд идущих описательных строк — один факт, а не пересказ статьи.
  const chosen = [];
  let section = '';
  let paragraphs = 0;
  let inPara = false;
  for (const raw of lines.slice(titleIdx + 1)) {
    if (!raw) {
      if (chosen.length) break;
      if (inPara) { inPara = false; if (++paragraphs >= MAX_PARAGRAPHS) break; }
      continue;
    }
    if (SERVICES_HEADER_RE.test(raw) || raw === title) break;
    if (!isMarkdownLine(raw) && !PLAIN_END_RE.test(stripEmphasis(raw))) break;
    inPara = true;
    if (raw.startsWith('#')) {
      if (chosen.length) break;
      section = raw;
      continue;
    }
    const skipSection = section && (SKIP_SECTION_RE.test(section) || section.endsWith('?'));
    const l = dropTimedSentences(raw);
    if (skipSection || !isDescriptive(l)) {
      if (chosen.length) break;
      continue;
    }
    chosen.push(stripEmphasis(l));
    if (chosen.join('\n').length >= MAX_FACT_CHARS) break;
  }
  if (!chosen.length) return null;
  return { title, text: chosen.join('\n').slice(0, MAX_FACT_CHARS) };
}

// Поход в RAG за справкой (эмбеддинг запроса + поиск, у buildKnowledgeContext
// внутри бывает и живой YClients /services с 30-секундным axios): справка —
// украшение, зависший RAG не должен держать ни ход Милы до первого прохода
// провайдера, ни бюджет LLM у напоминания. Одна константа на оба потребителя
// (оркестратор и followup-worker). По таймауту — без справки (fail-open).
const SERVICE_FACT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

module.exports = {
  wantsServiceFact, kbQuery, pickServiceFact, hasTime, MAX_FACT_CHARS, ALIASES,
  META_RE, MONEY_RE, stripEmphasis,
  SERVICE_FACT_TIMEOUT_MS, withTimeout,
};
