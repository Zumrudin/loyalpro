'use strict';
// Разложение ФИО одной строкой на фамилию, имя и отчество для документов.
// В YClients у 89 % карточек всё ФИО лежит в поле name, порядок слов не гарантирован.
// Позицию доказывает ОТЧЕСТВО (то же правило, что utils/person-name.splitFio):
// имя стоит вплотную перед отчеством, остальное — фамилия. Без отчества порядок не
// доказан — confident:false, и форма просит администратора проверить поля.
const { PATRONYMIC_RE, TURKIC_PATRONYMIC_RE, normalizeName } = require('../../utils/person-name');

const WORD_RE = /^[\p{L}][\p{L}'-]*$/u;

/** «иванова-петрова» → «Иванова-Петрова». */
function cap(w) {
  return String(w || '').toLowerCase().replace(/(^|-)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

// Слова до первого «несловесного» (телефон, «Тест 2», «4.» обрывают разбор).
function words(name) {
  const out = [];
  for (const w of String(name || '').trim().split(/\s+/)) {
    if (!w) continue;
    if (!WORD_RE.test(w)) break;
    out.push(w);
  }
  return out;
}

/** @returns {{ last_name: string, first_name: string, middle_name: string, confident: boolean }} */
function splitFullName(name) {
  const t = words(name);
  const n = t.length;
  if (!n) return { last_name: '', first_name: '', middle_name: '', confident: false };
  if (n >= 3 && TURKIC_PATRONYMIC_RE.test(normalizeName(t[n - 1]))) {
    return {
      last_name: t.slice(0, n - 3).map(cap).join(' '),
      first_name: cap(t[n - 3]),
      middle_name: `${cap(t[n - 2])} ${cap(t[n - 1])}`,
      confident: n >= 4,
    };
  }
  const i = t.findIndex((w) => PATRONYMIC_RE.test(normalizeName(w)));
  if (i >= 1) {
    const rest = [...t.slice(0, i - 1), ...t.slice(i + 1)];
    return { last_name: rest.map(cap).join(' '), first_name: cap(t[i - 1]), middle_name: cap(t[i]), confident: rest.length === 1 };
  }
  if (n === 1) return { last_name: '', first_name: cap(t[0]), middle_name: '', confident: false };
  return { last_name: cap(t[0]), first_name: cap(t[1]), middle_name: t.slice(2).map(cap).join(' '), confident: false };
}

module.exports = { splitFullName, cap };
