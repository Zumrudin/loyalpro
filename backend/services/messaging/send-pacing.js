'use strict';
// Темп плановых отправок: «не чаще одного сообщения раз в N минут». Счётчик
// ОБЩИЙ на обе плановые очереди салона — напоминания о повторном визите и
// касания «Заботы»: WhatsApp блокирует НОМЕР, а не правило, поэтому считать
// надо всё, что уходит с одного инстанса Chatpush. Тот же UNION, что в
// соседнем daily-limit.js («1 плановое сообщение клиенту в день»), только
// без фильтра по телефону: тут ограничивается темп, а не адресат.
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
// Ждёт интервал ТОЛЬКО воркер напоминаний. Касания «Заботы» в счётчик
// ВХОДЯТ (напоминание не уйдёт вплотную за касанием), но сам care-воркер
// паузу не держит: у программ «Заботы» такой настройки нет, и добавлять её
// в модуль, который сейчас не трогаем, было бы лишним. Зазор известен:
// программа с большим числом касаний на одно утро отправит их пачкой.

const LAST_SENT_SQL = `
  SELECT max(t.sent_at) AS last_at FROM (
    SELECT s.sent_at
      FROM care_touch_sends s
      JOIN care_enrollments e ON e.id = s.enrollment_id
     WHERE e.salon_id = $1 AND s.status = 'sent'
    UNION ALL
    SELECT q.sent_at
      FROM reminder_queue q
     WHERE q.salon_id = $1 AND q.status = 'sent'
  ) t`;

/** Когда салон последний раз отправлял плановое сообщение. Date | null. */
async function lastPlannedSendAt(db, salonId) {
  const row = await db.oneOrNone(LAST_SENT_SQL, [salonId]);
  return row && row.last_at ? new Date(row.last_at) : null;
}

/**
 * Сколько миллисекунд ещё ждать до следующей отправки. 0 — можно слать.
 * Fail-open на мусорном входе: темп — это защита от блокировки мессенджера,
 * а не гейт допуска, и битое значение не должно останавливать очередь.
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
  return left > 0 ? left : 0;
}

module.exports = { lastPlannedSendAt, waitMsLeft, LAST_SENT_SQL };
