'use strict';

// ── Извлечение ЛИЧНОГО ИМЕНИ из карточки клиента ────────────────────────────
//
// ЗАЧЕМ. utils/client-name.js собирает ФИО для отображения («Вихарева Мария
// Андреевна») — здесь обратная задача: как назвать человека в переписке.
// Инцидент 2026-08-04: Мила написала пациентке «Мария Андреевна, …» — в промпт
// уходило `clients.name` целиком, а правило «обращайся по имени» имени не
// получало вовсе. Отчество в переписке клиники не используется НИКОГДА.
//
// ПОЧЕМУ НЕЛЬЗЯ ПРОСТО ВЗЯТЬ ПЕРВОЕ СЛОВО. На боевой базе PERI (4313 карточек):
//   • 73.5% — «Фамилия Имя Отчество» одной строкой (первое слово = ФАМИЛИЯ);
//   • 89% карточек вообще без поля surname — всё ФИО лежит в поле name YClients;
//   • 11.6% — вместо имени телефон, «Тест 2», «4.\tАбдуллева …»;
//   •  7.6% — одно слово, и это не всегда имя (бывает голая фамилия);
//   • десятки карточек с ПЕРЕПУТАННЫМ порядком («Айнур Алиева», «Алина
//     Игоревна Милькова») — порядку полей CRM доверять нельзя.
//
// ДВА ИСТОЧНИКА УВЕРЕННОСТИ (нужен хотя бы один, иначе имени НЕТ):
//   1. Позиция доказана ОТЧЕСТВОМ. Слово, стоящее вплотную перед отчеством, —
//      имя, в каком бы порядке ни шли остальные части. Работает и для тюркской
//      формы «Фамилия Имя Отец Кызы/Оглы» (отчество занимает два слова).
//   2. Слово есть в СЛОВАРЕ ИМЁН — базовом (utils/given-names.js) или собранном
//      по самому салону (utils/salon-names.js). Это и есть проверка «такое имя
//      действительно существует», без неё «Здравствуйте, Тест!» неизбежно.
//
// Не хватило обоих — возвращаем null. Это не деградация, а безопасный режим:
// бот вежливо спросит, как обращаться, вместо обращения по фамилии.

const { sanitizeLine } = require('../services/agent/sanitize');
const { BASE_GIVEN_NAMES } = require('./given-names');

// Русское отчество. Голое «ич» намеренно НЕ берём: на нём срабатывают фамилии
// («Валевич Ирина») и имя уехало бы на слово вправо.
const PATRONYMIC_RE = /(ович|овна|евич|евна|ьевич|ьевна|ична|инична)$/;
// Тюркское отчество — отдельное слово в хвосте: «… Сейфеддин Кызы».
const TURKIC_PATRONYMIC_RE = /^(кызы|гызы|кизи|оглы|оглу|улы|уулу)$/;
// Однозначно фамильные окончания. Страховка для случая, когда позиция доказана
// отчеством, но на месте имени стоит вторая фамилия («Петрова Никитина Ивановна»).
// «-ин/-ина» намеренно НЕ здесь: на боевой базе 616 позиционно доказанных имён
// оканчиваются так (Екатерина, Марина, Ирина, Алина, Карина, Константин, Эмина,
// Таркин) и ни одно не оказалось фамилией — этот суффикс отрезал бы живые имена.
const SURNAME_RE = /(ов|ев|ёв|ова|ева|ёва|ский|ская|цкий|цкая|енко|швили|дзе|ян)$/;
// «Словесное» слово: буквы, дефис, апостроф. Инициалы («А.») и всё, что с
// цифрами, именем быть не может.
const WORD_RE = /^[\p{L}][\p{L}'-]*$/u;

const MAX_NAME_LEN = 30;

/** Ключ для словаря: нижний регистр, «ё» → «е». */
function normalizeName(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/ё/g, 'е');
}

// Слова имени по порядку. Первое «несловесное» слово обрывает разбор — ровно
// как в sanitizeName: инструкция, дописанная к имени, дальше не проходит.
function tokens(value) {
  const out = [];
  for (const w of sanitizeLine(value, 200).split(' ')) {
    if (!WORD_RE.test(w)) break;
    out.push(w);
    if (out.length >= 5) break;      // «Фамилия Имя Отец Кызы» — предел разумного
  }
  return out;
}

function known(word, dictionary) {
  const key = normalizeName(word);
  if (!key) return false;
  return BASE_GIVEN_NAMES.has(key) || !!(dictionary && dictionary.has(key));
}

/** Имя с заглавной буквы, остальные строчные; дефисные части — каждая с заглавной. */
function canonical(word) {
  const s = String(word || '').trim().slice(0, MAX_NAME_LEN);
  if (!s) return null;
  return s.toLowerCase().replace(/(^|-)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

// Годится ли слово как имя, когда позицию доказало отчество: либо оно есть в
// словаре, либо это чистое кириллическое слово, не похожее на фамилию.
function acceptable(word, dictionary) {
  if (known(word, dictionary)) return true;
  const key = normalizeName(word);
  if (!/^[а-я][а-я-]+$/.test(key)) return false;    // латиница/односимвольное — не гадаем
  return !SURNAME_RE.test(key);
}

/**
 * Позиционный разбор ФИО — БЕЗ словаря. Отдельно экспортируется для сборки
 * словаря по базе салона (utils/salon-names.js): в словарь имеет право попасть
 * только имя, позицию которого доказало отчество.
 * @returns {{given: string|null, proven: boolean}}
 */
function splitFio(value) {
  const t = tokens(value);
  if (t.length < 2) return { given: null, proven: false };

  // Тюркская форма: отчество — два последних слова («Октай Оглы»).
  if (t.length >= 3 && TURKIC_PATRONYMIC_RE.test(normalizeName(t[t.length - 1]))) {
    return { given: canonical(t[t.length - 3]), proven: true };
  }
  const i = t.findIndex(w => PATRONYMIC_RE.test(normalizeName(w)));
  if (i < 0) return { given: null, proven: false };
  // Имя стоит вплотную ПЕРЕД отчеством («Фамилия Имя Отчество», «Имя Отчество
  // Фамилия»). Отчество первым словом — вырожденный случай, берём следующее.
  const given = i === 0 ? t[1] : t[i - 1];
  return given ? { given: canonical(given), proven: true } : { given: null, proven: false };
}

function fromString(value, dictionary) {
  const t = tokens(value);
  if (!t.length) return null;

  const { given, proven } = splitFio(value);
  if (proven && given && acceptable(given, dictionary)) return given;

  // Позиция не доказана (одно слово, «Фамилия Имя», порядок неизвестен) —
  // право на обращение даёт только словарь.
  for (const w of t) if (known(w, dictionary)) return canonical(w);
  return null;
}

// Раздельные поля YClients (name/surname/patronymic). Заполнены они меньше чем
// у 11% карточек, зато там имя лежит отдельным полем — но и перепутать их
// администратору ничто не мешает, поэтому поле name сверяется со словарём и при
// промахе проверяется, не лежит ли имя в surname.
function fromFields(obj, dictionary) {
  const nameTokens = tokens(obj.name);
  const surnameTokens = tokens(obj.surname);
  const structured = (surnameTokens.length || tokens(obj.patronymic).length) && nameTokens.length === 1;

  if (structured) {
    const cand = nameTokens[0];
    if (known(cand, dictionary)) return canonical(cand);
    // Поля перепутаны: в name — фамилия, в surname — имя.
    if (surnameTokens.length === 1 && known(surnameTokens[0], dictionary)) return canonical(surnameTokens[0]);
    // Словарь не знает ни того, ни другого — верим раскладке CRM, но не позволяем
    // обратиться по тому, что выглядит фамилией.
    if (acceptable(cand, dictionary)) return canonical(cand);
    return null;
  }

  return fromString(obj.name, dictionary)
    || fromString(obj.display_name, dictionary)
    || fromString([obj.surname, obj.name, obj.patronymic].filter(Boolean).join(' '), dictionary);
}

/**
 * Личное имя для обращения или null.
 * @param {string|{name,surname,patronymic,display_name}} source карточка или ФИО строкой
 * @param {{dictionary?: Set<string>}} [opts] словарь имён салона (нормализованные ключи)
 */
function resolveGivenName(source, opts = {}) {
  const dictionary = opts.dictionary instanceof Set ? opts.dictionary : null;
  if (source && typeof source === 'object' && !Array.isArray(source)) return fromFields(source, dictionary);
  if (typeof source !== 'string') return null;
  return fromString(source, dictionary);
}

module.exports = { resolveGivenName, splitFio, normalizeName };
