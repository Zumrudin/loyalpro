'use strict';

// ── Закрытие окна расписания ПОСРЕДИ живого диалога ──────────────────────────
//
// ЗАЧЕМ. Инцидент 2026-09-19 (79651442032): Мила вела перенос записи с 09:00,
// окно PERI кончается в 09:30, и в 09:32 пациентка написала «Удобнее, если
// перезвонит администратор. Здесь просто тратить время». Диспетчер: `gate skip
// (outside-schedule)` — ни эскалации, ни подсветки в «Чате», ни фразы о
// переводе; администратор нашёл диалог сам через 18 минут. Отсечка окна
// задумана жёсткой (после 09:30 на месте люди), но неотвеченное сообщение в
// диалоге, который бот только что вёл, обязано ЯВНО перейти к человеку.
//
// Правило (чистая decideWindowHandover):
//   • диалог сейчас у бота (status='bot'; escalated/closed — уже у человека);
//   • последняя реплика Милы не старше AGENT_WINDOW_HANDOVER_MIN (дефолт 60;
//     0 выключает) — старый диалог окном не «обрывался», обрывать нечего;
//   • входящее — не чистая формула вежливости («Спасибо» после нашего ответа
//     не повод красить диалог красным).
// Действие: эскалация тем же escalate_to_operator (reason 'window_closed' —
// подсветка, SSE, гашение напоминаний) + фраза перевода пациенту. Всё
// best-effort: сбой любого шага — только в лог. На следующем открытии окна
// dialog-state.resumeOperatorPauses возвращает такой диалог боту, как паузу
// администратора (это не разрешённый конфликт).
//
// ДОПУЩЕНИЕ (решение салона не запрашивалось, зафиксировано в спеке
// 2026-09-19-agent-reschedule-guards-design.md §7): бот после закрытия окна НЕ
// продолжает — грейс-период столкнул бы Милу с администратором, вышедшим на
// смену.

const { isPureClosing } = require('./closing');

const WINDOW_CLOSED_REASON = 'window_closed';

/**
 * @param {{dialogStatus: string|null, lastAgentReplyAgeMs: number|null,
 *          maxAgeMs: number, incomingText?: string}} p
 * @returns {{action: 'handover'|'skip', why: string}}
 */
function decideWindowHandover({ dialogStatus, lastAgentReplyAgeMs, maxAgeMs, incomingText } = {}) {
  if (!(maxAgeMs > 0)) return { action: 'skip', why: 'disabled' };
  if (dialogStatus !== 'bot') return { action: 'skip', why: `status=${dialogStatus || 'none'}` };
  if (!Number.isFinite(lastAgentReplyAgeMs)) return { action: 'skip', why: 'no-agent-reply' };
  if (lastAgentReplyAgeMs > maxAgeMs) return { action: 'skip', why: 'agent-reply-too-old' };
  if (typeof incomingText === 'string' && incomingText.trim() && isPureClosing(incomingText)) {
    return { action: 'skip', why: 'pure-closing' };
  }
  return { action: 'handover', why: 'live-dialog' };
}

/**
 * Вход диспетчера на gate.reason === 'outside-schedule'.
 * deps: { state (dialog-state), history, escalate(salonId, dialogKey, reason),
 *         send(meta, text), handoverText(), maxAgeMs, nowMs, logger }.
 * @returns {Promise<boolean>} был ли перевод
 */
async function onOutsideSchedule(salonId, dialogKey, meta, deps) {
  const log = deps.logger || { info() {}, warn() {} };
  let dialogStatus = null;
  let lastAgentReplyAgeMs = null;
  try {
    const row = await deps.state.get(salonId, dialogKey);
    dialogStatus = row ? row.status : null;
    const at = await deps.history.lastAgentReplyAt(salonId, dialogKey);
    lastAgentReplyAgeMs = Number.isFinite(at) ? (deps.nowMs || Date.now()) - at : null;
  } catch (e) {
    log.warn(`dialog ${dialogKey}: окно закрыто, состояние диалога не прочитать (${e.message}) — без перевода`);
    return false;
  }
  const d = decideWindowHandover({
    dialogStatus, lastAgentReplyAgeMs, maxAgeMs: deps.maxAgeMs, incomingText: meta && meta.text,
  });
  if (d.action !== 'handover') {
    log.info(`dialog ${dialogKey}: окно расписания закрыто, перевода нет (${d.why})`);
    return false;
  }
  log.info(`dialog ${dialogKey}: окно расписания закрылось посреди живого диалога (реплика Милы ${Math.round(lastAgentReplyAgeMs / 60000)} мин назад) — перевод на администратора`);
  try {
    await deps.escalate(salonId, dialogKey, WINDOW_CLOSED_REASON);
  } catch (e) {
    log.warn(`dialog ${dialogKey}: эскалация по закрытию окна не удалась (${e.message}) — пациенту всё равно отвечаем`);
  }
  try {
    await deps.send(meta, deps.handoverText());
  } catch (e) {
    log.warn(`dialog ${dialogKey}: фраза перевода по закрытию окна не ушла (${e.message})`);
  }
  return true;
}

module.exports = { decideWindowHandover, onOutsideSchedule, WINDOW_CLOSED_REASON };
