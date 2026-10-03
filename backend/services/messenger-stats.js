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
// 'deleted'. records.created_at для этого не годится: это время вставки нашей
// строки (у source='sync' — время синка).
// ============================================================

const CHANNEL_LABELS = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };

function channelLabel(channel) {
  if (channel == null || channel === '') return '—';
  return Object.hasOwn(CHANNEL_LABELS, channel) ? CHANNEL_LABELS[channel] : String(channel);
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

const { DIALOG_KEY_SQL } = require('./chat');

// $1 salon_id, $2 from 'YYYY-MM-DD', $3 to 'YYYY-MM-DD' (включительно, мск).
// Экспортируется ради живого EXPLAIN ANALYZE на дев-БД (как LEASE_SQL воркеров).
// Телефон клиента сверяется по последним 10 цифрам: в clients лежит '+7…',
// в chatpush_messages — '7…' без плюса. records.status NULL не бывает
// (проверено на деве: 0 из 13 612), поэтому `<> 'deleted'` без COALESCE.
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
firsts AS (
  SELECT DISTINCT ON (dkey, d) dkey, d, direction AS first_dir, channel AS first_channel
  FROM m ORDER BY dkey, d, msg_ts, id
),
phones AS (
  SELECT dkey, d, max(p10) AS p10 FROM m GROUP BY dkey, d
),
dd AS (
  SELECT f.dkey, f.d, f.first_dir, f.first_channel, p.p10
  FROM firsts f JOIN phones p USING (dkey, d)
),
cl AS (
  SELECT dd.dkey, dd.d, c.id AS client_id, c.yclients_client_id
  FROM dd JOIN clients c
    ON c.salon_id = $1 AND dd.p10 IS NOT NULL
   AND c.phone = ANY (ARRAY['+7' || dd.p10, '7' || dd.p10, '8' || dd.p10, dd.p10])
),
rec AS (
  SELECT r.client_id, r.yclients_client_id,
         left(r.raw_payload->>'create_date', 10) AS cd,
         EXISTS (SELECT 1 FROM agent_events e
                  WHERE e.salon_id = r.salon_id AND e.kind = 'booking_created'
                    AND e.payload->>'record_id' = r.yclients_record_id::text) AS by_agent
  FROM records r
  WHERE r.salon_id = $1 AND r.status <> 'deleted'
    -- ::text обязателен: pg уже вывел тип $2/$3 как date из CTE m, без него «text >= date».
    AND left(r.raw_payload->>'create_date', 10) BETWEEN $2::text AND $3::text
),
flags AS (
  SELECT dd.*,
    EXISTS (SELECT 1 FROM cl JOIN rec
              ON rec.client_id = cl.client_id
              OR (rec.yclients_client_id IS NOT NULL AND rec.yclients_client_id = cl.yclients_client_id)
            WHERE cl.dkey = dd.dkey AND cl.d = dd.d AND rec.cd = dd.d::text) AS booked,
    EXISTS (SELECT 1 FROM cl JOIN rec
              ON rec.client_id = cl.client_id
              OR (rec.yclients_client_id IS NOT NULL AND rec.yclients_client_id = cl.yclients_client_id)
            WHERE cl.dkey = dd.dkey AND cl.d = dd.d AND rec.cd = dd.d::text AND rec.by_agent) AS booked_by_agent
  FROM dd
)
SELECT d::text AS date, first_channel AS channel,
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

module.exports = { summarize, channelLabel, eachDate, CHANNEL_LABELS, MESSENGER_STATS_SQL, loadMessengerStats };
