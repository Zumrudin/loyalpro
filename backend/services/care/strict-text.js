'use strict';
// Готовый текст касания (care_touches.text_mode='strict') рендерит КОД, а не
// модель (решение 2026-09-28). До этого шаблон салона показывался модели с
// инструкцией «отправь дословно, подставь имя» — и модель применяла к нему
// СВОИ правила: на проде касание «Т+7 губы» трижды ушло в escalate с причиной
// «готовый текст содержит медицинскую рекомендацию («Активнее увлажняйте
// губы»)», а на живом пробнике — skip 4 из 4. Текст написала клиника и
// утвердил врач; модели он теперь не показывается вовсе (отказать по тексту,
// которого не видишь, нельзя — тот же приём, что убранные из промпта будущие
// записи), она решает только «слать ли» по переписке. Заодно исчезает риск
// «менять нельзя», который держался только на промпте.
//
// Плейсхолдер имени — [Имя]/{Имя} в любом регистре (так пишут шаблоны на
// проде). Имя сюда приходит УЖЕ через resolveGivenName (личное имя или null):
// нет имени → плейсхолдер убирается вместе с примыкающей запятой, следующее
// слово капитализируется («[Имя], здравствуйте!» → «Здравствуйте!»).
const { UNSAFE_CHARS_RE, TEXT_MAX } = require('./decision');

const PLACEHOLDER_RE = /[\[{]\s*имя\s*[\]}]/giu;

function renderStrictText(template, givenName) {
  if (typeof template !== 'string') return null;
  const name = typeof givenName === 'string' ? givenName.trim() : '';
  let text;
  if (name) {
    text = template.replace(PLACEHOLDER_RE, name);
  } else {
    // «[Имя], здравствуйте» → «здравствуйте»; «день, [Имя]!» → «день!»
    text = template
      .replace(new RegExp(`${PLACEHOLDER_RE.source}\\s*,\\s*`, 'giu'), '')
      .replace(new RegExp(`\\s*,\\s*${PLACEHOLDER_RE.source}`, 'giu'), '')
      .replace(PLACEHOLDER_RE, '');
    // Капитализация первой буквы в начале каждой строки (плейсхолдер на проде
    // всегда открывает строку); внутри строки регистр не трогаем.
    text = text.replace(/(^|\n)([^\S\n]*)(\p{Ll})/gu, (m, a, b, c) => a + b + c.toUpperCase());
  }
  text = text.replace(UNSAFE_CHARS_RE, '').trim();
  if (!text || text.length > TEXT_MAX) return null;
  return text;
}

module.exports = { renderStrictText, PLACEHOLDER_RE };
