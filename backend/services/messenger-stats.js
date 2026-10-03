// backend/services/messenger-stats.js
'use strict';
// ============================================================
// Статистика переписок в мессенджерах для дашборда.
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md
//
// Единица счёта — ДИАЛОГ-ДЕНЬ (собеседник + московская дата), автоуведомления
// (authored_by='system') и групповые чаты не считаются. «Клиент написал
// первым» — первое неслужебное сообщение дня входящее. «Записался в тот же
// день» — у клиента с этим телефоном есть запись YClients, СОЗДАННАЯ в этот
// день (raw_payload->>'create_date', московское локальное время), статус не
// 'deleted'. records.created_at как ДЕНЬ записи не годится: это время вставки
// нашей строки (у source='sync' — время синка), — но как НИЖНЯЯ ГРАНИЦА
// выборки годится и в SQL ниже используется (см. комментарий у CTE rec).
// ============================================================

const { DIALOG_KEY_SQL } = require('./chat');

const CHANNEL_LABELS = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };

function channelLabel(channel) {
  if (channel == null || channel === '') return '—';
  return Object.hasOwn(CHANNEL_LABELS, channel) ? CHANNEL_LABELS[channel] : String(channel);
}

// Ряд по дням строится в памяти (eachDate), поэтому длину периода ограничиваем.
const MAX_PERIOD_DAYS = 731;
function periodDays(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}

// Перечисление дат включительно; арифметика в UTC — та же, что в resolvePeriod
// (routes/api.js), чтобы локальная TZ сервера не влияла на перечисление.
function eachDate(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dateKey(v) {
  // pg отдаёт DATE как Date в ЛОКАЛЬНУЮ полночь (TZ сервера Europe/Moscow) — ISO-строка дала бы вчера.
  if (v instanceof Date) {
    const p = x => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

const num = v => Number(v) || 0;

function emptyStat() {
  return { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 };
}

function addRow(acc, r) {
  acc.dialogs += num(r.dialogs);
  acc.clientFirst += num(r.client_first);
  acc.clientFirstNoPhone += num(r.client_first_no_phone);
  acc.bookedSameDay += num(r.booked_same_day);
  acc.bookedByAgent += num(r.booked_by_agent);
}

// rows: [{date, channel, dialogs, client_first, client_first_no_phone, booked_same_day, booked_by_agent}]
function summarize(rows, { from, to }) {
  const totals = emptyStat();
  const byChannelMap = new Map();
  const byDay = new Map(eachDate(from, to).map(d => [d, { date: d, clientFirst: 0, bookedSameDay: 0 }]));

  for (const r of rows || []) {
    addRow(totals, r);
    const ch = r.channel == null ? '' : String(r.channel);
    if (!byChannelMap.has(ch)) byChannelMap.set(ch, { channel: ch, label: channelLabel(ch), ...emptyStat() });
    addRow(byChannelMap.get(ch), r);
    const day = byDay.get(dateKey(r.date));
    if (day) { day.clientFirst += num(r.client_first); day.bookedSameDay += num(r.booked_same_day); }
  }

  const byChannel = [...byChannelMap.values()]
    .sort((a, b) => (b.dialogs - a.dialogs) || a.channel.localeCompare(b.channel));

  return { period: { from, to }, totals, byChannel, daily: [...byDay.values()] };
}

// $1 salon_id, $2 from 'YYYY-MM-DD', $3 to 'YYYY-MM-DD' (включительно, мск).
// Экспортируется ради живого EXPLAIN ANALYZE на дев-БД (как LEASE_SQL воркеров):
// scripts/messenger-stats-explain.js. Порог спеки — ≤300 мс на месячном периоде.
// Телефон клиента сверяется по последним 10 цифрам: в clients лежит '+7…',
// в chatpush_messages — '7…' без плюса. День везде сравнивается как текст через
// to_char(d,'YYYY-MM-DD'), а не d::text — тот зависит от DateStyle сессии.
const MESSENGER_STATS_SQL = `
WITH m AS (
  SELECT
    ${DIALOG_KEY_SQL} AS dkey,
    (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date AS d,
    channel, direction, msg_ts, id,
    NULLIF(right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10), '') AS p10
  FROM chatpush_messages
  WHERE salon_id = $1
    AND msg_ts IS NOT NULL
    AND (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
    AND COALESCE(chat_id,'') NOT LIKE '-%'
    AND COALESCE(chat_id,'') NOT LIKE '%@g.us'
    AND COALESCE(chat_id,'') NOT LIKE '%@broadcast'
    AND COALESCE(authored_by,'') <> 'system'
),
-- p10 берётся из первого сообщения дня: по построению DIALOG_KEY_SQL dkey = phone,
-- когда номер есть, поэтому у всех сообщений диалог-дня p10 один и тот же.
dd AS (
  SELECT DISTINCT ON (dkey, d) dkey, d, direction AS first_dir, channel AS first_channel, p10
  FROM m ORDER BY dkey, d, msg_ts, id
),
cl AS (
  SELECT dd.dkey, dd.d, c.id AS client_id, c.yclients_client_id
  FROM dd JOIN clients c
    ON c.salon_id = $1 AND dd.p10 IS NOT NULL
   AND c.phone = ANY (ARRAY['+7' || dd.p10, '7' || dd.p10, '8' || dd.p10, dd.p10])
),
-- created_at не годится как ДЕНЬ записи (время вставки нашей строки), но годится
-- как НИЖНЯЯ граница: строка не может появиться раньше create_date; запас сутки
-- на расхождение часов. Без этой границы rec читает весь records с детоастом
-- raw_payload (O(всех записей), ~130 мс на 13 тыс. строк).
rec AS (
  SELECT r.client_id, r.yclients_client_id,
         left(r.raw_payload->>'create_date', 10) AS cd,
         EXISTS (SELECT 1 FROM agent_events e
                  WHERE e.salon_id = r.salon_id AND e.kind = 'booking_created'
                    AND e.payload->>'record_id' = r.yclients_record_id::text) AS by_agent
  FROM records r
  WHERE r.salon_id = $1 AND COALESCE(r.status,'') <> 'deleted'
    AND r.created_at >= ($2::date::timestamp AT TIME ZONE 'Europe/Moscow') - interval '1 day'
    -- ::text обязателен: pg уже вывел тип $2/$3 как date из CTE m, без него «text >= date».
    AND left(r.raw_payload->>'create_date', 10) BETWEEN $2::text AND $3::text
),
-- MATERIALIZED обязателен (PG ≥ 12): без него планировщик перезапускает агрегат
-- на каждый диалог-день (loops ≈ число диалог-дней), и выигрыша перед
-- коррелированными EXISTS нет.
booked AS MATERIALIZED (
  SELECT x.dkey, x.d, bool_or(x.by_agent) AS by_agent FROM (
    SELECT cl.dkey, cl.d, rec.by_agent FROM cl JOIN rec
      ON rec.client_id = cl.client_id AND rec.cd = to_char(cl.d, 'YYYY-MM-DD')
    UNION ALL
    SELECT cl.dkey, cl.d, rec.by_agent FROM cl JOIN rec
      ON rec.yclients_client_id = cl.yclients_client_id AND rec.cd = to_char(cl.d, 'YYYY-MM-DD')
  ) x GROUP BY x.dkey, x.d
),
flags AS (
  SELECT dd.*, (b.dkey IS NOT NULL) AS booked, COALESCE(b.by_agent, false) AS booked_by_agent
  FROM dd LEFT JOIN booked b USING (dkey, d)
)
SELECT to_char(d, 'YYYY-MM-DD') AS date, first_channel AS channel,
  COUNT(*)::int AS dialogs,
  COUNT(*) FILTER (WHERE first_dir = 'incoming')::int AS client_first,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND p10 IS NULL)::int AS client_first_no_phone,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND booked)::int AS booked_same_day,
  COUNT(*) FILTER (WHERE first_dir = 'incoming' AND booked_by_agent)::int AS booked_by_agent
FROM flags
GROUP BY d, first_channel
ORDER BY d, first_channel`;

async function loadMessengerStats(salonId, from, to, deps = {}) {
  const db = deps.db || require('../db').db;
  return db.any(MESSENGER_STATS_SQL, [salonId, from, to]);
}

module.exports = { summarize, channelLabel, eachDate, periodDays, MAX_PERIOD_DAYS, CHANNEL_LABELS, MESSENGER_STATS_SQL, loadMessengerStats };
