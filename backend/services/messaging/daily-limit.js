'use strict';
// Анти-спам «одно плановое сообщение клиенту в день», ОБЩИЙ для «Отдела заботы»
// и напоминаний о повторном визите. Две независимые очереди со своими воркерами
// легко сложились бы в два сообщения одному человеку в одно утро — «как
// самочувствие» от «Заботы» и «пора повторить» от напоминаний.
//
// Сутки считаются явно по Москве, а не по TZ процесса: сервер сегодня
// Europe/Moscow, но зависеть от этого нельзя (см. правило про AT TIME ZONE
// в CLAUDE.md).
//
// Ответ ОБЕИХ очередей на сработавший лимит — сдвиг на завтра, а не skip:
// плановое сообщение переносится, а не сгорает.

const SENT_TODAY_SQL = `
  SELECT 1 FROM (
    SELECT s.sent_at
      FROM care_touch_sends s
      JOIN care_enrollments e ON e.id = s.enrollment_id
     WHERE e.salon_id = $1 AND e.phone = $2 AND s.status = 'sent'
    UNION ALL
    SELECT q.sent_at
      FROM reminder_queue q
     WHERE q.salon_id = $1 AND q.phone = $2 AND q.status = 'sent'
  ) t
   WHERE (t.sent_at AT TIME ZONE 'Europe/Moscow')::date
       = (NOW() AT TIME ZONE 'Europe/Moscow')::date
   LIMIT 1`;

/** Уходило ли этому телефону плановое сообщение сегодня (любой из очередей). */
async function sentTodayExists(db, salonId, phone) {
  const row = await db.oneOrNone(SENT_TODAY_SQL, [salonId, phone]);
  return !!row;
}

module.exports = { sentTodayExists, SENT_TODAY_SQL };
