'use strict';
// ============================================================
// «Цена → факт → шаг» — ДЕТЕРМИНИРОВАННАЯ дописка оркестратора.
// ЧИСТЫЙ модуль: ни БД, ни сети. Тесты: agent-price-followthrough.test.js.
//
// ЗАЧЕМ: главная молчаливая потеря воронки 02.10.2026 — «цена → тишина».
// Промпт-правило PRICE_FOLLOWTHROUGH (sales-modules.js) живой пробник
// scripts/agent-sales-probe.js провалил 3/3 (07.10.2026): справка об услуге
// в промпте есть, а модель отвечает голой цифрой («…чистка лица стоит
// 6 500 ₽.»), в 2/3 — ещё и без следующего шага. По мораторию на новые
// промпт-правила такие дефекты закрываются кодом: факт берётся ДОСЛОВНО из
// справки КБ (serviceFact, предвызов service-fact.js), шаг — одна константа.
//
// Модуль решает только по ТЕКСТУ (сценарий сообщения пациента, суммы в
// реплике, есть ли уже факт/шаг). Состояние хода (запись, эскалация, ложное
// утверждение, запасной текст…) и флаг AGENT_PRICE_FOLLOWTHROUGH проверяет
// оркестратор — у него эти факты, здесь их не продублировать без копий.
// ============================================================
const { detectPromptScenarios, SCENARIOS } = require('./prompt-scenarios');
const { PRICE_SUM_RE, NEXT_STEP_RE } = require('./reply-guard');
const { hasTime } = require('./service-fact');

// Шаг — вопрос без времени и эмодзи: время здесь назвать нечем (слотов в
// этом ходе не смотрели), а эмодзи у реплики модели своё уже может быть.
const STEP_QUESTION = 'Подобрать вам удобное время для записи?';
const MAX_FACT_SENTENCE = 180;
const MIN_FACT_SENTENCE = 20;
// ≥3 разных суммы — это перечень цен, а не ответ про одну услугу: дописка
// «факт об услуге» к прайсу читалась бы как факт об одной из позиций.
const MULTI_PRICE_MIN = 3;
const STEM_LEN = 5;
// Слова, общие для любой реплики о цене и любой статьи, — сходством
// содержания не считаются (иначе «процедура» в обоих = «факт уже назван»).
const STOP_STEMS = new Set([
  'проце', 'услуг', 'стоим', 'стоит', 'рубле', 'клини', 'пацие', 'специ', 'врача',
  'котор', 'также', 'может', 'можно', 'очень', 'всего', 'этого', 'более', 'после', 'перед',
  'время', 'запис', 'завис', 'сеанс', 'здрав', 'добры', 'добро', 'пожал', 'подск',
  'сколь', 'будет', 'вашей', 'вашег', 'нашей', 'нашем', 'наших',
]);

const SUM_RE_G = new RegExp(PRICE_SUM_RE.source, 'giu');

function norm(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е');
}

function contentStems(text) {
  const out = new Set();
  for (const w of norm(text).match(/\p{L}{5,}/gu) || []) {
    const st = w.slice(0, STEM_LEN);
    if (!STOP_STEMS.has(st)) out.add(st);
  }
  return out;
}

function distinctSums(text) {
  const out = new Set();
  for (const m of String(text || '').match(SUM_RE_G) || []) out.add(m.replace(/\D/g, ''));
  return out.size;
}

// Первое предложение справки — дословно, или null, если оно не годится:
// не законченное предложение (обрезано капом справки посреди слова), со
// временем (засеяло бы «подтверждённое время»), со своей суммой (цена — только
// из каталога), вопрос, слишком длинное/короткое.
function factSentence(text) {
  const firstLine = String(text || '').split('\n').map(l => l.trim()).find(Boolean);
  if (!firstLine) return null;
  const sentence = firstLine.split(/(?<=[.!…])\s+/)[0].trim();
  if (sentence.length < MIN_FACT_SENTENCE || sentence.length > MAX_FACT_SENTENCE) return null;
  if (!/[.!…]$/.test(sentence)) return null;
  if (!/^[\p{Lu}\p{N}«"]/u.test(sentence)) return null;
  if (hasTime(sentence) || PRICE_SUM_RE.test(sentence) || sentence.includes('?')) return null;
  return sentence;
}

// Факт «уже прозвучал», если реплика делит с его предложением хоть один
// содержательный стем (≥5 букв), не считая слов заголовка статьи и вопроса
// пациента: название услуги стоит и в реплике, и в факте, и само по себе
// фактом не является.
function factAlreadyConveyed(replyText, sentence, { title = '', patientText = '' } = {}) {
  const ignore = new Set([...contentStems(title), ...contentStems(patientText)]);
  const replyStems = contentStems(replyText);
  for (const st of contentStems(sentence)) {
    if (!ignore.has(st) && replyStems.has(st)) return true;
  }
  return false;
}

/**
 * @param {string[]} replies — финальные реплики хода (серия отдельных сообщений)
 * @param {{patientLastText?:string, serviceFact?:{title:string,text:string}|null}} opts
 * @returns {{replies:string[], addedFact:boolean, addedStep:boolean, reason:string|null}}
 */
function applyPriceFollowthrough(replies, opts = {}) {
  const list = Array.isArray(replies) ? replies : [];
  const unchanged = reason => ({ replies: list, addedFact: false, addedStep: false, reason });
  if (!list.length || !String(list[list.length - 1] || '').trim()) return unchanged('no_reply');
  const patientText = String(opts.patientLastText || '');
  const sc = detectPromptScenarios(patientText);
  if (!sc.includes(SCENARIOS.PRICE)) return unchanged('not_price');
  // Пациент одновременно просит записать — Мила уже ведёт запись, «подобрать
  // время?» поверх неё лишнее.
  if (sc.includes(SCENARIOS.BOOKING) || sc.includes(SCENARIOS.MANAGE_BOOKING)) return unchanged('booking');
  const joined = list.join('\n');
  if (!PRICE_SUM_RE.test(joined)) return unchanged('no_sum');
  if (distinctSums(joined) >= MULTI_PRICE_MIN) return unchanged('price_list');

  const add = [];
  let addedFact = false;
  const fact = opts.serviceFact;
  if (fact && typeof fact.text === 'string') {
    const sentence = factSentence(fact.text);
    if (sentence && !factAlreadyConveyed(joined, sentence, { title: fact.title, patientText })) {
      add.push(sentence);
      addedFact = true;
    }
  }
  // Шаг судим по ИСХОДНОЙ реплике: факт из справки может содержать «входит»/
  // «длится», и считать его шагом значило бы снова оставить цену без
  // предложения записаться.
  const addedStep = !NEXT_STEP_RE.test(joined);
  if (addedStep) add.push(STEP_QUESTION);
  if (!add.length) return unchanged('complete');

  const out = list.slice();
  const last = out.length - 1;
  out[last] = `${String(out[last]).trimEnd()} ${add.join(' ')}`;
  return { replies: out, addedFact, addedStep, reason: null };
}

module.exports = {
  applyPriceFollowthrough, factSentence, factAlreadyConveyed, distinctSums,
  STEP_QUESTION, MAX_FACT_SENTENCE, MULTI_PRICE_MIN,
};
