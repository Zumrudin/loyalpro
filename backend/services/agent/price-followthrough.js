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
const { hasTime, META_RE, MONEY_RE, stripEmphasis } = require('./service-fact');
const { parseDayPart } = require('./patient-time');
const { resolveDateInfo } = require('./offer-attribution');

// Шаг — вопрос без времени и эмодзи: время здесь назвать нечем (слотов в
// этом ходе не смотрели), а эмодзи у реплики модели своё уже может быть.
// «Вам» с заглавной — так пишет Мила (живой прогон 08.10.2026).
const STEP_QUESTION = 'Подобрать Вам удобное время для записи?';
const MAX_FACT_SENTENCE = 180;
const MIN_FACT_SENTENCE = 20;
// Перечень цен, а не ответ про одну услугу: ≥3 разных суммы ИЛИ ≥2 разных
// суммы на разных строках (столбик прайса). Дописка «факт об услуге» к прайсу
// читалась бы как факт об одной из позиций. Диапазон «от X до Y ₽» в одной
// строке — ещё ответ про одну услугу.
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
// Вопрос пациента именно о цене. Сценарий PRICE шире: в нём и «скидк» —
// «есть скидки?» это вопрос об акции, голой цены услуги там нет, и «факт об
// услуге + подобрать время?» был бы ответом не на то.
const PRICE_QUESTION_RE = /(?:цен[аыуе]|стоимост|сколько\s+(?:стоит|стоят|будет)|прайс|поч[её]м)/iu;
// Граница предложения — только перед заглавной/кавычкой: «ок. 6–8 сеансов»,
// «т.е. только для взрослых» не рвутся на сокращении.
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+(?=[\p{Lu}«"])/u;
// Кандидат, кончающийся сокращением с точкой («ок.», «мин.», «т.е.»), —
// огрызок: обрезан капом справки или на сокращении перед заглавной («г. Москва»).
// СПИСКОМ, а не «любое короткое строчное слово»: так отвергались бы законные
// «…для всех.», «…чистка лица.», «…до года.» — самые частые окончания статей.
const ABBREV_END_RE = /(?:^|[\s.(])(?:ок|мин|сек|ч|г|гг|ул|д|т\.\s?е|т\.\s?к|т\.\s?д|т\.\s?п|т\.\s?ч|др|пр|см|мм|мл|ед|руб|тыс|млн|напр|прим|им|ср|стр|рис|корп|кв|св)\.$/iu;
// Медицинское содержание — только по правилам «МЕДИЦИНСКИЕ ГРАНИЦЫ» (дословно
// из КБ в ответ на вопрос, с оговоркой «решает врач»), но не дописка к цене.
const MEDICAL_RE = /противопоказ|показани|беремен|лактац|осложн|побочн|нельзя/iu;
// Цена «определит врач / индивидуально / на консультации» — шаг уже задан
// маршрутом в консультацию, «подобрать время?» поверх него лишнее.
const INDIVIDUAL_PRICE_RE = /определит\s+врач|индивидуальн|на\s+консультаци/iu;

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

function sumsOf(text) {
  return (String(text || '').match(SUM_RE_G) || []).map(m => m.replace(/\D/g, ''));
}

function distinctSums(text) {
  return new Set(sumsOf(text)).size;
}

function isPriceList(text) {
  if (distinctSums(text) >= MULTI_PRICE_MIN) return true;
  const lines = String(text || '').split('\n').map(sumsOf).filter(a => a.length);
  return lines.length >= 2 && new Set(lines.flat()).size >= 2;
}

// Первое предложение справки — дословно, или null, если оно не годится:
// не законченное предложение (обрезано капом справки или на сокращении), со
// временем (засеяло бы «подтверждённое время»), со своей суммой (цена — только
// из каталога), медицинское, вопрос, слишком длинное/короткое.
function factSentence(text) {
  const firstLine = String(text || '').split('\n').map(l => l.trim()).find(Boolean);
  if (!firstLine) return null;
  // Вторая линия обороны поверх pickServiceFact: строки прайса и редакторские
  // пометки статьи («Цены в статье обновлены…») пациенту не дописываем ни при
  // какой форме справки; остаток markdown-выделения срезается.
  if (/^[*\-•#>]/u.test(firstLine) || MONEY_RE.test(firstLine) || META_RE.test(firstLine)) return null;
  const sentence = stripEmphasis(firstLine).split(SENTENCE_SPLIT_RE)[0].trim();
  if (sentence.length < MIN_FACT_SENTENCE || sentence.length > MAX_FACT_SENTENCE) return null;
  if (!/[.!…]$/.test(sentence) || ABBREV_END_RE.test(sentence)) return null;
  if (!/^[\p{Lu}\p{N}«"]/u.test(sentence)) return null;
  if (hasTime(sentence) || PRICE_SUM_RE.test(sentence) || sentence.includes('?')) return null;
  if (MEDICAL_RE.test(sentence)) return null;
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

// Пациент сам назвал день/дату/половину дня — «подобрать время?» звучит как
// неуслышанное; модель и так поведёт запись на названный день.
function patientNamedWhen(text, nowMs) {
  if (parseDayPart(text)) return true;
  return !!resolveDateInfo(text, { nowMs: Number.isFinite(nowMs) ? nowMs : Date.now() });
}

// Вставка факта в последнюю реплику. Вопроса в ней нет → в конец. Есть →
// ПЕРЕД первым вопросительным предложением (факт после «Записать вас?»
// читался бы как продолжение вопроса и оставлял бы его без ответа); вопрос
// первым же предложением — чистого места нет, факт не добавляем (null).
function insertFact(text, sentence) {
  const s = String(text).trimEnd();
  if (!s.includes('?')) return `${s} ${sentence}`;
  const starts = [0];
  const re = new RegExp(SENTENCE_SPLIT_RE.source, 'gu');
  let m;
  while ((m = re.exec(s))) starts.push(m.index + m[0].length);
  const ends = starts.slice(1).concat([s.length]);
  const qi = starts.findIndex((st, i) => s.slice(st, ends[i]).includes('?'));
  if (qi <= 0) return null;
  return `${s.slice(0, starts[qi]).trimEnd()} ${sentence} ${s.slice(starts[qi])}`;
}

/**
 * @param {string[]} replies — финальные реплики хода (серия отдельных сообщений)
 * @param {{patientLastText?:string, serviceFact?:{title:string,text:string}|null, nowMs?:number}} opts
 * @returns {{replies:string[], addedFact:boolean, addedStep:boolean, reason:string|null}}
 */
function applyPriceFollowthrough(replies, opts = {}) {
  const list = Array.isArray(replies) ? replies : [];
  const unchanged = reason => ({ replies: list, addedFact: false, addedStep: false, reason });
  if (!list.length || !String(list[list.length - 1] || '').trim()) return unchanged('no_reply');
  const patientText = String(opts.patientLastText || '');
  const sc = detectPromptScenarios(patientText);
  if (!sc.includes(SCENARIOS.PRICE) || !PRICE_QUESTION_RE.test(patientText)) return unchanged('not_price');
  // Пациент одновременно просит записать — Мила уже ведёт запись, «подобрать
  // время?» поверх неё лишнее.
  if (sc.includes(SCENARIOS.BOOKING) || sc.includes(SCENARIOS.MANAGE_BOOKING)) return unchanged('booking');
  const joined = list.join('\n');
  if (!PRICE_SUM_RE.test(joined)) return unchanged('no_sum');
  if (isPriceList(joined)) return unchanged('price_list');

  const out = list.slice();
  const last = out.length - 1;
  let addedFact = false;
  const fact = opts.serviceFact;
  if (fact && typeof fact.text === 'string') {
    const sentence = factSentence(fact.text);
    // Вопрос в ДРУГОЙ реплике серии (не последней) — факт в конце последней
    // встал бы после него; чистого места нет.
    const earlierQuestion = list.slice(0, last).some(t => String(t || '').includes('?'));
    if (sentence && !earlierQuestion && !factAlreadyConveyed(joined, sentence, { title: fact.title, patientText })) {
      const withFact = insertFact(out[last], sentence);
      if (withFact) { out[last] = withFact; addedFact = true; }
    }
  }
  // Шаг судим по ИСХОДНОЙ реплике: факт из справки может содержать «входит»/
  // «длится», и считать его шагом значило бы снова оставить цену без
  // предложения записаться.
  const addedStep = !NEXT_STEP_RE.test(joined) && !INDIVIDUAL_PRICE_RE.test(joined)
    && !patientNamedWhen(patientText, opts.nowMs);
  if (addedStep) out[last] = `${String(out[last]).trimEnd()} ${STEP_QUESTION}`;
  if (!addedFact && !addedStep) return unchanged('complete');
  return { replies: out, addedFact, addedStep, reason: null };
}

module.exports = {
  applyPriceFollowthrough, factSentence, factAlreadyConveyed, distinctSums, isPriceList, insertFact,
  STEP_QUESTION, MAX_FACT_SENTENCE, MULTI_PRICE_MIN,
};
