'use strict';

// ── Предложенное время сверяется по паре «ДАТА + МАСТЕР», а не по HH:MM ─────
//
// ЗАЧЕМ. Третий живой прогон репродукции 2026-09-19: «Либо к вашему мастеру
// Татьяне на среду, 23 сентября. У неё есть свободное время, например, в 10:00»
// — 10:00 было у ЮЛИИ на ПОНЕДЕЛЬНИК (журнал), а у Татьяны в среду старты
// начинались с 13:30. allowedTimes/verifiedTimes оркестратора — плоские
// множества HH:MM без даты и мастера, поэтому чужое 10:00 делало реплику
// законной ПО ПОСТРОЕНИЮ (тот же класс, что alien_time_attribution 10.08, но
// теперь по дате). Гейт slot-evidence остановил бы такой ПЕРЕНОС при попытке
// записи, но пациент уже услышал «свободно».
//
// КАК. Реплика режется на клаузы (как checkUnverifiedOffer); по ним ПОСЛЕДОВАТЕЛЬНО
// ведётся контекст «о какой дате и о каком мастере речь»: явная дата
// («23 сентября», «23.09», «завтра», день недели) и имя мастера из evidence
// обновляют контекст и ПЕРЕНОСЯТСЯ на следующие клаузы — список времён под
// строкой «В среду у Татьяны есть:» иначе остался бы без даты. Каждое время
// клаузы-предложения сверяется с evidence (slotsOn(дата)) по мастеру, если он
// известен. Нет ни даты, ни мастера → проверка молчит (её ведёт плоский
// unverified_offer). Не предложения — клаузы о занятости, часы работы,
// существующая запись пациента, «перенести С 17:30» (старое время) и времена,
// названные самим пациентом.
//
// Значение нарушения несёт РЕАЛЬНЫЕ времена этой даты у этого мастера из
// evidence: довызов без инструментов иначе снова сочинял бы (живой прогон).
// Чистый модуль: без БД/HTTP, «сейчас» приходит параметром.

const { extractTimes, mentionsPerson, UNAVAILABLE_RE, BOOKED_UP_RE } = require('./reply-guard');
const { moscowDateKey } = require('./slot-evidence');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAY_MONTH_RE = /(?<![\d.:])(\d{1,2})\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-яё]*/iu;
const DD_MM_RE = /(?<![\d.:])(\d{1,2})\.(\d{2})(?![\d.:])/u;
// Дни недели: стемы + допустимое окончание; «сред[аеу]» — только целым словом
// (иначе «средство», «среди»).
const WEEKDAYS = [
  [1, /(?<![\p{L}])понедельник\p{L}*/iu],
  [2, /(?<![\p{L}])вторник\p{L}*/iu],
  [3, /(?<![\p{L}])сред[аеу](?![\p{L}])/iu],
  [4, /(?<![\p{L}])четверг\p{L}*/iu],
  [5, /(?<![\p{L}])пятниц\p{L}*/iu],
  [6, /(?<![\p{L}])суббот\p{L}*/iu],
  [0, /(?<![\p{L}])воскресень\p{L}*/iu],
];
const RELATIVE = [
  ['послезавтра', 2], ['завтра', 1], ['сегодня', 0],
];

function keyToUtcNoon(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12);
}
function utcNoonToKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Дата, о которой говорит фрагмент текста, ключом YYYY-MM-DD (московский
 * календарь). Приоритет: «DD месяца» → «DD.MM» → сегодня/завтра → день недели.
 * @returns {string|null}
 */
function resolveDate(text, opts = {}) {
  const r = resolveDateInfo(text, opts);
  return r ? r.key : null;
}

/**
 * То же, что resolveDate, плюс ВИД ссылки: 'explicit' («6 октября», «06.10»),
 * 'relative' (сегодня/завтра), 'weekday' (только день недели). Вид нужен
 * checkOfferAttribution: «6 октября, во вторник» режется по запятой на два
 * фрагмента, и день недели во втором НЕ должен перезаписывать явную дату из
 * первого (живой прогон 2026-09-22: ближайший вторник оказался СЕГОДНЯ, и честное
 * «6 октября … 13:30» гасилось как «22.09 13:30»).
 * @returns {{key:string, kind:'explicit'|'relative'|'weekday'}|null}
 */
function resolveDateInfo(text, opts = {}) {
  const s = String(text || '');
  const nowMs = opts.nowMs;
  if (!Number.isFinite(nowMs) || !s.trim()) return null;
  const todayKey = moscowDateKey(nowMs);
  const today = keyToUtcNoon(todayKey);
  const year = Number(todayKey.slice(0, 4));

  const withYear = (month, day) => {
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    let ms = Date.UTC(year, month - 1, day, 12);
    // Дата более чем на 60 дней в прошлом — речь о следующем годе (январь в декабре).
    if (ms < today - 60 * DAY_MS) ms = Date.UTC(year + 1, month - 1, day, 12);
    return utcNoonToKey(ms);
  };

  const dm = s.match(DAY_MONTH_RE);
  if (dm) {
    const stem = dm[2].toLowerCase().slice(0, 2) === 'ма' ? 'ма' : dm[2].toLowerCase().slice(0, 3);
    const idx = MONTHS.indexOf(stem);
    const r = idx >= 0 ? withYear(idx + 1, Number(dm[1])) : null;
    if (r) return { key: r, kind: 'explicit' };
  }
  const ddmm = s.match(DD_MM_RE);
  if (ddmm) {
    const r = withYear(Number(ddmm[2]), Number(ddmm[1]));
    if (r) return { key: r, kind: 'explicit' };
  }
  const low = s.toLowerCase();
  for (const [word, delta] of RELATIVE) {
    if (low.includes(word)) return { key: utcNoonToKey(today + delta * DAY_MS), kind: 'relative' };
  }
  const todayWd = new Date(today).getUTCDay();
  for (const [wd, re] of WEEKDAYS) {
    if (re.test(s)) {
      const delta = (wd - todayWd + 7) % 7;
      return { key: utcNoonToKey(today + delta * DAY_MS), kind: 'weekday', weekday: wd };
    }
  }
  return null;
}

// День недели ключа YYYY-MM-DD (0 — воскресенье, как getUTCDay у полудня UTC).
function weekdayOf(key) { return new Date(keyToUtcNoon(key)).getUTCDay(); }

// Клаузы, где время — НЕ предложение свободного окна.
const BOOKING_STATE_RE = /(?<![\p{L}])(?:вы\s+(?:уже\s+)?записан|ваш[а-яё]*\s+запис|запись\s+(?:на|в)\s)/iu;
const CLINIC_HOURS_RE = /(?<![\p{L}])с\s+\d{1,2}[:.]\d{2}\s+до\s+\d{1,2}[:.]\d{2}|(?<![\p{L}])работа[а-яё]*/iu;
// «перенести С 17:30» — старое время, не предложение.
const FROM_TIME_RE = /(?<![\p{L}])с\s+\d{1,2}[:.]\d{2}/giu;
// Утверждение о НАЛИЧИИ свободных окон словами (без цифр). Уже, чем
// AVAILABILITY_OFFER_RE reply-guard'а: «могу предложить посмотреть четверг» —
// не утверждение о наличии, а «есть свободные окна в четверг» — утверждение.
const AVAILABILITY_CLAIM_RE = /(?<![\p{L}])(?:есть|имеются|найдутся|остались)\s+(?:свободн[а-яё]*\s+)?(?:окошк|окн|врем)[а-яё]*|свободн[а-яё]*\s+(?:окошк|окн|врем)[а-яё]*/iu;

function fmtDdMm(key) { return `${key.slice(8, 10)}.${key.slice(5, 7)}`; }

function sameName(a, b) {
  return mentionsPerson(a, b) || mentionsPerson(b, a);
}

// Кто из мастеров evidence упомянут в клаузе — берём упомянутого ПОСЛЕДНИМ
// («у Татьяны нет, но у Юлии 10:00» — время про Юлию). Стем — минимум 3 буквы:
// у 4-буквенного имени «Юлия» стем в 4 буквы не покрывал бы «Юлии»/«Юлию»
// (ровно на этом честная реплика «к Юлии в понедельник» гасилась).
function lastMentioned(clause, names) {
  let best = null;
  let bestIdx = -1;
  for (const name of names) {
    for (const w of name.split(/\s+/).filter(x => x.length >= 4 && /^\p{Lu}/u.test(x))) {
      const stem = w.slice(0, Math.max(3, w.length - 2));
      const re = new RegExp(`(?<!\\p{L})${stem}\\p{L}{0,3}(?!\\p{L})`, 'gu');
      let m;
      while ((m = re.exec(clause))) {
        if (m.index > bestIdx) { bestIdx = m.index; best = name; }
      }
    }
  }
  return best;
}

/**
 * @param {string} text реплика
 * @param {{evidence: object, nowMs: number, patientTimes?: Set<string>}} opts
 * @returns {Array<{type:'unverified_offer_date', value:string}>}
 */
function checkOfferAttribution(text, opts = {}) {
  const ev = opts.evidence;
  const nowMs = opts.nowMs;
  if (!ev || typeof ev.slotsOn !== 'function' || typeof ev.dateKeys !== 'function' || !Number.isFinite(nowMs)) return [];
  const patientTimes = opts.patientTimes || new Set();
  const dateKeys = ev.dateKeys();
  const allRows = dateKeys.flatMap(k => ev.slotsOn(k).map(r => ({ ...r, date: k })));
  // Пустая evidence — сверять не с чем: там работает плоский unverified_offer.
  // Наш предмет — время, взятое из ДРУГОЙ даты или у ДРУГОГО мастера.
  if (!allRows.length) return [];
  const names = [...new Set(allRows.map(r => r.name).filter(Boolean))];

  const out = [];
  const seen = new Set();
  const ctx = { date: null, staff: null, dateKind: null };
  // Два уровня. ПРЕДЛОЖЕНИЕ решает, предложение ли это вообще (занятость,
  // часы работы, существующая запись — пропуск целиком: «Вы записаны на
  // воскресенье, 20 сентября, в 17:30» после запятых потерял бы признак).
  // ФРАГМЕНТЫ внутри него (запятая, «либо/или») ведут контекст даты/мастера:
  // одна фраза часто несёт ДВА предложения («к Юлии в понедельник в 10:00,
  // либо к Татьяне в среду в 13:30»), и контекст переносится между фрагментами.
  for (const sentence of String(text || '').split(/(?<=[.!?;\n])/)) {
    const skip = UNAVAILABLE_RE.test(sentence) || BOOKED_UP_RE.test(sentence)
      || BOOKING_STATE_RE.test(sentence) || CLINIC_HOURS_RE.test(sentence);
    const fragments = sentence.split(/(?<=,)|(?=(?<![\p{L}])(?:либо|или)(?![\p{L}]))/u);
    for (const clause of fragments) {
    const d = resolveDateInfo(clause, { nowMs });
    // Аппозиция «6 октября, во вторник»: день недели, совпадающий с уже
    // известной ЯВНОЙ датой, описывает тот же день и контекст не двигает.
    // Не совпадающий («6 октября … , а в среду») — новая ссылка, как раньше.
    const apposition = d && d.kind === 'weekday' && ctx.date && ctx.dateKind !== 'weekday'
      && weekdayOf(ctx.date) === d.weekday;
    if (d && !apposition) { ctx.date = d.key; ctx.dateKind = d.kind; }
    const who = names.length ? lastMentioned(clause, names) : null;
    if (who) ctx.staff = who;
    if (skip) continue;
    if (!ctx.date && !ctx.staff) continue;
    const times = extractTimes(clause.replace(FROM_TIME_RE, ' ')).filter(t => !patientTimes.has(t));
    // Без цифр: «есть свободные окна в четверг» на дату, которой в evidence НЕТ
    // ВОВСЕ (четвёртый живой прогон 2026-09-19) — выдумка без времени.
    if (!times.length && ctx.date && AVAILABILITY_CLAIM_RE.test(clause)) {
      const rows = (ctx.staff ? allRows.filter(r => !r.name || sameName(r.name, ctx.staff)) : allRows)
        .filter(r => r.date === ctx.date);
      if (!rows.length) {
        const value = `${fmtDdMm(ctx.date)}${ctx.staff ? ` у ${ctx.staff}` : ''}: свободных окон на эту дату в выдаче нет вовсе (дата не запрашивалась)`;
        if (!seen.has(value)) { seen.add(value); out.push({ type: 'unverified_offer_date', value }); }
      }
      continue;
    }
    for (const t of times) {
      const byStaff = (rows) => (ctx.staff ? rows.filter(r => !r.name || sameName(r.name, ctx.staff)) : rows);
      let ok;
      let alts;
      if (ctx.date) {
        const rows = byStaff(allRows.filter(r => r.date === ctx.date));
        ok = rows.some(r => r.time === t);
        alts = [...new Set(rows.map(r => r.time))].sort();
      } else {
        const rows = byStaff(allRows);
        ok = rows.some(r => r.time === t);
        alts = [...new Set(rows.map(r => `${fmtDdMm(r.date)} ${r.time}`))].sort();
      }
      if (ok) continue;
      const head = ctx.date ? `${fmtDdMm(ctx.date)} ${t}` : t;
      const whom = ctx.staff ? ` у ${ctx.staff}` : '';
      const where = ctx.date ? `в выдаче на эту дату${ctx.staff ? ' у этого мастера' : ''}` : 'в выдаче у этого мастера';
      const value = `${head}${whom}; ${where}: ${alts.slice(0, 8).join(', ') || 'ничего'}`;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ type: 'unverified_offer_date', value });
    }
    }
  }
  return out;
}

module.exports = { checkOfferAttribution, resolveDate, resolveDateInfo };
