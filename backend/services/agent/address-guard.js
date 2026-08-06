'use strict';

// ── Адрес клиники — только из базы знаний и только по вопросу. ───────────────
// Чистый модуль: ни БД, ни HTTP.
//
// ЗАЧЕМ: инцидент 2026-08-06 (79037504378). Сразу после успешной записи Мила
// дописала «Наш адрес: 2-й Троицкий переулок, 6Ас4» — адрес ВЫМЫШЛЕННЫЙ
// (настоящий — ул. Генерала Белова, 28 к. 3, статья КБ «Информация о клинике»).
// Журнал agent_tool_events за тот ход содержит РОВНО два вызова
// (get_available_slots и create_booking): search_knowledge_base не звался, то
// есть факт о клинике пришёл из памяти модели.
//
// Промпт этот случай не покрывал в принципе: правило «спросили адрес → зови
// search_knowledge_base» живёт в Сценарии 1 и говорит только про ОТВЕТ на
// вопрос. Инициативная приписка адреса под него не подпадала — а «РАБОТА С
// ФАКТАМИ» перечисляет цены, услуги, мастеров и слоты, но не контакты клиники.
//
// Отсюда детерминированный слой (тот же приём, что greeting/bookings-block:
// факт бьёт правило). Правило одно и закрывает ОБА требования сразу:
//
//   адресная фраза остаётся в реплике, ТОЛЬКО если её значимые слова и номера
//   есть в выдаче search_knowledge_base ЭТОГО хода.
//
//   • выдумка — не проходит по определению (в статье её нет);
//   • инициативная приписка — не проходит, потому что без вопроса пациента
//     модель в базу знаний не ходит вовсе (в инциденте не сходила).
//
// Транскрипт и «ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ» источниками НЕ считаются намеренно:
// в транскрипте лежит её собственная прошлая реплика (могла быть той самой
// выдумкой — самоподтверждение), а память рендерит вызов КБ строкой «искала в
// базе знаний: «запрос»» БЕЗ текста статьи. Цена строгости — если пациент
// переспросит про адрес, а модель ответит по памяти прошлого хода, фраза
// вырежется; при пустой реплике диспетчер переведёт диалог на администратора
// (Сценарий 1 предписывает ровно это, когда статьи нет). Промпт-правило
// «зови search_knowledge_base КАЖДЫЙ раз» выравнивает модель с этим гейтом.

// Маркеры адресной фразы. Список намеренно шире, чем «улица + дом»: вырезание
// сработает только при ОТСУТСТВИИ источника, поэтому лишнее срабатывание стоит
// одной фразы, а пропуск — вымышленного адреса у пациента на руках.
// «площадь» в список НЕ входит: в клинике это площадь обработки (эпиляция).
// СИЛЬНЫЕ маркеры — сама по себе такая фраза уже сообщает пациенту, где мы.
const STRONG_RE = new RegExp([
  'адрес',                                   // «наш адрес», «по адресу»
  'улиц\\w*', 'ул\\.\\s*[А-ЯЁ]',
  'переул\\w*', 'пер\\.\\s*[А-ЯЁ]',
  'проспект\\w*', 'пр-т', 'шоссе', 'бульвар\\w*', 'набережн\\w*', 'проезд\\w*',
  'метро', '(?<![\\p{L}\\p{N}])м\\.\\s*[А-ЯЁ]',
  'корпус', 'корп\\.', 'строение', 'стр\\.\\s*\\d', 'влад\\w*',
  '(?<![\\p{L}\\p{N}])д\\.\\s*\\d', '(?<![\\p{L}\\p{N}])дом\\s*\\d',
].join('|'), 'iu');

// СЛАБЫЕ — про местоположение говорят, но фактом становятся только вместе с
// топонимом или номером дома. Без улики такую фразу не трогаем: «подскажите,
// как вам удобнее добраться?» адреса не раскрывает, и вырезать её незачем.
const WEAK_RE = /(находимся|располагаемся|располож\w*|добраться)/i;

// Экспортируемый предикат «фраза вообще про адрес» — им же связан промпт-тест.
const MARKER_RE = new RegExp(`${STRONG_RE.source}|${WEAK_RE.source}`, 'iu');

// Сокращения, после которых точка НЕ заканчивает предложение. Без этого
// «ул. Генерала Белова, д. 28, к. 3.» рассыпается на четыре куска, маркер
// попадает только в первый, и пациенту уходит огрызок «Генерала Белова, д. 28».
const ABBREV = new Set([
  'ул', 'д', 'к', 'кв', 'корп', 'стр', 'пер', 'пр', 'просп', 'пл', 'наб', 'ш',
  'г', 'обл', 'м', 'тел', 'вл', 'лит', 'эт', 'оф', 'мкр', 'руб', 'шт', 'мин',
  'ч', 'см', 'мл', 'ед', 'т',
]);

// Режет строку на предложения, СОХРАНЯЯ разделители и пробелы: склейка кусков
// обязана возвращать исходную строку байт-в-байт (иначе «чистка» переписывала
// бы реплики, в которых ничего не нашлось).
function splitSentences(line) {
  const s = String(line || '');
  const out = [];
  let start = 0;
  const term = /[.!?…]+/g;   // локальный: у /g-регэкспа состояние (lastIndex)
  let m;
  while ((m = term.exec(s))) {
    if (/^\.+$/.test(m[0])) {
      const before = s.slice(start, m.index);
      const lastWord = (before.match(/([\p{L}\p{N}]+)\s*$/u) || [, ''])[1].toLowerCase();
      // Одиночная БУКВА — сокращение («д. 28», «к. 3»), одиночная ЦИФРА — нет:
      // на «к. 3. Будем ждать» точка после дома обязана остаться границей.
      if (ABBREV.has(lastWord) || /^\p{L}$/u.test(lastWord)) continue;
    }
    out.push(s.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Значимые для проверки части адресной фразы:
//   • имена собственные — слова с заглавной буквы, кроме первого слова фразы
//     (оно заглавное по правилам письма, а не потому, что это топоним);
//   • номера домов/корпусов — только те, что стоят при маркере дома или сразу
//     после названия улицы. Прочие числа не берём: «в 5 минутах от метро» не
//     должно требовать пятёрки в статье.
// ГОТЧА: \b в JS считает словом только ASCII, поэтому «\bд\.» на кириллице не
// срабатывает НИКОГДА (пробел и «д» для него оба несловесные) — границу слева
// приходится ставить явным lookbehind по \p{L}\p{N}.
const HOUSE_RE = /(?<![\p{L}\p{N}])(?:д\.|дом|к\.|корп\.?|корпус|стр\.?|строение|влад\.?)\s*(\d+[а-яёa-z]*\d*)/giu;
const STREET_HOUSE_RE = /(?:ул\.|улиц\w*|переул\w*|пер\.|проспект\w*|пр-т|шоссе|бульвар\w*|набережн\w*|проезд\w*)[^,;:.!?]*[,\s]\s*(\d+[а-яёa-z]*\d*)/gi;

function claimTokens(sentence) {
  const s = String(sentence || '').trim();
  const words = s.split(/\s+/);
  const names = [];
  words.forEach((raw, i) => {
    const w = raw.replace(/[^\p{L}\p{N}-]/gu, '');
    if (i === 0) return;                       // первое слово фразы — не улика
    if (!/^\p{Lu}/u.test(w)) return;
    const clean = w.replace(/-/g, '');
    if (clean.length >= 3) names.push(clean.toLowerCase().replace(/ё/g, 'е'));
  });
  const numbers = [];
  for (const re of [HOUSE_RE, STREET_HOUSE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) numbers.push(m[1].toLowerCase().replace(/ё/g, 'е'));
  }
  return { names, numbers };
}

// Слово считается найденным в источнике по ОБЩЕМУ КОРНЮ, а не дословно:
// модель склоняет топонимы («в Москве» при «г. Москва» в статье), и дословное
// сравнение резало бы верные ответы. Номера домов сверяются точно.
function hasStem(sourceTokens, word) {
  const need = Math.max(4, word.length - 2);
  const stem = word.slice(0, need);
  for (const t of sourceTokens) if (t.startsWith(stem)) return true;
  return false;
}

function isSourced(sentence, sourceTokens) {
  if (!sourceTokens || !sourceTokens.size) return false;
  const { names, numbers } = claimTokens(sentence);
  for (const n of names) if (!hasStem(sourceTokens, n)) return false;
  for (const n of numbers) if (!sourceTokens.has(n)) return false;
  return true;
}

// Нужно ли вообще проверять эту фразу источником.
function isAddressClaim(sentence) {
  if (STRONG_RE.test(sentence)) return true;
  if (!WEAK_RE.test(sentence)) return false;
  // Слабый маркер без топонима и без номера дома фактом не является:
  // «подскажите, как вам удобнее добраться?» адреса не раскрывает.
  const { names, numbers } = claimTokens(sentence);
  return names.length > 0 || numbers.length > 0;
}

// Вырезает из реплик адресные фразы, не подтверждённые выдачей
// search_knowledge_base этого хода. Если вырезать нечего — массив возвращается
// БЕЗ изменений (тот же принцип, что у stripStamp: обычная реплика проходит
// байт-в-байт). Реплика, состоявшая только из адреса, исчезает целиком —
// пустую серию диспетчер переводит на администратора.
function scrubAddresses(replies, opts = {}) {
  const list = Array.isArray(replies) ? replies : [];
  const sourceTokens = new Set(tokenize(opts.sourceText));
  const removed = [];
  const out = list.map((reply) => {
    const text = String(reply == null ? '' : reply);
    if (!MARKER_RE.test(text)) return text;
    let touched = false;
    const lines = text.split('\n').map((line) => {
      const pieces = splitSentences(line);
      const kept = pieces.filter((p) => {
        if (!isAddressClaim(p)) return true;
        if (isSourced(p, sourceTokens)) return true;
        removed.push(p.trim());
        touched = true;
        return false;
      });
      if (kept.length === pieces.length) return line;
      return kept.join('').replace(/[ \t]{2,}/g, ' ').trim();
    });
    if (!touched) return text;
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  });
  return { replies: out.filter((t) => t && t.trim()), removed };
}

module.exports = {
  scrubAddresses, splitSentences, claimTokens, isSourced, isAddressClaim,
  MARKER_RE, STRONG_RE, WEAK_RE,
};
