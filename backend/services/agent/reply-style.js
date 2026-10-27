'use strict';

// ── Стилевой слой исходящих реплик Милы ─────────────────────────────────────
// Чистый модуль: ни БД, ни HTTP. Применяется в ОДНОЙ точке диспетчера (обёртка
// send) и в воркере напоминаний о себе — спека
// docs/superpowers/specs/2026-10-27-mila-human-tone-design.md, раздел 4.
//
// ЗАЧЕМ: замер прода 27.10.2026 — markdown в 28 % реплик (`**15:30**`,
// `*   пункт`), а TDLib-шлюз шлёт formattedText с пустым entities и MAX —
// простой текст, то есть звёздочки видны буквально; обращение скачет между
// «Вы» модели (55 %) и «вы» фраз кода. Промпт при этом сам велел «жирным
// выделяй время». Правило одно и в коде: markdown убираем, обращение — с
// заглавной (решение владельца: «Вы» остаётся).

// Полная парадигма «вы» и «ваш» (все падежи и роды): пропущенная форма молча
// остаётся строчной — так было с «вашем» («в вашем случае»).
const ADDRESS_FORMS = ['вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашу',
  'вашей', 'вашего', 'вашему', 'вашем', 'ваших', 'вашим', 'вашими', 'вашею'];
// Границы по буквам, а не \b: \b в JS считает словом только ASCII и на
// кириллице не срабатывает никогда (та же готча, что в address-guard).
const ADDRESS_RE = new RegExp(`(?<![\\p{L}])(?:${ADDRESS_FORMS.join('|')})(?![\\p{L}])`, 'gu');

// Границы выделения (**, __, *, _): открывающий маркер — в начале строки или
// после пробела, открывающей скобки, кавычки; закрывающий — перед концом строки,
// пробелом или знаком препинания. ЗАЧЕМ: у «@_peri_», «site.ru/_promo_/»,
// «file__name__v2» и «5*3» снаружи маркера буква, цифра, «/» или «@» — это ник,
// адрес, имя файла и арифметика, а не разметка.
const OPEN = String.raw`(?<=^|[\s(\[«"'])`;
const CLOSE = String.raw`(?=$|[\s.,!?;:)\]»"'…])`;
const BOLD_STAR_RE = new RegExp(String.raw`${OPEN}\*\*([^*\n][^*\n]*?)\*\*${CLOSE}`, 'gmu');
const BOLD_UNDERSCORE_RE = new RegExp(String.raw`${OPEN}__([^_\n][^_\n]*?)__${CLOSE}`, 'gmu');
// Одиночные маркеры курсива — ещё и вплотную к тексту: «2 * 3» не курсив.
const ITALIC_STAR_RE = new RegExp(String.raw`${OPEN}\*(?=\S)([^*\n]+?)(?<=\S)\*${CLOSE}`, 'gmu');
const ITALIC_UNDERSCORE_RE = new RegExp(String.raw`${OPEN}_(?=\S)([^_\n]+?)(?<=\S)_${CLOSE}`, 'gmu');

// Проход повторяется, пока текст меняется, но не больше трёх раз: вложенные
// маркеры снимаются за ОДИН вызов («_*важно*_» → «*важно*» → «важно»,
// «``15:30``» → «`15:30`» → «15:30»). Без этого повторный вызов снимал бы ещё
// слой, а в диспетчере слой применяется дважды. Вложенность глубже трёх слоёв
// дочистит следующий вызов.
const MAX_PASSES = 3;

function isEnabled(env) {
  // null/undefined → боевое окружение процесса.
  const e = env || process.env;
  return String(e.AGENT_REPLY_STYLE || '').trim().toLowerCase() !== 'false';
}

function stripPass(t) {
  // Ссылка [текст](url) → «текст: url» — до остального, пока скобки целы.
  t = t.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, '$1: $2');
  // Жирный/подчёркнутый двойными маркерами — внутри одной строки.
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

function stripMarkdown(input) {
  let t = String(input == null ? '' : input);
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = stripPass(t);
    if (next === t) break;
    t = next;
  }
  return t;
}

function capitalizeAddress(input) {
  return String(input == null ? '' : input).replace(ADDRESS_RE, m => m[0].toUpperCase() + m.slice(1));
}

// Идемпотентна: f(f(x)) === f(x), пока вложенность маркеров не глубже трёх
// слоёв (MAX_PASSES) — внутри диспетчера слой применяется дважды (список
// реплик и обёртка send), и это закреплено тестом.
function applyReplyStyle(text, opts) {
  // null от вызывающего не должен ронять отправку реплики.
  opts = opts || {};
  const raw = String(text == null ? '' : text);
  if (!isEnabled(opts.env)) return raw;
  return capitalizeAddress(stripMarkdown(raw));
}

module.exports = { stripMarkdown, capitalizeAddress, applyReplyStyle, isEnabled, ADDRESS_FORMS };
