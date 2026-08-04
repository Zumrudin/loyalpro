'use strict';

// ── Блок «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА» для системного промпта ────────────────
//
// ЗАЧЕМ. Инцидент 2026-08-04 (диалог 79200255591): Мила оформила запись в 23:06,
// в 23:35 её удалили в YClients, а в 23:40 на новый вопрос пациента она ответила
// «вы уже записаны на завтра, 12:00», НЕ вызвав ни одного инструмента. Оба
// доступных ей источника — транскрипт (её же реплика «записала вас…») и блок
// «ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ» (create_booking с created:true) — это ИСТОРИЯ, и об
// отмене они не знают в принципе. Промпт-правило «перед подтверждением сверься с
// list_client_bookings» модель просто проигнорировала.
//
// РЕШЕНИЕ — детерминированный факт вместо правила: живой список будущих записей
// подкладывается в промпт КАЖДЫЙ ход, и история не может ему противоречить.
// Побочно закрывается и штатный случай — администратор перенёс или отменил
// запись в CRM, а Мила об этом не узнала бы никак.
//
// ПУСТОЙ СПИСОК РЕНДЕРИТСЯ ЯВНО. Молчание блока читалось бы моделью как
// «неизвестно», и память снова победила бы; фраза «записей НЕТ» — это то самое
// утверждение, которое обязано перебить журнал.

const { isRecordAlive } = require('./record-liveness');

// Потолок строк. Больше десятка будущих записей у одного пациента — это уже не
// «контекст диалога», а простыня в самом хвосте промпта.
const MAX_LINES = 10;

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false,
});
// День недели считаем в московском календаре, а не в календаре процесса.
const WD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short' });
const WD_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** «05.08 (ср) 12:00» по Москве. null — дату разобрать не удалось. */
function fmtWhen(datetime) {
  const ms = Date.parse(datetime || '');
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const wd = WEEKDAYS[WD_INDEX[WD_FMT.format(d)]] || '';
  return `${DATE_FMT.format(d)}${wd ? ` (${wd})` : ''} ${TIME_FMT.format(d)}`;
}

/**
 * Строки блока из выдачи list_client_bookings.
 *
 * Формат строки: «05.08 (ср) 12:00 — Услуга, Услуга, мастер Имя [record_id 123]».
 * record_id намеренно в строке: он и так нужен модели для cancel_booking /
 * reschedule_booking, а лишний вызов инструмента ради уже известного факта —
 * это лишний ход и лишний повод разъехаться со свежим списком. Запрет
 * показывать id пациенту стоит в тексте самого блока (system-prompt.js).
 *
 * @param {Array<object>} bookings элементы {record_id, datetime, services[], staff_name}.
 * @param {{nowMs?: number}} opts nowMs — «сейчас» хода (прошедшее не показываем).
 * @returns {{lines: string[], dropped: number}} lines пустой = будущих записей нет.
 */
function renderBookings(bookings, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const rows = (Array.isArray(bookings) ? bookings : [])
    // Мёртвое сюда доходить не должно (list_client_bookings уже фильтрует), но
    // предикат общий и стоит копейки — блок не имеет права рекламировать отменённое.
    .filter(b => b && isRecordAlive({ id: b.record_id, attendance: b.attendance, deleted: b.deleted }))
    .map(b => ({ b, ms: Date.parse(b.datetime || '') }))
    .filter(x => Number.isFinite(x.ms) && x.ms >= nowMs)
    .sort((a, x) => a.ms - x.ms);

  const shown = rows.slice(0, MAX_LINES);
  const lines = shown.map(({ b }) => {
    const when = fmtWhen(b.datetime);
    const services = (Array.isArray(b.services) ? b.services : [])
      .map(s => String(s || '').trim()).filter(Boolean).join(', ');
    const parts = [when, services || 'услуга не указана'];
    if (b.staff_name) parts.push(`мастер ${String(b.staff_name).trim()}`);
    return `${parts[0]} — ${parts.slice(1).join(', ')} [record_id ${b.record_id}]`;
  });
  return { lines, dropped: rows.length - shown.length };
}

module.exports = { renderBookings, fmtWhen, MAX_LINES };
