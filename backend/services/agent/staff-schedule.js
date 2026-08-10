'use strict';

// ── График мастера: «работает ли он в этот день». Чистый модуль — ни БД, ни HTTP.
//
// ЗАЧЕМ: инцидент 2026-08-10 (79166524647). У главного врача отпуск 12–31.08,
// и get_available_slots на КАЖДУЮ дату отдавал голое `slots: []`. Снаружи это
// неотличимо от «мастер работает, но день расписан», и модель, не получив ни
// одного слова про отпуск, принялась перебирать даты и в итоге выдала окна
// ДРУГОГО мастера за окна запрошенного. Само отсутствие мастера в графике код
// знал и раньше (комментарий в computeStaffSlots: «Пустая сетка = мастер в этот
// день не работает»), но наружу этот факт не отдавал.
//
// Источник — management /schedule, тот же, что у get_available_dates. На боевых
// данных PERI (проверено 10.08.2026) отпуск приезжает ЯВНЫМИ строками
// `{date, is_working: 0, slots: []}`, а не пустым массивом — поэтому «не
// работает» и «API молчит» здесь различимы, и утверждать первое по молчанию не
// приходится.

// Тот же предикат рабочего дня, что в tools/get-available-dates.js: is_working
// плюс НЕПУСТЫЕ смены. Расхождение означало бы, что на вопрос «когда работает»
// и на пустые слоты пациент получает два разных ответа про один и тот же день.
function isWorkingRow(r) {
  return !!(r && r.is_working && Array.isArray(r.slots) && r.slots.length);
}

// rows — выдача ycGetStaffSchedule (массив по дням), opts.date — запрошенный день.
//
// Возвращает:
//   { unknown: true }                     — сетки нет ИЛИ запрошенного дня в ней нет.
//                                           Fail-open: вызывающий не добавляет НИЧЕГО и
//                                           ведёт себя как раньше. Молчание API нельзя
//                                           выдавать за отпуск — это ровно тот класс
//                                           выдуманного отказа от лица клиники, что и
//                                           инцидент 2026-07-31.
//   { unknown:false, working, nextWorkingDate, checkedUntil }
//     working          — мастер работает в этот день;
//     nextWorkingDate  — ближайший рабочий день СТРОГО ПОСЛЕ запрошенного (null, если
//                        до конца выданного окна такого нет). Прошедшие рабочие дни
//                        ближайшими не считаются: пациенту предлагают время вперёд.
//     checkedUntil     — до какой даты реально доехала выдача. Нужен, чтобы «ближайшего
//                        дня нет» не читалось как «мастер не работает никогда»:
//                        окно конечно, и его границу надо назвать.
function summarizeWorkingDays(rows, opts = {}) {
  const date = opts.date;
  if (!Array.isArray(rows) || !rows.length || !date) return { unknown: true };
  const row = rows.find(r => r && r.date === date);
  if (!row) return { unknown: true };
  const working = isWorkingRow(row);
  const dates = rows.map(r => r && r.date).filter(Boolean).sort();
  const nextWorkingDate = rows
    .filter(r => r && r.date > date && isWorkingRow(r))
    .map(r => r.date)
    .sort()[0] || null;
  return {
    unknown: false,
    working,
    nextWorkingDate,
    checkedUntil: dates[dates.length - 1] || date,
  };
}

module.exports = { summarizeWorkingDays, isWorkingRow };
