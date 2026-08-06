'use strict';

// ── Линт финальной реплики агента. Чистые функции — без БД/HTTP. ────────────
// Детерминированная страховка промпт-правил, которые модель периодически
// нарушает: время не из slots (инцидент 2026-07-28), слова-табу и внутренние
// id (правило 9), повторное приветствие, перебор эмодзи. Оркестратор по
// жёстким нарушениям делает ОДИН корректирующий довызов, остальное — лог.

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;

// ISO datetime (book_chain.records[].datetime и т.п.): «2026-07-30T10:30:00+03:00».
// \b не срабатывает после «T» (буква и цифра — оба \w в JS-regex), поэтому общий
// TIME_RE эту форму не ловит вовсе, а часовой пояс (+03:00/-05:30/Z) не должен
// попадать в извлечённые времена. Матчим ISO-датавремя целиком (включая offset)
// одним куском и вырезаем его из текста ДО прогона общего TIME_RE — это разом
// достаёт время из T-части и не даёт офсету всплыть отдельно.
const ISO_DATETIME_RE =
  /\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Внутренняя кухня (правило 9 промпта). «система» намеренно не в списке —
// слишком много ложных срабатываний («систематический уход»).
// \w в JS — только ASCII, кириллицу не ловит, поэтому суффиксы через [а-яё]*.
const TABOO_RE = /(каталог[а-яё]*|прайс[а-яё]*|баз[а-яё]*\s+знаний|нет\s+статьи|системн[а-яё]+\s+промпт[а-яё]*|промпт[а-яё]*)/gi;

// 6+ цифр подряд = похоже на yc_id/record_id. Телефоны (+7…/8… на 11 цифр),
// цены с разделителем-пробелом и цены с маркером валюты (₽/руб) под это не
// попадают — fmtPrice рендерит цену ≥100000 без разделителей тысяч, и
// переписывание такой реплики стирало бы верную цену.
const ID_LEAK_RE = /(?<![\d+])\d{6,}\b(?!\s?(?:₽|руб))/g;
const PHONE_RE = /(?:\+7|\b[78])\d{10}\b/g;

const GREETING_RE = /(здравствуйте|добрый\s+(день|вечер|утро)|доброе\s+утро)/i;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Нормализованные HH:MM из текста (14.30 → 14:30, 9:30 → 09:30).
//
// Точечная форма (HH.MM) неоднозначна с датой DD.MM («12.07» — 12 июля, а не
// 12:07). Правило: точечный матч отбрасывается, только если его «минутная»
// часть сама по себе — правдоподобный месяц (01–12); двоеточие всегда
// однозначно и не проверяется. Компромисс: время вида «10:07»/«10.07» через
// точку (минуты=07 ≤ 12) будет ошибочно принято за дату и потеряно — в чате
// клиники такие времена почти всегда пишут через двоеточие, поэтому эта
// потеря реже ложного зачёта даты как времени.
function extractTimes(text) {
  const s = String(text || '');
  const out = [];
  let rest = '';
  let cursor = 0;
  for (const m of s.matchAll(ISO_DATETIME_RE)) {
    out.push(`${m[1]}:${m[2]}`);
    rest += s.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  rest += s.slice(cursor);

  for (const m of rest.matchAll(TIME_RE)) {
    const isDotForm = m[0].includes('.');
    const minutes = Number(m[2]);
    if (isDotForm && minutes >= 1 && minutes <= 12) continue; // похоже на DD.MM дату
    out.push(`${m[1].padStart(2, '0')}:${m[2]}`);
  }
  return out;
}

// Времена реплики должны входить в allowed (Set строк HH:MM). Пустой allowed —
// проверка выключена: за ход время нигде не всплывало, сверять не с чем.
function checkOfferedTimes(text, allowed) {
  if (!allowed || !allowed.size) return [];
  const out = [];
  for (const t of extractTimes(text)) {
    if (!allowed.has(t)) out.push({ type: 'unknown_time', value: t });
  }
  return out;
}

function lintReply(text, opts = {}) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(TABOO_RE)) out.push({ type: 'taboo_word', value: m[1].toLowerCase() });
  const noPhones = s.replace(PHONE_RE, '');
  for (const m of noPhones.matchAll(ID_LEAK_RE)) out.push({ type: 'id_leak', value: m[0] });
  if (opts.hasPriorAssistant) {
    const gr = s.match(GREETING_RE);
    if (gr) out.push({ type: 'repeat_greeting', value: gr[1][0].toUpperCase() + gr[1].slice(1) });
  }
  // Обратная сторона repeat_greeting: ПРОПУЩЕННОЕ приветствие. Инцидент
  // 2026-08-06 (79165370505) — первое в истории обращение, а Мила начала с
  // «Да, на 12 августа в 16:00 есть свободное время…». firstContact ставит
  // оркестратор ровно там, где промпт приветствие ПРЕДПИСАЛ (блок ПЕРВОЕ
  // ОБРАЩЕНИЕ), поэтому расхождение здесь — всегда нарушение правила, а не
  // спорная стилистика. Переписывание не просим (не HARD_TYPES): довызов стоит
  // денег и рискует сломать уже корректный по сути ответ — как с unknown_time,
  // сначала меряем шум по логам.
  if (opts.firstContact && !GREETING_RE.test(s)) {
    out.push({ type: 'missing_greeting', value: '' });
  }
  const emoji = s.match(EMOJI_RE);
  if (emoji && emoji.length > 1) out.push({ type: 'emoji_excess', value: String(emoji.length) });
  return out;
}

// Плотная запись (§8 docs/superpowers/specs/2026-08-06-agent-slot-density-design.md):
// «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ» требует называть время из короткого offer_slots
// (1-2 подобранных значения), а не из полного slots/available_slots той же выдачи.
// ЗАЧЕМ ЛОГ, А НЕ GUARD: отличить нарушение от честного «пациент попросил другое
// время» можно, только зная, называл ли пациент время сам, — а это ровно тот
// класс, на котором анти-ложь-guard 04.08 (falseSuccess, agent-false-success.js)
// глушил правдивые ответы о записи. Спека прямо запрещает повторять ту ошибку:
// offer_slots и так короткий — цитировать оттуда физически нечего, кроме
// подобранного, — поэтому переписывания НЕТ, только измерение (как missing_greeting).
//
// opts:
//   toolTimes    — времена, реально встретившиеся в выдаче слот-инструментов
//                  этого хода (offer_slots и/или полный slots/available_slots
//                  ТОЙ ЖЕ выдачи — неважно, из какой именно части);
//   offerTimes   — подмножество toolTimes, вошедшее в подобранный offer_slots;
//   patientTimes — времена, которые пациент назвал сам (его сообщения в
//                  транскрипте) — правило промпта прямо разрешает подтверждать
//                  названное пациентом время, и это не нарушение.
//
// Пустой offerTimes = за ход offer_slots нигде не встретился (поля не было или
// оно везде пусто) → проверка выключена целиком: мерить нечего, а шум обесценит
// лог. Время не из toolTimes — не дело этой проверки: его уже ловит unknown_time
// (checkOfferedTimes выше), дублировать нарушение нельзя.
function checkOfferDeviation(text, opts = {}) {
  const offerTimes = opts.offerTimes;
  if (!offerTimes || !offerTimes.size) return [];
  const toolTimes = opts.toolTimes || new Set();
  const patientTimes = opts.patientTimes || new Set();
  const out = [];
  for (const t of extractTimes(text)) {
    if (!toolTimes.has(t)) continue;     // не из выдачи инструментов вовсе — забота unknown_time
    if (offerTimes.has(t)) continue;     // время из offer_slots — легально
    if (patientTimes.has(t)) continue;   // пациент назвал это время сам — легально
    out.push({ type: 'offer_bypass', value: t });
  }
  return out;
}

// Жёсткие нарушения — раскрытие внутренней кухни. По ним оркестратор просит
// модель переписать ответ; стилистика (эмодзи, приветствие, offer_bypass) — только лог.
const HARD_TYPES = new Set(['taboo_word', 'id_leak']);
function hardViolations(violations) {
  return (violations || []).filter(v => HARD_TYPES.has(v.type));
}

module.exports = { extractTimes, checkOfferedTimes, checkOfferDeviation, lintReply, hardViolations };
