'use strict';

// ── Время, названное ПАЦИЕНТОМ, и его место в offer_slots. Чистый модуль. ────
//
// Инцидент 2026-09-16 (79774224184): пациентка попросила «Давайте на четверг на
// 21:30». get_available_slots вернул 21:30 в полном slots, но подобранный
// offer_slots (плотность, вызов без day_part) был [18:00, 13:00] — и модель
// ответила «окошко на 21:30 уже занято», перенеся запись на 18:00. Промпт-правило
// «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ» само оговаривает: время, названное пациентом,
// подтверждай, если оно есть в slots, — но соседнее «называй ТОЛЬКО из
// offer_slots» модель прочла как «остального нет». Промпт-only защита проиграна,
// поэтому решение принимает КОД (мораторий на новые промпт-правила): названное
// пациентом свободное время встаёт ПЕРВЫМ в offer_slots и подсвечивается хинтом.
//
// Сверяемся ТОЛЬКО с ПОСЛЕДНИМ сообщением пациента (patientLastText), а не со всем
// транскриптом: в окне лежат времена старых визитов («на 19:45» месяц назад), и
// продвигать их в offer_slots — значит подсказывать модели время, о котором
// пациент сейчас не просил. Время, которого НЕТ в slots, наружу НЕ отдаётся ни
// как «занятое», ни как-либо ещё: в том же сообщении может стоять время СТАРОЙ
// записи («перенести с 19:40 на 21:30»), и объявлять его занятым было бы ложью.

const { extractTimes } = require('./reply-guard');

// { slots, offer, patientText } → { offer, matched }
//   slots   — полная выдача инструмента ([{time, datetime, …}]);
//   offer   — подобранный offer_slots (объекты ИЗ slots);
//   matched — времена HH:MM из текста пациента, реально свободные (в порядке
//             упоминания). Пусто → offer возвращается как есть.
function promotePatientTime({ slots, offer, patientText } = {}) {
  const base = Array.isArray(offer) ? offer : [];
  const all = Array.isArray(slots) ? slots : [];
  if (!patientText || !all.length) return { offer: base, matched: [] };
  const byTime = new Map(all.map(s => [String(s && s.time), s]));
  const matched = [];
  for (const t of extractTimes(patientText)) {
    if (byTime.has(t) && !matched.includes(t)) matched.push(t);
  }
  if (!matched.length) return { offer: base, matched };
  const promoted = matched.map(t => byTime.get(t));
  const rest = base.filter(s => !matched.includes(String(s && s.time)));
  return { offer: promoted.concat(rest), matched };
}

function hintPatientTimeFree(times) {
  const list = (times || []).join(', ');
  return `Пациент сам назвал время ${list} — оно СВОБОДНО (есть в slots) и поставлено первым в ` +
    'offer_slots. Подтверждай именно его: НЕ называй его занятым и не предлагай вместо него другое время.';
}

// ── Половина дня из СЛОВ пациента ───────────────────────────────────────────
// Инцидент 2026-09-19 (79651442032), ход 3: пациентка просила утро, у мастера
// свободно с 10:00, а модель назвала 18:00/20:30 — offer_slots плотности без
// day_part. Границы те же, что у slot-density (morning <14:00, afternoon ≥14:00,
// evening ≥17:00). Возвращает null, когда сузить нечего или опасно:
//   • две разные половины в одном тексте («или утро или ближе к вечеру»);
//   • любое отрицание («утром не могу», «кроме утра», «нет, вечером») —
//     по нему нельзя понять, ЧТО пациент хочет, только чего не хочет;
//   • «доброе утро / добрый вечер» — приветствие, не пожелание.
const DAY_PART_RES = [
  ['morning', /(?<![\p{L}])(?:с\s+)?утр[ао]м?(?![\p{L}])/iu],
  ['evening', /(?<![\p{L}])вечер[а-яё]*(?![\p{L}])/iu],
  ['afternoon', /(?<![\p{L}])(?:дн[её]м|в\s+обед|после\s+обеда)(?![\p{L}])/iu],
];
const GREETING_DAY_RE = /(добр(?:ое|ый|ого)\s+(?:утро|утра|вечер|вечера|день|дня))/giu;
const NEGATION_RE = /(?<![\p{L}])(?:не|нет|кроме)(?![\p{L}])/iu;
// «или A или B» / «либо A либо B» — ДВЕ половины, соединённые явным разделительным
// союзом, это не противоречие, а корректное «подходит любая из двух» (инцидент
// 79651442032, реплей 19.09: «Или утро или ближе к вечеру»). Без союза — как
// раньше, две метки в тексте остаются неоднозначными и дают null.
// \b тут неприменим: он ASCII-only, а кириллица в \w не входит (та же ловушка,
// что у остальных регулярок файла) — границы через lookaround по \p{L}.
const DISJUNCTION_RE = /(?<![\p{L}])(?:или|либо)(?![\p{L}])/iu;

function parseDayPart(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.replace(GREETING_DAY_RE, ' ');
  if (NEGATION_RE.test(s)) return null;
  // Порядок — по месту первого совпадения В ТЕКСТЕ, а не по порядку DAY_PART_RES:
  // «вечером или утром» должно вернуть ['evening','morning'], как назвал пациент,
  // а не порядок объявления регулярок.
  const found = DAY_PART_RES
    .map(([part, re]) => ({ part, idx: s.search(re) }))
    .filter((m) => m.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((m) => m.part);
  if (found.length === 1) return found[0];
  if (found.length === 2 && DISJUNCTION_RE.test(s)) return found;
  return null;
}

// Текущее сообщение пациента могло не дать сигнала (отрицание без своей метки,
// «Нет», просто отказ) — а половина дня уже звучала парой сообщений раньше
// («Или утро или ближе к вечеру» → следом «Днем не могу», инцидент 79651442032,
// ход 6). Досматриваем недавние сообщения ПАЦИЕНТА, от новых к старым.
//
// texts — тексты сообщений роли user в хронологическом порядке (текущее —
// последним). Реплики бота сюда класть нельзя: вызывающий код (оркестратор)
// отвечает за то, что в массиве только пациент, — иначе «на вечер тоже всё
// расписано» из собственного ответа Милы подтверждало бы само себя.
const DAY_PART_LOOKBACK = 4; // текущее сообщение + до 3 предыдущих сообщений пациента

function parseDayPartFromRecent(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const from = Math.max(0, list.length - DAY_PART_LOOKBACK);
  for (let i = list.length - 1; i >= from; i--) {
    const r = parseDayPart(list[i]);
    if (r) return r;
  }
  return null;
}

module.exports = {
  promotePatientTime, hintPatientTimeFree, parseDayPart, parseDayPartFromRecent, DAY_PART_LOOKBACK,
};
