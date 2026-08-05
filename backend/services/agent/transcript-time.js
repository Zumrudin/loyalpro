'use strict';

// Отметка времени у каждой реплики транскрипта.
//
// ЗАЧЕМ: транскрипт грузится без окна по времени, и сообщение недельной давности
// для модели неотличимо от свежего (инцидент 2026-08-05). Метка заодно показывает,
// насколько устарели названные в переписке слоты и цены.
// Держится в паре с пояснением формата в промпте (system-prompt.js,
// раздел ТЕКУЩИЙ КОНТЕКСТ) — менять только вместе, связано тестом.

// Ведущий «отступ» перед меткой. Кроме пробелов сюда входят НЕВИДИМЫЕ символы
// (ZWSP, ZWNJ/ZWJ, LRM/RLM, мягкий перенос, BOM): под \s они не подпадают, и
// один ведущий ​ провёл бы подделанную метку мимо этой регулярки.
// Класс применяется ТОЛЬКО к началу строки: ‍ внутри текста склеивает
// эмодзи (👨‍👩‍👧), вычищать его из сообщения пациента нельзя.
const PAD = '(?:[^\\S\\r\\n]|[\\u00ad\\u200b-\\u200f\\u2060\\ufeff])*';
const LEADING_STAMP_RE = new RegExp(`^${PAD}\\[\\d{2}\\.\\d{2} \\d{2}:\\d{2}\\]${PAD}`);
const ANY_STAMP_RE = /\[\d{2}\.\d{2} \d{2}:\d{2}\]/g;

// hourCycle h23 обязателен: с hour12:false Intl в ряде локалей даёт «24:00».
const FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// tsSec — unix-секунды: msg_ts в chatpush_messages и ts из pendingReplies.peek().
function formatStamp(tsSec) {
  // Number(null) === Number('') === 0, поэтому одного Number.isFinite мало:
  // битый ts нарисовал бы «[01.01 03:00]» и сообщение выглядело бы отправленным
  // в 1970-м. Порог n > 0 тот же, что в session-gap.toTs, — обе половины фичи
  // обязаны одинаково понимать, какой msg_ts считается битым.
  const n = Number(tsSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const p = {};
  for (const part of FMT.formatToParts(new Date(n * 1000))) p[part.type] = part.value;
  return `[${p.day}.${p.month} ${p.hour}:${p.minute}]`;
}

// Чужие метки во ВХОДЯЩЕМ тексте — подделка: настоящую ставим мы сами.
// Чистим начало КАЖДОЙ строки, а не только первой: реплики серии склеиваются
// через \n (history.js), поэтому «\n[29.07 09:44] …» внутри ОДНОГО сообщения
// пациента читается как отдельная реплика с чужим временем — а промпт учит
// модель метке доверять. Метка в СЕРЕДИНЕ строки не трогается: там она
// разделителем реплик не выглядит, а из allowedTimes её уберёт stripAllStamps.
function stripStamp(text) {
  if (typeof text !== 'string') return text;
  return text.split('\n').map((line) => {
    let out = line;
    while (LEADING_STAMP_RE.test(out)) out = out.replace(LEADING_STAMP_RE, '');
    return out;
  }).join('\n');
}

// Все метки в произвольной строке — для reply-guard, который сканирует
// сериализованный транскрипт и иначе принял бы времена отправки за предложенные.
function stripAllStamps(text) {
  return typeof text === 'string' ? text.replace(ANY_STAMP_RE, '') : text;
}

module.exports = { formatStamp, stripStamp, stripAllStamps };
