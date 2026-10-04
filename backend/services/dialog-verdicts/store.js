// backend/services/dialog-verdicts/store.js
'use strict';
// ============================================================
// SQL модуля вердиктов. Множество диалог-дней и критерий «запись в CRM» берутся
// из ОБЩИХ фрагментов services/messenger-stats.js — вторая копия правил означала
// бы, что сумма колонок статусов перестанет сходиться с числом диалогов.
// Все запросы параметризованы; живая проверка — scripts/dialog-verdicts-e2e.js.
// ============================================================
const { DIALOG_KEY_SQL } = require('../chat');
const { PERSONAL_NON_SYSTEM_SQL, phoneFormsSql, recCteSql, BOOKED_CTE_SQL } = require('../messenger-stats');

const { STATUS_CODES, UNANALYZED } = require('./taxonomy');

function getDb() { return require('../../db').db; }

const P10_SQL = `NULLIF(right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10), '')`;

// Диалог-дни периода с max(msg_ts) и текущим вердиктом (если есть).
// $1 salon, $2 from, $3 to. channel/phone — из первого сообщения дня, как в статистике.
const DIALOG_DAYS_SQL = `
WITH m AS (
  SELECT ${DIALOG_KEY_SQL} AS dkey,
         (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date AS d,
         channel, msg_ts, id, NULLIF(phone,'') AS phone
  FROM chatpush_messages
  WHERE salon_id = $1 AND msg_ts IS NOT NULL
    AND (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
    AND ${PERSONAL_NON_SYSTEM_SQL}
),
dd AS (
  SELECT DISTINCT ON (dkey, d) dkey, d, channel AS first_channel, phone
  FROM m ORDER BY dkey, d, msg_ts, id
),
agg AS (SELECT dkey, d, max(msg_ts) AS max_ts FROM m GROUP BY dkey, d)
SELECT dd.dkey, to_char(dd.d, 'YYYY-MM-DD') AS day, dd.first_channel AS channel, dd.phone,
       agg.max_ts::text AS max_ts,
       v.id AS verdict_id, v.source_max_ts::text AS source_max_ts, v.taxonomy_version, v.status
FROM dd JOIN agg USING (dkey, d)
LEFT JOIN dialog_verdicts v ON v.salon_id = $1 AND v.dialog_key = dd.dkey AND v.day = dd.d
ORDER BY dd.d DESC, dd.dkey`;

async function listDialogDays(salonId, from, to, db = getDb()) {
  return db.any(DIALOG_DAYS_SQL, [salonId, from, to]);
}

// Сообщения диалогов пачки: хвост до 14 дней назад (render режет до 10 сообщений),
// сам день и следующий (для notified). Служебные (system) ВКЛЮЧЕНЫ.
// $1 salon, $2 keys text[], $3 day.
const MESSAGES_SQL = `
SELECT ${DIALOG_KEY_SQL} AS dkey, direction, authored_by, text, msg_type, msg_ts,
       to_char((to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day
FROM chatpush_messages
WHERE salon_id = $1 AND msg_ts IS NOT NULL
  AND ${DIALOG_KEY_SQL} = ANY($2::text[])
  AND (to_timestamp(msg_ts) AT TIME ZONE 'Europe/Moscow')::date BETWEEN ($3::date - 14) AND ($3::date + 1)
ORDER BY msg_ts ASC, id ASC`;

async function loadMessages(salonId, keys, day, db = getDb()) {
  if (!keys.length) return [];
  return db.any(MESSAGES_SQL, [salonId, keys, day]);
}

// Запись в CRM, созданная в этот день, у клиентов пачки — тот же критерий, что в
// статистике (общие CTE rec/booked). $1 salon, $2 keys text[], $3 day, $4 phones text[]
// (параллельно keys; '' у диалогов без номера).
const BOOKED_CRM_SQL = `
WITH k AS (
  SELECT t.dkey, ${P10_SQL} AS p10
  FROM unnest($2::text[], $4::text[]) AS t(dkey, phone)
),
cl AS (
  SELECT k.dkey, $3::date AS d, c.id AS client_id, c.yclients_client_id
  FROM k JOIN clients c
    ON c.salon_id = $1 AND k.p10 IS NOT NULL AND c.phone = ANY (${phoneFormsSql('k.p10')})
),
rec AS (${recCteSql({ salon: '$1', from: '$3', to: '$3' })}
),
booked AS (${BOOKED_CTE_SQL}
)
SELECT DISTINCT dkey FROM booked`;

async function loadBookedCrm(salonId, keys, day, phones, db = getDb()) {
  if (!keys.length) return new Set();
  const rows = await db.any(BOOKED_CRM_SQL, [salonId, keys, day, phones.map(p => p || '')]);
  return new Set(rows.map(r => r.dkey));
}

// rows: [{dialog_key, channel, phone, day, status, label, note, notified, booked_crm,
//         taxonomy_version, model, run_id, source_max_ts}]
async function upsertVerdicts(salonId, rows, db = getDb()) {
  if (!rows.length) return 0;
  const cols = ['dialog_key', 'channel', 'phone', 'day', 'status', 'label', 'note', 'notified', 'booked_crm',
    'taxonomy_version', 'model', 'run_id', 'source_max_ts'];
  const values = [];
  const params = [salonId];
  for (const r of rows) {
    const ph = cols.map(c => { params.push(r[c] == null ? null : r[c]); return '$' + params.length; });
    values.push(`($1, ${ph.join(', ')})`);
  }
  const res = await db.query(`
    INSERT INTO dialog_verdicts (salon_id, ${cols.join(', ')})
    VALUES ${values.join(',\n')}
    ON CONFLICT (salon_id, dialog_key, day) DO UPDATE SET
      channel = EXCLUDED.channel, phone = EXCLUDED.phone, status = EXCLUDED.status,
      label = EXCLUDED.label, note = EXCLUDED.note, notified = EXCLUDED.notified,
      booked_crm = EXCLUDED.booked_crm, taxonomy_version = EXCLUDED.taxonomy_version,
      model = EXCLUDED.model, run_id = EXCLUDED.run_id, source_max_ts = EXCLUDED.source_max_ts,
      updated_at = NOW()`, params);
  return res.rowCount || 0;
}

async function createRun({ salonId, trigger, from, to, recompute }, db = getDb()) {
  const r = await db.one(`
    INSERT INTO dialog_verdict_runs (salon_id, trigger, period_from, period_to, recompute)
    VALUES ($1, $2, $3, $4, $5) RETURNING id`, [salonId, trigger, from, to, !!recompute]);
  if (!r) throw new Error('VERDICT_RUN_CREATE_FAILED');
  return r.id;
}

async function finishRun(salonId, runId, { status, requested = 0, analyzed = 0, failed = 0, batches = 0, model = null, error = null }, db = getDb()) {
  await db.query(`
    UPDATE dialog_verdict_runs SET status = $2, requested = $3, analyzed = $4, failed = $5, batches = $6,
      model = $7, error = $8, finished_at = NOW() WHERE id = $1 AND salon_id = $9`,
  [runId, status, requested, analyzed, failed, batches, model, error, salonId]);
}

// Промежуточный прогресс для строки под кнопкой (опрос раз в 5 с).
async function progressRun(salonId, runId, { requested, analyzed, failed, batches, model }, db = getDb()) {
  await db.query(`UPDATE dialog_verdict_runs SET requested=$2, analyzed=$3, failed=$4, batches=$5, model=$6 WHERE id=$1 AND salon_id=$7`,
    [runId, requested, analyzed, failed, batches, model, salonId]);
}

async function listRuns(salonId, limit = 5, db = getDb()) {
  return db.any(`
    SELECT id, trigger, to_char(period_from,'YYYY-MM-DD') AS period_from, to_char(period_to,'YYYY-MM-DD') AS period_to,
           recompute, status, requested, analyzed, failed, batches, model, error, started_at, finished_at
    FROM dialog_verdict_runs WHERE salon_id = $1 ORDER BY id DESC LIMIT $2`, [salonId, Math.min(50, Math.max(1, limit | 0))]);
}

// При старте процесса: прогон, оборванный рестартом, не должен висеть running вечно.
async function closeStaleRuns(salonId, db = getDb()) {
  const r = await db.query(`UPDATE dialog_verdict_runs SET status='error', error='процесс перезапущен во время прогона',
    finished_at=NOW() WHERE status='running' AND salon_id=$1`, [salonId]);
  return r?.rowCount || 0;
}

// Derive drill-down from today's same dialog-day set as the summary, including
// removed/legacy taxonomy codes and a changed first channel after delayed echo.
async function listVerdicts(salonId, { from, to, channel, status, limit = 500 }, db = getDb()) {
  limit = Math.min(500, Math.max(1, Number(limit) || 500));
  const rows = await db.any(`
    WITH days AS (${DIALOG_DAYS_SQL}), detail AS (
      SELECT d.dkey AS dialog_key, d.channel, d.day, d.phone,
             CASE WHEN v.id IS NULL THEN 'unanalyzed'
                  WHEN v.status = ANY($7::text[]) THEN v.status ELSE 'other' END AS status,
             v.label, v.note, COALESCE(v.notified, false) AS notified,
             COALESCE(v.booked_crm, false) AS booked_crm,
             (SELECT c.name FROM clients c
              WHERE c.salon_id = $1 AND x.p10 IS NOT NULL
                AND c.phone = ANY (${phoneFormsSql('x.p10')})
              ORDER BY c.id LIMIT 1) AS name
      FROM days d
      LEFT JOIN dialog_verdicts v ON v.salon_id=$1 AND v.dialog_key=d.dkey AND v.day=d.day::date
      CROSS JOIN LATERAL (SELECT NULLIF(right(regexp_replace(COALESCE(d.phone,''), '\\D', '', 'g'), 10), '') AS p10) x
      WHERE ($4::text = '' OR d.channel = $4)
    )
    SELECT * FROM detail WHERE status=$5 ORDER BY day DESC, dialog_key LIMIT $6`,
    [salonId, from, to, channel || '', status, limit + 1, STATUS_CODES]);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

async function listUnanalyzed(salonId, opts, db = getDb()) {
  return listVerdicts(salonId, { ...opts, status: UNANALYZED }, db);
}

module.exports = {
  listDialogDays, loadMessages, loadBookedCrm, upsertVerdicts,
  createRun, finishRun, progressRun, listRuns, closeStaleRuns,
  listVerdicts, listUnanalyzed,
  DIALOG_DAYS_SQL, MESSAGES_SQL, BOOKED_CRM_SQL,
};
