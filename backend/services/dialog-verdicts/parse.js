// backend/services/dialog-verdicts/parse.js
'use strict';
// Разбор ответа модели. Строгий: все id ровно по разу, статус из списка,
// other только с label. Любая ошибка → {ok:false, reasons} — пачка повторяется
// один раз с перечислением причин (run.js), вторая неудача → failed.
const { sanitizeLine } = require('../agent/sanitize');
const { STATUS_CODES } = require('./taxonomy');

const NOTE_MAX = 120;
const LABEL_MAX = 60;
const REASON_MAX = 20;
const DIAGNOSTIC_TOKEN_MAX = 30;

function diagnosticToken(value) {
  const token = sanitizeLine(value, DIAGNOSTIC_TOKEN_MAX);
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : '[некорректный формат]';
}

function extractJson(text) {
  let s = String(text == null ? '' : text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) {
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
  }
  return JSON.parse(s);
}

function parseVerdicts(text, expectedIds) {
  let data;
  try { data = extractJson(text); } catch (_) { return { ok: false, reasons: ['ответ не является JSON'] }; }
  const list = data && Array.isArray(data.verdicts) ? data.verdicts : null;
  if (!list) return { ok: false, reasons: ['нет массива verdicts'] };
  const reasons = [];
  const addReason = reason => {
    if (reasons.length < REASON_MAX) reasons.push(reason);
  };
  const seen = new Map();
  for (const v of list) {
    if (reasons.length >= REASON_MAX) break;
    if (!v || typeof v.id !== 'string') { addReason('элемент без id'); continue; }
    if (!expectedIds.includes(v.id)) { addReason(`неизвестный id ${diagnosticToken(v.id)}`); continue; }
    if (seen.has(v.id)) { addReason(`id ${diagnosticToken(v.id)} повторяется`); continue; }
    const status = String(v.status == null ? '' : v.status).trim().toLowerCase();
    if (!STATUS_CODES.includes(status)) { addReason(`${diagnosticToken(v.id)}: статус «${diagnosticToken(v.status)}» вне списка`); continue; }
    const label = sanitizeLine(v.label, LABEL_MAX) || null;
    if (status === 'other' && !label) { addReason(`${diagnosticToken(v.id)}: other без label`); continue; }
    seen.set(v.id, { id: v.id, status, label: status === 'other' ? label : null, note: sanitizeLine(v.note, NOTE_MAX) || null });
  }
  for (const id of expectedIds) if (!seen.has(id)) addReason(`нет вердикта для ${diagnosticToken(id)}`);
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, verdicts: expectedIds.map(id => seen.get(id)) };
}

module.exports = { parseVerdicts, extractJson, NOTE_MAX, LABEL_MAX, REASON_MAX };
