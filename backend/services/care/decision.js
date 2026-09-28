'use strict';
// Разбор решения care-прохода Милы. LLM обязана вернуть строгий JSON:
//   { "action": "send"|"skip"|"stop_program"|"escalate", "text"?: string,
//     "status"?: "declined"|"completed", "reason": string }
// Всё неразобранное/невалидное → fail-safe skip (НЕ отправка): молчание
// безопаснее выдуманного сообщения пациенту.
// escalate (2026-08-02, код-ревью Task 4): у care-прохода нет инструментов, а
// касание Т+1 буквально спрашивает «как самочувствие» — по МЕД-ГРАНИЦАМ проекта
// (CLAUDE.md) осложнение после процедуры требует немедленной передачи человеку,
// а молчаливый skip никого не зовёт. text для escalate не нужен и игнорируется —
// пациенту при эскалации ничего не пишет сама Мила, дальше пишет оператор.

const ACTIONS = new Set(['send', 'skip', 'stop_program', 'escalate']);
// stop_program законен ТОЛЬКО как отказ пациента («не пишите» → declined).
// «completed» («уже записан / цель достигнута») убран 2026-09-28 вместе с
// правилом 6 промпта: будущая запись — не повод завершать программу (инцидент
// 79164831407, 20 погашенных касаний на проде). Любой другой статус ПОНИЖАЕТСЯ
// до skip этого касания (см. parseCareDecision): цепочка живёт, следующее
// касание уйдёт. Раньше неизвестный статус становился 'stopped' и убивал цепочку.
const STOP_STATUSES = new Set(['declined']);

// Единственное поле, которое реально уходит человеку. Зацикленная модель
// (в проекте уже были такие инциденты) может прогнать тысячи символов до
// API мессенджера — режем жёстко fail-safe'ом, а не обрезкой на полуслове:
// оборванное сообщение пациенту хуже молчания.
const TEXT_MAX = 1500;

// Bidi-override/isolate (U+202A–U+202E, U+2066–U+2069) — известный приём
// спуфинга текста (напр. RTL-override отрисовывает «50%» как «05%»);
// C0/C1-контролы (кроме \n) — бинарный мусор в сообщении пациенту. Чистим
// здесь, а не полагаемся на reply-guard: reply-guard линтует СОДЕРЖАНИЕ
// (утечку id/внутренней кухни), а не класс символов.
const UNSAFE_CHARS_RE = /[\x00-\x09\x0B\x0C\x0E-\x1F\x80-\x9F\u202A-\u202E\u2066-\u2069]/g;

function failSafe(code) { return { action: 'skip', reason: code, failSafe: true }; }

// opts.strict — режим готового текста (text_mode='strict'): текст рендерит код
// (strict-text.js), модель его не видит и не пишет, поэтому send БЕЗ text
// законен, а присланный text отбрасывается (иначе модель могла бы подменить
// текст клиники своим). В свободном режиме text обязателен, как и раньше.
function parseCareDecision(raw, opts = {}) {
  // Жадный regex + строгий JSON.parse — сознательный размен: несколько
  // JSON-блобов в одном ответе склеятся в невалидный JSON и провалятся в
  // llm_bad_json (skip), а не в случайно выбранный из них.
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return failSafe('llm_no_json');
  let obj;
  try {
    // Дубли ключей внутри одного объекта (например два "action") JSON.parse
    // разрешает по правилу last-wins — это поведение спецификации JSON,
    // здесь оно ожидаемо и не требует отдельной обработки.
    obj = JSON.parse(m[0]);
  } catch {
    return failSafe('llm_bad_json');
  }
  if (!ACTIONS.has(obj.action)) return failSafe('llm_bad_action');
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : '';
  if (obj.action === 'send') {
    if (opts.strict) return { action: 'send', text: null, reason };
    // typeof-гейт, а не String(obj.text || ''): массив ["Добрый день!","ещё"]
    // коэрсится в "Добрый день!,ещё" (выглядит настоящим текстом), объект —
    // в "[object Object]", число/bool — в цифры/строку — и всё это ушло бы
    // пациенту как подлинное сообщение.
    if (typeof obj.text !== 'string') return failSafe('llm_text_not_string');
    const text = obj.text.replace(UNSAFE_CHARS_RE, '').trim();
    if (!text) return failSafe('llm_empty_text');
    if (text.length > TEXT_MAX) return failSafe('llm_text_too_long');
    return { action: 'send', text, reason };
  }
  if (obj.action === 'stop_program') {
    if (STOP_STATUSES.has(obj.status)) return { action: 'stop_program', status: obj.status, reason };
    // Понижение, а не fail-safe: reason модели сохраняется (в decision_reason
    // строки видно, ЧЕМ она мотивировала), downgraded даёт воркеру повод для
    // WARN — мерить, как часто модель всё ещё тянется к «уже записан».
    const st = typeof obj.status === 'string' && obj.status ? obj.status.slice(0, 40) : 'none';
    return { action: 'skip', reason, downgraded: `stop_program/${st}` };
  }
  // escalate не пишет пациенту — text не требуется и не разбирается, даже
  // если модель его прислала (в отличие от send, где text — единственное
  // поле, которое реально уходит человеку).
  if (obj.action === 'escalate') {
    return { action: 'escalate', reason };
  }
  return { action: 'skip', reason: reason || 'skip' };
}

module.exports = { parseCareDecision, UNSAFE_CHARS_RE, TEXT_MAX };
