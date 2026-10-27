'use strict';
// ============================================================
// Медицинский вопрос пациента — сначала база знаний (спека
// docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md).
// ЧИСТЫЙ модуль: ни БД, ни сети. Поход в RAG и заголовки статей делает
// оркестратор. Тесты: agent-medical-kb.test.js.
//
// ЗАЧЕМ: живой прогон 13.10.2026 — на «есть ли смысл делать био, если после
// второй процедуры прошло больше месяца?» модель 3/3 не вызвала КБ, хотя в
// статье #16 прямой ответ («курс 3–5 процедур с интервалом 2–4 недели»).
// Правило «отвечай только по search_knowledge_base» уже было и не держалось,
// новые правила под мораторием — поэтому базу ищет код.
//
// ГРАНИЦЫ СЛОВ — lookaround по \p{L}, а не \b: тот в JS ASCII-only, и именно
// так «боль» ловилась внутри «больше» (prompt-scenarios, вне рамок задачи).
// Текст нормализуется: нижний регистр, ё→е — регулярки ниже пишутся без «ё».
// ============================================================
const { stripAllStamps } = require('./transcript-time');
const { detectPromptScenarios, SCENARIOS, isPriceQuestion } = require('./prompt-scenarios');
const serviceFact = require('./service-fact');
const { PRICE_SUM_RE } = require('./reply-guard');

function norm(text) {
  return stripAllStamps(String(text)).toLowerCase().replace(/ё/g, 'е');
}

// ── Опасные признаки (черновик; список УТВЕРЖДАЕТ ВРАЧ клиники) ──────────────
// Ложное срабатывание = лишний перевод на администратора, это безопасная
// сторона. Пропуск — главный риск решения владельца №3, отсюда два яруса.
// «Синяк» и «потемнело» сюда НЕ входят: потемнение пигмента после Lumecca —
// норма по статье #5.
const BLANCH_RE = /(?<![\p{L}])(?:побел|побледн|посин|мраморн)/u;
// Клауза про синяк/гематому/пигмент — не о коже: «синяк побледнел» — заживает.
// «Пятно» из исключения убрано намеренно: белое пятно у места укола — признак
// окклюзии сосуда, а «потемнели пятна» после Lumecca сюда не попадают и так
// (потемнение — не побеление). Клаузы режутся и по « и »: «губа побелела и
// синяк» — два наблюдения, синяк не должен глушить побеление.
const BLANCH_EXCLUDE_RE = /синяк|гематом|пигмент/u;
const CLAUSE_SPLIT_RE = /[.,;!?\n]|\s+и\s+/u;
// Отёк горла/языка/гортани — в любом порядке и через пару слов: пациент пишет
// «опухли губы и горло», а не «отекло горло».
const SWELL = '(?:отек|отеч|опух|распух)[\\p{L}]*';
const THROAT = '(?:горл|язык|гортан)[\\p{L}]*';
const GAP = '(?:[\\s,]+[\\p{L}]+){0,3}[\\s,]+';
const BREATHING_RE = new RegExp(
  `(?:трудно|тяжело|сложно|не\\s+могу)\\s+дыш|(?<![\\p{L}])дыш[\\p{L}]*\\s+(?:[\\p{L}]+\\s+)?(?:трудно|тяжело|сложно)`
  + `|(?<![\\p{L}])задыха`
  + `|(?<![\\p{L}])${SWELL}${GAP}${THROAT}|(?<![\\p{L}])${THROAT}${GAP}${SWELL}`, 'u');
// Зрение: «вижу/видеть» — только в связке с плохо/хуже/не, иначе «не видела
// ваше сообщение» уводило бы к администратору. «Не вижу» — только с глазом,
// «ничего» или в конце фразы: «не вижу свободного времени» — не о зрении.
// «Потемнело в глазах» — зрение; «потемнели пятна» (Lumecca) — кожа, норма.
const VISION_RE = /(?<![\p{L}])зрени[\p{L}]*\s+(?:[\p{L}]+\s+){0,2}(?:ухудш|упал|пропал|двоит|размыт|помутн|хуже|плох|село|сел(?![\p{L}]))|(?:ухудшил|упал|пропал|помутнел|размыт|мутн|плох)[\p{L}]*\s+зрени|двоит[\p{L}]*\s+в\s+глаз|в\s+глазах\s+(?:двоит|темне|потемн)|(?<![\p{L}])(?:потемн|темне)[\p{L}]*\s+в\s+глаз|(?<![\p{L}])пелен|(?<![\p{L}])(?:плохо|хуже)\s+(?:стал[\p{L}]*\s+)?(?:вижу|видет)|(?<![\p{L}])видет[\p{L}]*\s+(?:стал[\p{L}]*\s+)?(?:хуже|плохо)|(?<![\p{L}])не\s+вижу\s+(?:(?:[\p{L}]+\s+)?глаз|ничего)|(?<![\p{L}])не\s+вижу\s*(?:[.!?,;]|$)/u;
const ALWAYS_FLAGS = [
  ['breathing', BREATHING_RE],
  ['vision', VISION_RE],
];
// Контекст процедуры: без него «температура 38, можно ли на чистку?» и «гной
// на подбородке» — вопросы о процедуре, а не осложнения. Второй путь —
// название процедуры ВМЕСТЕ с отметкой давности («вчера был ботокс, сегодня
// 39»): одно название без отметки — вопрос о будущей процедуре.
const PROCEDURE_CONTEXT_RE = /(?<![\p{L}])(?:после|сделал[\p{L}]*|делал[\p{L}]*|поставил[\p{L}]*|укол[\p{L}]*|вкол[\p{L}]*|колол[\p{L}]*)(?![\p{L}])/u;
const PROCEDURE_WORD_RE = /(?<![\p{L}])(?:ботокс|филлер|биорев|био(?![\p{L}])|губ|чистк|пилинг|мезо|лазер|эпиляц|люмекк|lumecca|морфеус|morpheus|плазм)/u;
const RECENCY_RE = /(?<![\p{L}])(?:вчера|сегодня|позавчера|был|была|было|делал[\p{L}]*)(?![\p{L}])/u;
function hasProcedureContext(s) {
  return PROCEDURE_CONTEXT_RE.test(s) || (PROCEDURE_WORD_RE.test(s) && RECENCY_RE.test(s));
}
// Число без «температура» — жар, только если оно дробное (38.5) или стоит
// после «у меня/сейчас» без единицы следом: «38 минут ждать?» — не жар.
const FEVER_NUM = '(?:3[89]|40)';
const FEVER_RE = new RegExp(
  '(?:поднял|подскочил)[\\p{L}]*\\s+температур'
  + `|температур[\\p{L}]*\\s+(?:поднял[\\p{L}]*|подскочил[\\p{L}]*|(?:(?:под|уже|до|около|почти|за|выше)\\s+)?${FEVER_NUM}(?!\\d))`
  + `|(?<![\\p{L}])т\\.?\\s*${FEVER_NUM}(?![\\d\\p{L}])`
  + `|(?<![\\d.,])${FEVER_NUM}[.,]\\d(?!\\d)`
  + `|(?<![\\p{L}])(?:у\\s+меня|сейчас)\\s+(?:(?:уже|под|почти)\\s+)?${FEVER_NUM}(?=\\s*(?:$|[.,;!?)]|°|градус|и(?![\\p{L}])|после(?![\\p{L}])))`
  + `|(?<!\\d)${FEVER_NUM}(?:[.,]\\d)?\\s*(?:°|градус)`
  + '|(?<![\\p{L}])температурю|(?<![\\p{L}])озноб|(?<![\\p{L}])жар(?![\\p{L}])', 'u');
const CONTEXT_FLAGS = [
  // Жар, а не «высокие температуры» бани: число 38–40, подъём, озноб.
  ['fever', FEVER_RE],
  ['pus', /(?<![\p{L}])(?:гно[йеияю]|гноит|гнойн|нагно)/u],
  ['severe_pain', /(?<![\p{L}])(?:резк|нарастающ|нестерпим|невыносим)[\p{L}]*\s+бол|(?<![\p{L}])бол[\p{L}]*\s+(?:нараста|усилива|невыносим|нестерпим)/u],
];

/** @returns {{kind:string}|null} */
function detectRedFlag(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = norm(text);
  const blanch = s.split(CLAUSE_SPLIT_RE).some(c => BLANCH_RE.test(c) && !BLANCH_EXCLUDE_RE.test(c));
  if (blanch) return { kind: 'skin_blanching' };
  for (const [kind, re] of ALWAYS_FLAGS) if (re.test(s)) return { kind };
  if (!hasProcedureContext(s)) return null;
  for (const [kind, re] of CONTEXT_FLAGS) if (re.test(s)) return { kind };
  return null;
}

// Текст перевода (черновик, утверждает клиника). ОБЯЗАН содержать
// «администратор» (admin-hours.HANDOVER_ANNOUNCED_RE) — иначе диспетчер дошлёт
// вторую фразу перевода. Мила на проде работает ночью, поэтому нерабочий
// вариант — основной.
function buildRedFlagReply(opts = {}) {
  const head = 'Мне очень жаль, что Вы с этим столкнулись.';
  return opts.adminOff
    ? `${head} Передаю Ваше сообщение администратору. Сейчас нерабочее время, он увидит его с утра. Если становится хуже, не ждите: звоните 103 или 112.`
    : `${head} Срочно передаю Ваше сообщение администратору, чтобы с Вами как можно скорее связался врач.`;
}

// ── Нужна ли база: сильные маркеры — всегда, слабые — кроме записи/цены ─────
// Слабые («можно ли», «курс», «как проходит») в сообщении о записи/переносе —
// про время, а на вопросе о цене работает справка об услуге (service-fact).
const STRONG_RE = /(?<![\p{L}])(?:противопоказ|показан|беремен|лактац|кормлю\s+грудью|грудн[\p{L}]*\s+вскармлив|гв(?![\p{L}])|диабет|аллерг|герпес|антибиотик|лекарств|таблетк|отек|опух|покрасн|синяк|гематом|болит|боль(?![\p{L}])|сып[ьи](?![\p{L}])|высып|зуд|жжет|шелуш|бугор|шишк|комоч|асимметр|онемел|реабилит|уход\s+после)/u;
const WEAK_RE = /(?<![\p{L}])(?:можно\s+ли|стоит\s+ли|есть\s+ли\s+(?:вообще\s+)?смысл|курс|интервал|перерыв|сколько\s+(?:нужно\s+)?(?:процедур|сеанс)|как\s+часто|подготов|после\s+процедур|загар|загора|бан[яюи](?![\p{L}])|саун|спорт|алкогол|как\s+проходит|сколько\s+длится|эффект|результат|сколько\s+держит|больно)/u;

function wantsMedicalKb(text) {
  if (typeof text !== 'string') return false;
  const s = norm(text);
  if (!s.trim()) return false;
  if (STRONG_RE.test(s)) return true;
  if (!WEAK_RE.test(s)) return false;
  const sc = detectPromptScenarios(s);
  if (sc.includes(SCENARIOS.BOOKING) || sc.includes(SCENARIOS.MANAGE_BOOKING)) return false;
  return !isPriceQuestion(s);
}


// ── К каким статьям относится вопрос ─────────────────────────────────────────
// Стемы и бытовые названия — ОБЩИЕ со справкой об услуге (service-fact.stems);
// поверх — медицинские стоп-префиксы: «терапия» в вопросе иначе притянула бы
// все «…терапии» из заголовков, «уход после» — статью-биографию косметолога
// («опыт, уход за кожей…»), «консультация» — «Консультации и диагностика».
const MEDICAL_STOP_PREFIXES = [
  'терап', 'лечен', 'после', 'перед', 'курс', 'интерв', 'эффект', 'резуль', 'врач',
  'уход', 'опыт', 'консул', 'диагн', 'делат', 'сделал', 'прошл', 'больш', 'месяц',
  'недел', 'смысл', 'вообщ', 'втор', 'есть',
];
// Трёхбуквенный стем («без», «или») совпадает с чем попало внутри заголовка;
// «губ» — единственный короткий законный (алиас «губы»/«губ»).
const SHORT_STEMS_OK = new Set(['губ']);

// «Фото» целым словом — «вот фото, опухло» — притягивало «…фотоомоложение»
// (LUMECCA). Префиксный стоп убил бы и само «фотоомоложение», поэтому
// вырезаем только целые слова «фото/фотка/фотография».
const PHOTO_WORD_RE = /(?<![\p{L}])(?:фото|фотк[\p{L}]*|фотограф[\p{L}]*)(?![\p{L}])/giu;

function matchTitles(text, titles) {
  if (typeof text !== 'string' || !Array.isArray(titles) || !titles.length) return [];
  const st = serviceFact.stems(text.replace(PHOTO_WORD_RE, ' '), MEDICAL_STOP_PREFIXES)
    .filter(s => s.length >= 4 || SHORT_STEMS_OK.has(s));
  if (!st.length) return [];
  return titles.filter(t => typeof t === 'string' && t.trim()
    && st.some(s => serviceFact.norm(t).includes(s)));
}

const MAX_COMBINED_QUERY = 300;

/**
 * @param {string[]} userBlocks тексты пациента от ПОСЛЕДНЕГО к ранним (метки
 *   времени срезаются здесь же — serviceFact.kbQuery)
 * @param {string[]} titles заголовки опубликованных статей салона
 * @returns {{query:string, titles:string[]}|null}
 */
function buildMedicalQuery(userBlocks, titles) {
  const blocks = (Array.isArray(userBlocks) ? userBlocks : []).slice(0, 3)
    .map(b => serviceFact.kbQuery(b)).filter(Boolean);
  if (!blocks.length) return null;
  const last = blocks[0];
  // Запрос из одного сообщения — РОВНО kbQuery, как у справки об услуге:
  // совпавший запрос оркестратор берёт из уже сделанного поиска.
  const own = matchTitles(last, titles);
  if (own.length) return { query: last, titles: own };
  for (const prev of blocks.slice(1)) {
    const t = matchTitles(prev, titles);
    if (!t.length) continue;
    const room = Math.max(0, MAX_COMBINED_QUERY - last.length - 1);
    return { query: `${prev.slice(0, room)} ${last}`.trim().slice(-MAX_COMBINED_QUERY), titles: t };
  }
  return null;
}

// ── Отбор фрагментов выдачи search_knowledge_base ────────────────────────────
// Режем kb.context по kb.fragments (границы чанков, agent-rag) и оставляем
// фрагменты статей из titles. Хвост «АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ» в fragments не
// входит по построению. Строки с суммами — вон (цены только из каталога),
// со временем ЧЧ:ММ — вон (блок стоит после «ТЕКУЩИЙ КОНТЕКСТ:» и засевал бы
// allowedTimes reply-guard). Каждому фрагменту — строка-метка «Заголовок»:
// в блоке бывает несколько статей.
const MAX_MEDICAL_CHARS = 6000;
const MAX_LINE_CHARS = 400;   // тот же кап, что у sanitizeLine в промпте

function isValidFragment(f, len) {
  return f && Number.isInteger(f.start) && Number.isInteger(f.end)
    && f.start >= 0 && f.end > f.start && f.end <= len;
}

/** @returns {{titles:string[], lines:string[], raw:string}|null} */
function pickMedicalFragments(kb, titles) {
  if (!kb || typeof kb.context !== 'string' || !Array.isArray(kb.fragments)) return null;
  const want = new Set((Array.isArray(titles) ? titles : []).map(t => String(t).trim()).filter(Boolean));
  if (!want.size) return null;
  const lines = [];
  const used = [];
  let size = 0;
  for (const f of kb.fragments) {
    if (!isValidFragment(f, kb.context.length)) continue;
    const rows = kb.context.slice(f.start, f.end).split('\n').map(l => l.trim());
    const ti = rows.findIndex(Boolean);
    if (ti < 0 || !want.has(rows[ti])) continue;
    const title = rows[ti];
    const body = rows.slice(ti + 1)
      .filter(l => l && l !== '---' && l.replace(/^#+\s*/, '') !== title)
      .filter(l => !serviceFact.hasTime(l) && !PRICE_SUM_RE.test(l) && !serviceFact.MONEY_RE.test(l))
      .map(l => serviceFact.stripEmphasis(l).slice(0, MAX_LINE_CHARS)).filter(Boolean);
    // Метка фрагмента + столько строк, сколько влезает в общий кап. Ни одна
    // строка не влезла — фрагмент не берём вовсе (висячая метка без текста
    // читалась бы как «статья пустая»), и дальше смотреть незачем.
    const label = `«${title}»:`;
    let room = MAX_MEDICAL_CHARS - size - (label.length + 1);
    const take = [];
    for (const l of body) {
      if (l.length + 1 > room) break;
      take.push(l);
      room -= l.length + 1;
    }
    if (!take.length) { if (body.length) break; continue; }
    lines.push(label, ...take);
    size = MAX_MEDICAL_CHARS - room;
    if (!used.includes(title)) used.push(title);
    if (take.length < body.length) break;
  }
  if (!used.length) return null;
  return { titles: used, lines, raw: kb.context };
}

module.exports = {
  detectRedFlag, buildRedFlagReply, wantsMedicalKb,
  matchTitles, buildMedicalQuery, MEDICAL_STOP_PREFIXES,
  pickMedicalFragments, MAX_MEDICAL_CHARS,
};
