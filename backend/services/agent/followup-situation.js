'use strict';
// ============================================================
// Класс ситуации хода-якоря — уместен ли бонусный довод в напоминании Милы о
// себе. ЧИСТЫЙ модуль: ни БД, ни сети. Спека —
// docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md.
//
// Два источника: журнал инструментов хода (agent_tool_events по turn_id,
// читает tool-events.loadTurn) и СОБСТВЕННАЯ последняя реплика Милы. Цены в
// боевом catalogMode лежат прямо в промпте, и ответ о стоимости не оставляет
// в журнале ни одного вызова — поэтому текст реплики сверяется тоже.
//
// Приоритет классов (первое совпадение сверху):
//   modify  — перенос/отмена/правка услуг: продажа поверх отмены бестактна;
//   clarify — hint-ответ create_booking/book_chain: пациент завис на вопросе
//             (препарат, номер, время), а не на мотивации;
//   choice  — показаны времена/специалисты: довод «записаться сейчас»;
//   price   — названа цена или отправлен прайс: самый сильный случай;
//   unknown — всё остальное (справка из КБ, консультация врача). Без довода
//             СОЗНАТЕЛЬНО: медицинский маршрут признака в коде не имеет.
//
// Юнит-тесты: agent-followup-situation.test.js
// ============================================================

const { OPERATOR_MARK } = require('./history');

const MODIFY_TOOLS = new Set(['reschedule_booking', 'cancel_booking', 'modify_booking_services']);
const BOOKING_TOOLS = new Set(['create_booking', 'book_chain']);
const SLOT_TOOLS = new Set(['get_available_slots', 'get_available_dates', 'get_sequential_slots', 'get_parallel_slots']);
const PRICE_TOOLS = new Set(['get_service_masters', 'send_price_list']);
// Hint-ответы write-инструментов (см. isHintResult в tools/reschedule-booking.js
// и ветки create-booking.js): YClients не звался, ход предрешён вопросом.
const HINT_FLAGS = ['needs_phone', 'generic_service_hint', 'too_soon', 'unverified_slot', 'needs_confirmation', 'wrong_service'];
// Ключи непустой выдачи по всем четырём слот-инструментам: slots/offer_slots/
// staff_options/alternative_staff (get_available_slots), variants (sequential),
// starts (parallel), schedule (dates); free_day:true — тоже выбор (половина дня).
const SLOT_KEYS = ['slots', 'offer_slots', 'staff_options', 'alternative_staff', 'variants', 'starts', 'schedule'];

// Закрытый список форм, а не открытый суффикс: `перенос\w*` ловил бы
// «переносицу» (та же готча, что RESCHEDULE_INTENT_RE в reply-guard).
const MODIFY_TEXT_RE = /(?<![\p{L}])(перенес(у|ла|ти|ите|ём|ем)?|перенос(а|е|у|ом)?|отмен(а|у|ю|ить|ила|им|ите|ена|ены|ено)?)(?![\p{L}])/iu;
const PRICE_TEXT_RE = /\d[\d\s ]*\s?(?:₽|руб)/iu;

const BONUS_OK = new Set(['choice', 'price']);

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function nonEmpty(v) { return Array.isArray(v) && v.length > 0; }

function hasHint(result) {
  const r = obj(result);
  return !!r && HINT_FLAGS.some((k) => r[k] === true);
}
function hasSlots(result) {
  const r = obj(result);
  if (!r) return false;
  if (r.free_day === true) return true;
  return SLOT_KEYS.some((k) => nonEmpty(r[k]));
}

/**
 * @param {object} o
 * @param {Array<{tool:string, result:any, is_error:boolean}>} [o.events]
 * @param {string} [o.ownText] последняя реплика Милы (lastOwnReply)
 * @returns {{kind:'modify'|'clarify'|'choice'|'price'|'unknown', bonusOk:boolean}}
 */
function classifySituation({ events = [], ownText = '' } = {}) {
  const evs = Array.isArray(events) ? events.filter(Boolean) : [];
  const text = String(ownText || '');
  const called = (set) => evs.some((e) => set.has(e.tool));
  const calledOk = (set) => evs.some((e) => set.has(e.tool) && !e.is_error);

  let kind = 'unknown';
  if (called(MODIFY_TOOLS) || MODIFY_TEXT_RE.test(text)) kind = 'modify';
  else if (evs.some((e) => BOOKING_TOOLS.has(e.tool) && hasHint(e.result))) kind = 'clarify';
  else if (evs.some((e) => SLOT_TOOLS.has(e.tool) && !e.is_error && hasSlots(e.result))) kind = 'choice';
  else if (calledOk(PRICE_TOOLS) || PRICE_TEXT_RE.test(text)) kind = 'price';
  return { kind, bonusOk: BONUS_OK.has(kind) };
}

/**
 * Последний assistant-блок транскрипта без строк администратора. Транскрипт
 * воркер грузит с keepTrailingAssistant, поэтому реплика Милы стоит последней;
 * если последним оказался клиент — реплики нет (пустая строка).
 */
function lastOwnReply(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const last = arr[arr.length - 1];
  if (!last || last.role !== 'assistant') return '';
  return String(last.content || '').split('\n')
    .filter((line) => !line.includes(OPERATOR_MARK)).join('\n').trim();
}

module.exports = { classifySituation, lastOwnReply, BONUS_OK, MODIFY_TEXT_RE, PRICE_TEXT_RE };
