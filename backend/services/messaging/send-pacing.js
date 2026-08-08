'use strict';
// Темп плановых отправок: «не чаще одного сообщения раз в N минут». Счётчик
// ОБЩИЙ на ВСЕ ТРИ плановые очереди салона — напоминания о повторном визите,
// касания «Заботы» и автоуведомления (`notification_sends`): WhatsApp
// блокирует НОМЕР, а не правило или очередь, поэтому считать надо всё, что
// уходит с одного инстанса Chatpush. Тот же UNION, что в соседнем
// daily-limit.js («1 плановое сообщение клиенту в день»), только без фильтра
// по телефону: тут ограничивается темп, а не адресат.
//
// ЧЕГО ЭТА ПРОВЕРКА НЕ ДАЁТ:
//  - это чтение перед действием без блокировки, и защита ПРОЦЕССНАЯ (прод —
//    один инстанс pm2 fork), тот же класс, что _tickInFlight воркера;
//  - между проверкой и реальной отправкой проходит LLM-проход (до 60с в
//    режиме free), поэтому фактический интервал может оказаться БОЛЬШЕ
//    настроенного — ошибка в безопасную сторону;
//  - строка, откатившаяся из 'sent' обратно в 'scheduled' (сбой отправки),
//    чистит sent_at и из счётчика выпадает: темп на шаг ускорится, но
//    сообщение по ней и не ушло.
//
// Ждёт интервал ТОЛЬКО воркер напоминаний. Касания «Заботы» и автоуведомления
// в счётчик ВХОДЯТ (напоминание не уйдёт вплотную за ними — воркер
// автоуведомлений арендует до 10 строк за тик, это источник пачки КРУПНЕЕ
// обеих плановых очередей), но сами эти два воркера паузу НЕ держат: у
// программ «Заботы» настройки темпа нет, а автоуведомление («Вы записаны на
// приём», «Напоминаем о визите») — транзакционное сообщение по конкретному
// событию, откладывать его ради темпа нельзя. Асимметрия осознанная: обе
// очереди читаются в счётчик, но троттлится только напоминания.
//
// Fail-open и fail-closed здесь — про РАЗНЫЕ ситуации, путать нельзя:
// waitMsLeft сама fail-open — мусорное (но ПРОЧИТАННОЕ) значение lastAt/
// intervalMin не должно останавливать отправку. А вот решение о том, что
// делать, если lastPlannedSendAt НЕ ПРОЧИТАЛСЯ вовсе (упал запрос к БД),
// принимает вызывающий — воркер напоминаний там fail-CLOSED (не смог
// прочитать счётчик → откладывает строку, а не шлёт вслепую).

// greatest() от ТРЁХ отдельных max(), а не max() поверх UNION ALL: под каждую
// из трёх очередей заведён частичный индекс (salon_id, sent_at DESC) WHERE
// status='sent', но агрегат над UNION PostgreSQL к «взять первую строку
// индекса» не сводит — живой EXPLAIN ANALYZE показывал Append со сканом ВСЕХ
// строк status='sent' каждой таблицы. Три скалярных подзапроса превращаются в
// InitPlan → Limit → Index Only Scan, то есть по одной строке на таблицу.
// greatest() игнорирует NULL-аргументы; все три NULL → NULL — это штатное
// «салон ещё ничего не слал», его разбирает lastPlannedSendAt.
const LAST_SENT_SQL = `
  SELECT greatest(
    (SELECT max(s.sent_at) FROM care_touch_sends s
      WHERE s.salon_id = $1 AND s.status = 'sent'),
    (SELECT max(q.sent_at) FROM reminder_queue q
      WHERE q.salon_id = $1 AND q.status = 'sent'),
    (SELECT max(n.sent_at) FROM notification_sends n
      WHERE n.salon_id = $1 AND n.status = 'sent')
  ) AS last_at`;

/** Когда салон последний раз отправлял плановое сообщение. Date | null. */
async function lastPlannedSendAt(db, salonId) {
  const row = await db.oneOrNone(LAST_SENT_SQL, [salonId]);
  return row && row.last_at ? new Date(row.last_at) : null;
}

// ── потолок по времени суток ───────────────────────────────────────────────
// Пауза темпа сдвигает строку от NOW(), поэтому send_time правила после
// первого же отката теряется навсегда, а окно расписания Милы для плановых
// напоминаний намеренно выключено (ignoreSchedule) — ровно с обоснованием
// «время задаёт САМ салон в send_time». Без потолка темп это обоснование
// молча отменял: send_time='11:00' + пауза 30 мин + кап догона 30 строк дают
// пропускную способность 1 строка/30 мин, то есть хвост рассылки уходит около
// 02:00 живым пациентам (при 120 мин — несколько суток круглосуточно).
//
// Окно 09:00–21:00 мск (начало включительно, конец исключительно) — тот же
// дневной ориентир, что дефолт AGENT_ADMIN_HOURS ('09:00-21:00', окно
// присутствия живого администратора в services/agent/admin-hours.js).
const DAY_WINDOW_START_MIN = 9 * 60;
const DAY_WINDOW_END_MIN = 21 * 60;

// Москва без перевода часов — МСК фиксируется смещением +03:00, как в
// services/care/schedule.js (там же приём с «календарной» арифметикой).
const MSK_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 86400000;

/** Минут от начала МОСКОВСКИХ суток для момента ms. */
function mskMinutesOfDay(ms) {
  return Math.floor((((ms + MSK_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000);
}

/** 'HH:MM' (допускается хвост ':SS' — pg отдаёт time как '11:00:00') → минуты. */
function parseHhMm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(String(s == null ? '' : s).trim());
  return m ? +m[1] * 60 + +m[2] : null;
}

function inDayWindow(minOfDay) {
  return minOfDay >= DAY_WINDOW_START_MIN && minOfDay < DAY_WINDOW_END_MIN;
}

/**
 * На сколько МИНУТ откладывать строку с учётом потолка по времени суток.
 * Чистая: время приходит параметром, БД не трогает.
 *
 *  - момент отправки (now + waitMs) попадает В дневное окно → ждём waitMs;
 *  - попадает ВНЕ окна → переносим на ближайшее наступление send_time правила;
 *  - send_time САМ лежит вне окна → потолок не применяется вовсе: салон выбрал
 *    это время осознанно, и переопределять его мы не вправе. Тем же путём идёт
 *    непарсящийся send_time (fail-open: потолок — удобство пациента, а не
 *    гейт допуска, и битое значение не должно менять расписание рассылки).
 *
 * «Ближайшее наступление» считается от МОМЕНТА ОТПРАВКИ, а не от now: иначе в
 * узкой полосе (now=19:00, send_time=20:00, пауза 120 мин) потолок вернул бы
 * 60 минут, то есть СОКРАТИЛ бы паузу темпа — ровно ту пачку, от которой всё
 * и защищает. Пауза темпа не укорачивается никогда, потолок только удлиняет.
 *
 * @param {number} nowMs   текущее время, мс
 * @param {number} waitMs  остаток паузы темпа (waitMsLeft), мс
 * @param {string} sendTime 'HH:MM' правила (мск)
 * @returns {number} минут (может быть дробным — округляет вызывающий)
 */
function paceDeferMinutes(nowMs, waitMs, sendTime) {
  const wait = Math.max(0, Number(waitMs) || 0);
  const waitMin = wait / 60000;
  const sendMin = parseHhMm(sendTime);
  if (sendMin == null || !inDayWindow(sendMin)) return waitMin;

  const target = nowMs + wait;
  if (inDayWindow(mskMinutesOfDay(target))) return waitMin;

  // Начало МОСКОВСКИХ суток, в которые попал момент отправки.
  const dayStartMs = Math.floor((target + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;
  let at = dayStartMs + sendMin * 60000;
  if (at < target) at += DAY_MS; // send_time этих суток уже позади — завтра
  return (at - nowMs) / 60000;
}

/**
 * Сколько миллисекунд ещё ждать до следующей отправки. 0 — можно слать.
 * Fail-open на мусорном входе: темп — это защита от блокировки мессенджера,
 * а не гейт допуска, и битое значение не должно останавливать очередь.
 *
 * Результат ограничен сверху самим интервалом: sent_at пишет БД (Beget),
 * nowMs — часы приложения, и это разные машины. Один «будущий» sent_at
 * (рассинхрон часов, битая запись) не должен отодвигать отправку на
 * произвольный срок — ждать дольше настроенного интервала бессмысленно.
 *
 * @param {Date|string|null} lastAt   время последней плановой отправки
 * @param {number} intervalMin        пауза из правила (0 — без паузы)
 */
function waitMsLeft(lastAt, intervalMin, nowMs = Date.now()) {
  const mins = Number(intervalMin);
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  if (lastAt == null) return 0;
  const last = lastAt instanceof Date ? lastAt.getTime() : Date.parse(lastAt);
  if (!Number.isFinite(last)) return 0;
  const left = last + mins * 60000 - nowMs;
  return Math.min(Math.max(left, 0), mins * 60000);
}

module.exports = {
  lastPlannedSendAt, waitMsLeft, paceDeferMinutes, LAST_SENT_SQL,
  DAY_WINDOW_START_MIN, DAY_WINDOW_END_MIN,
};
