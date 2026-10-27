'use strict';

// ── Стилевой слой исходящих реплик Милы ─────────────────────────────────────
// Чистый модуль: ни БД, ни HTTP. Четыре точки применения (спека
// docs/superpowers/specs/2026-10-27-mila-human-tone-design.md, раздел 4.2):
// обёртка send диспетчера; предварительный проход по списку реплик в
// deliverReplies — чтобы в markSent ушёл тот же текст, что и пациенту;
// additional-proposals.prepare() — текст предложения доп. визита; воркер
// напоминаний о себе.
//
// ЗАЧЕМ: замер прода 27.10.2026 — markdown в 28 % реплик (`**15:30**`,
// `*   пункт`), а TDLib-шлюз шлёт formattedText с пустым entities и MAX —
// простой текст, то есть звёздочки видны буквально; обращение скачет между
// «Вы» модели (55 %) и «вы» фраз кода. Промпт при этом сам велел «жирным
// выделяй время». Правило одно и в коде: markdown убираем, обращение — с
// заглавной (решение владельца: «Вы» остаётся).
//
// Известные ограничения (сознательно не чиним):
//   «- » в начале строки-продолжения становится пунктом списка «• …»;
//   «** 15:30 **» (пробелы внутри маркеров) оставляет двойные пробелы вокруг «15:30».

// Полная парадигма «вы» и «ваш» (все падежи и роды): пропущенная форма молча
// остаётся строчной — так было с «вашем» («в вашем случае»).
const ADDRESS_FORMS = ['вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашу',
  'вашей', 'вашего', 'вашему', 'вашем', 'ваших', 'вашим', 'вашими', 'вашею'];
// Границы по буквам, а не \b: \b в JS считает словом только ASCII и на
// кириллице не срабатывает никогда (та же готча, что в address-guard).
const ADDRESS_RE = new RegExp(`(?<![\\p{L}])(?:${ADDRESS_FORMS.join('|')})(?![\\p{L}])`, 'gu');

// Границы выделения — по исключению: снаружи открывающего маркера начало строки
// или любой символ, кроме буквы, цифры, «_», «@» и самого символа маркера;
// снаружи закрывающего — конец строки или такой же символ. Так «peri_clinic_promo»,
// «file__name__v2» и «5*3=15» остаются как есть, а эмодзи, тире, «₽», кавычки „“”,
// «•» и скобки снаружи «**15:30**» снять выделение не мешают.
// «/» запрещён только у «_»/«__»: там он часть адреса («site.ru/_promo_/»), а у
// звёздочек это диапазон — «**15:30**/**16:00**» обязан стать «15:30/16:00».
const STAR_OPEN = String.raw`(?<![\p{L}\p{N}_@*])`;
const STAR_CLOSE = String.raw`(?![\p{L}\p{N}_@*])`;
const UNDERSCORE_OPEN = String.raw`(?<![\p{L}\p{N}_/@])`;
const UNDERSCORE_CLOSE = String.raw`(?![\p{L}\p{N}_/@])`;
// ***жирный курсив*** — первым, иначе от него останутся одиночные звёздочки.
const BOLD_ITALIC_STAR_RE = new RegExp(String.raw`${STAR_OPEN}\*\*\*([^*\n][^*\n]*?)\*\*\*${STAR_CLOSE}`, 'gu');
const BOLD_STAR_RE = new RegExp(String.raw`${STAR_OPEN}\*\*([^*\n][^*\n]*?)\*\*${STAR_CLOSE}`, 'gu');
const BOLD_UNDERSCORE_RE = new RegExp(String.raw`${UNDERSCORE_OPEN}__([^_\n][^_\n]*?)__${UNDERSCORE_CLOSE}`, 'gu');
// Одиночные маркеры курсива — ещё и вплотную к тексту: «2 * 3» не курсив.
const ITALIC_STAR_RE = new RegExp(String.raw`${STAR_OPEN}\*(?=\S)([^*\n]+?)(?<=\S)\*${STAR_CLOSE}`, 'gu');
const ITALIC_UNDERSCORE_RE = new RegExp(String.raw`${UNDERSCORE_OPEN}_(?=\S)([^_\n]+?)(?<=\S)_${UNDERSCORE_CLOSE}`, 'gu');

// Проход повторяется, пока текст меняется, до 10 раз: вложенные маркеры
// снимаются за ОДИН вызов («_*важно*_» → «*важно*» → «важно», «``15:30``» →
// «`15:30`» → «15:30», «# # a» → «# a» → «a»). Без этого повторный вызов снимал
// бы ещё слой, а в диспетчере слой применяется дважды. Цикл сходится: каждый
// проход либо укорачивает текст, либо меняет маркер списка на «•», который
// повторно не срабатывает; потолок — страховка.
const MAX_PASSES = 10;

function isEnabled(env) {
  // null/undefined → боевое окружение процесса.
  const e = env || process.env;
  return String(e.AGENT_REPLY_STYLE || '').trim().toLowerCase() !== 'false';
}

function stripPass(t) {
  // Ссылка [текст](url) → «текст: url» — до остального, пока скобки целы.
  t = t.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, '$1: $2');
  // Жирный курсив, жирный и подчёркнутый — внутри одной строки.
  t = t.replace(BOLD_ITALIC_STAR_RE, '$1');
  t = t.replace(BOLD_STAR_RE, '$1');
  t = t.replace(BOLD_UNDERSCORE_RE, '$1');
  // Обратные кавычки вокруг текста.
  t = t.replace(/`([^`\n]+)`/g, '$1');
  // Заголовки и маркеры списков — только в начале строки. «•» и нумерация не
  // трогаются; «+» маркером не считается: «+ 500 бонусов» — это не список.
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*[*\-][ \t]+(?=\S)/gm, '• ');
  // Одиночные *курсив* / _курсив_.
  t = t.replace(ITALIC_STAR_RE, '$1');
  t = t.replace(ITALIC_UNDERSCORE_RE, '$1');
  // Хвостовые пробелы и лишние пустые строки.
  t = t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  return t;
}

// Не-строка → '' во всех трёх функциях (контракт спеки): иначе объект ушёл бы
// пациенту как «[object Object]», а число — цифрами вместо реплики.
function stripMarkdown(input) {
  let t = typeof input === 'string' ? input : '';
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = stripPass(t);
    if (next === t) break;
    t = next;
  }
  return t;
}

function capitalizeAddress(input) {
  const t = typeof input === 'string' ? input : '';
  return t.replace(ADDRESS_RE, m => m[0].toUpperCase() + m.slice(1));
}

// Идемпотентна: f(f(x)) === f(x), пока тексту хватает MAX_PASSES проходов —
// внутри диспетчера слой применяется дважды (список реплик и обёртка send), и
// это закреплено тестом.
function applyReplyStyle(text, opts) {
  // null от вызывающего не должен ронять отправку реплики.
  opts = opts || {};
  const raw = typeof text === 'string' ? text : '';
  if (!isEnabled(opts.env)) return raw;
  return capitalizeAddress(stripMarkdown(raw));
}

module.exports = { stripMarkdown, capitalizeAddress, applyReplyStyle, isEnabled, ADDRESS_FORMS };
