'use strict';

// ── Свежий write-инструмент в журнале как доказательство для анти-ложь-guard'а ──
//
// ЗАЧЕМ. `COMPLETION_CLAIM` («перенесла», «добавила услугу») в orchestrator.js —
// безусловная ложь без успешного write-инструмента В ЭТОМ ЖЕ ХОДЕ: снимок
// записей CRM подтвердить перенос не может (он показывает время, но не то, что
// оно менялось). Но сам ХОД — не единственный источник правды: журнал
// agent_tool_events хранит каждый вызов инструмента, и успешный reschedule_booking
// секундной давности доказывает перенос надёжнее любого снимка.
//
// Инцидент 2026-09-13 (79231471109): два сообщения с разницей в 10 секунд
// («11.30, запишите» и «С 19.09 запись отменить»). Первый прогон перенёс запись
// и отправил подтверждение; второе сообщение пришло во время обработки →
// диспетчер запустил rerun как НЕЗАВИСИМЫЙ прогон. В нём модель без инструмента
// правдиво повторила «я как раз только что перенесла вашу запись» — guard видел
// только свой ход и увёл диалог на администратора на полтора часа.
//
// ОКНО короткое намеренно: перенос часовой давности не должен прикрывать свежую
// выдумку «перенесла на 15:00». 15 минут покрывают и rerun (секунды), и следующий
// типовой случай — «точно перенесли?» через пару минут.
//
// ПОЛЯРНОСТЬ обязательна (та же логика, что у existsHonest/cancelledHonest):
// свежая ЗАПИСЬ не подтверждает «отменила», свежая ОТМЕНА — «вы записаны».
// Перенос подтверждает все три формы: «старая запись отменена, вы записаны на
// новое время» — законное описание переноса.

const RECENT_WRITE_WINDOW_MS = 15 * 60 * 1000;

// Инструмент → виды утверждений detectFalseClaim, которые он подтверждает.
const VOUCHES = {
  create_booking: ['booked'],
  book_chain: ['booked'],
  reschedule_booking: ['completion', 'booked', 'cancelled'],
  modify_booking_services: ['completion', 'booked'],
  cancel_booking: ['cancelled'],
};

function parseMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// book_chain — единственный write, чей успех не равен «без error»: option_expired
// и failed_at без partial записей не создают (то же правило, что writeSucceeded
// в оркестраторе).
function isSuccessfulWrite(row) {
  if (!row || row.is_error || !VOUCHES[row.tool]) return false;
  if (row.tool !== 'book_chain') return true;
  const r = parseMaybe(row.result);
  return !!(r && (r.booked_all || r.partial));
}

/**
 * Самый свежий успешный write-инструмент не старше окна.
 * @param {Array<{tool:string, age_ms:number, is_error:boolean, result:any}>} rows
 *   строки tool-events.loadRecent (age_ms считается в SQL).
 * @param {{nowMs?: number, windowMs?: number}} opts nowMs обязателен — без него
 *   свежесть неизвестна и доказательства нет (fail-closed в прежнее поведение).
 * @returns {{tool:string, ageMs:number}|null}
 */
function findRecentWrite(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length || !opts.nowMs) return null;
  const windowMs = opts.windowMs || RECENT_WRITE_WINDOW_MS;
  let best = null;
  for (const row of rows) {
    if (!isSuccessfulWrite(row)) continue;
    const ageMs = Number(row.age_ms);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > windowMs) continue;
    if (!best || ageMs < best.ageMs) best = { tool: row.tool, ageMs };
  }
  return best;
}

/** @returns {Set<'completion'|'booked'|'cancelled'>} */
function vouchesFor(tool) {
  return new Set(VOUCHES[tool] || []);
}

module.exports = { findRecentWrite, vouchesFor, RECENT_WRITE_WINDOW_MS };
