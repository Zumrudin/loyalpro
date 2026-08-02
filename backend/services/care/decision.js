'use strict';
// Разбор решения care-прохода Милы. LLM обязана вернуть строгий JSON:
//   { "action": "send"|"skip"|"stop_program", "text"?: string,
//     "status"?: "declined"|"completed", "reason": string }
// Всё неразобранное/невалидное → fail-safe skip (НЕ отправка): молчание
// безопаснее выдуманного сообщения пациенту.

const ACTIONS = new Set(['send', 'skip', 'stop_program']);
const STOP_STATUSES = new Set(['declined', 'completed']);

function failSafe(code) { return { action: 'skip', reason: code, failSafe: true }; }

function parseCareDecision(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return failSafe('llm_no_json');
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return failSafe('llm_bad_json'); }
  if (!ACTIONS.has(obj.action)) return failSafe('llm_bad_action');
  const reason = String(obj.reason || '').slice(0, 500);
  if (obj.action === 'send') {
    const text = String(obj.text || '').trim();
    if (!text) return failSafe('llm_empty_text');
    return { action: 'send', text, reason };
  }
  if (obj.action === 'stop_program') {
    return {
      action: 'stop_program',
      status: STOP_STATUSES.has(obj.status) ? obj.status : 'stopped',
      reason,
    };
  }
  return { action: 'skip', reason: reason || 'skip' };
}

module.exports = { parseCareDecision };
