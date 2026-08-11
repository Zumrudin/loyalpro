'use strict';

// ── «ДОЛЖНОСТЬ НАЗЫВАЙ ОДИН РАЗ ЗА ДИАЛОГ» — детерминированная дочистка. ─────
// Чистый модуль: ни БД, ни HTTP.
//
// Правило промпта: должность специалиста звучит при ПЕРВОМ упоминании, дальше —
// только имя («косметолог-эстетист Юлия… у косметолога-эстетиста Юлии…» подряд
// звучит казённо). Держалось только на промпте. Замена безопасна текстуально:
// в русской конструкции «должность + Имя» падеж несёт ИМЯ, поэтому срез
// должности («у косметолога-эстетиста Юлии» → «у Юлии») оставляет фразу
// грамматичной. Первое упоминание в ТЕКУЩЕЙ реплике не трогается — срезаются
// только имена, чья должность уже звучала в ПРОШЛЫХ репликах Милы.
//
// Должности — паттерны со склонением (списком, а не «любое слово перед именем»).
// «наш специалист» намеренно не в списке: это не должность, а оборот речи.
// Первая буква каждой должности — явным классом [Гг]/[Вв]/[Кк], а НЕ флагом `i`:
// с `iu` свойства \p{Lu}/\p{Ll} замыкаются по case-folding и капитализация имени
// перестаёт проверяться вовсе — «косметолог-эстетист свободна» captured бы
// «свободна» как имя.
const POSITION_SRC =
  '(?:[Гг]лавн[а-яё]+\\s+[Вв]рач[а-яё]*|[Вв]рач[а-яё]*-косметолог[а-яё]*|[Кк]осметолог[а-яё]*-эстетист[а-яё]*)';
// Пара «должность[,] Имя [Отчество]» — имя капитализировано, 1–2 слова.
const PAIR_RE = new RegExp(
  `${POSITION_SRC},?\\s+(\\p{Lu}\\p{Ll}+(?:\\s+\\p{Lu}\\p{Ll}+)?)`, 'gu');

// Имя в переписке склоняется («Юлия» / «к Юлии») — сверка по стему, тот же
// приём, что mentionsPerson в reply-guard.
const MIN_STEM = 4;
const stemOf = (word) => word.slice(0, Math.max(MIN_STEM, word.length - 2));

// Точного равенства стемов МАЛО: у 4-буквенного имени стем — всё слово, и
// «Юлия»/«Юлии» разошлись бы последней буквой (склонение живёт в хвосте).
// Поэтому членство в seen проверяется общим префиксом: от КОРОТКОГО стема
// отрезаются ещё до 2 финальных букв, но не короче 3-х. Остаточный риск тот же,
// что у personRe в reply-guard (близкие имена вроде «Мария»/«Марина» могут
// склеиться); цена ошибки — лишний срез должности, а не потеря смысла.
function stemsMatch(a, b) {
  if (a === b) return true;
  const n = Math.max(MIN_STEM - 1, Math.min(a.length, b.length) - 2);
  return a.length >= n && b.length >= n && a.slice(0, n) === b.slice(0, n);
}

// Стемы имён, у которых должность уже звучала в прошлом тексте Милы.
function namesWithTitle(priorAssistantText) {
  const out = new Set();
  for (const m of String(priorAssistantText || '').matchAll(PAIR_RE)) {
    out.add(stemOf(m[1].split(/\s+/)[0]));
  }
  return out;
}

// → { replies, stripped } — stripped идёт в лог оркестратора.
// PAIR_RE глобальный и общий для matchAll и replace — это безопасно: matchAll
// итерирует КЛОН регулярки, а replace с g-флагом сбрасывает lastIndex сам.
function stripRepeatedTitles(replies, priorAssistantText) {
  const list = Array.isArray(replies) ? replies : [];
  const seen = namesWithTitle(priorAssistantText);
  if (!seen.size) return { replies: list, stripped: [] };
  const stripped = [];
  const out = list.map(text => String(text).replace(PAIR_RE, (full, name) => {
    const stem = stemOf(name.split(/\s+/)[0]);
    if (![...seen].some(s => stemsMatch(s, stem))) return full;
    stripped.push(full.trim());
    return name;
  }));
  return { replies: out, stripped };
}

module.exports = { stripRepeatedTitles, namesWithTitle };
