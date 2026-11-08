'use strict';
// SQL дашборда «Документов» и страницы пациента. Всё ограничено salon_id. Паспорт здесь НЕ
// расшифровывается: полнота данных считается по secure_fields (какие поля заполнены).
// DATE-колонки — через to_char (pg отдаёт DATE полуночью по Москве, toISOString дал бы вчера).
const { db } = require('../../db');

// Удалённые записи и неявки на дашборд не попадают: документы им не нужны.
const LIVE_RECORD = `COALESCE(r.status, '') NOT IN ('deleted', 'no_show') AND NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)`;
const RECORD_FIELDS = `r.id, r.client_id, r.yclients_record_id, r.services, r.staff, r.status,
  to_char(r.visit_date, 'YYYY-MM-DD') AS visit_date, r.visit_datetime AS visit_at,
  (r.raw_payload->>'attendance') AS attendance, (r.raw_payload->>'paid_full') AS paid_full`;
// Вид документа: из строки документа; у старых строк до миграции — из шаблона.
const DOC_SELECT = `SELECT p.client_id, d.package_id, COALESCE(d.kind, t.kind) AS kind, d.title, p.status AS package_status,
    p.record_id, p.source, p.created_at, p.sent_at, p.signed_at, p.last_error
  FROM edoc_documents d JOIN edoc_packages p ON p.id = d.package_id
  LEFT JOIN edoc_templates t ON t.id = d.template_id`;

/** Записи окна дашборда с пациентом; has_prior_visit — была ли у пациента состоявшаяся запись раньше этого дня. */
const BOARD_RECORDS_SQL = `
  SELECT ${RECORD_FIELDS}, c.name AS client_name, c.phone AS client_phone,
    EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
            AND p.status = 'arrived' AND p.visit_date < r.visit_date) AS has_prior_visit
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.visit_date BETWEEN $2::date AND $3::date AND ${LIVE_RECORD}
  ORDER BY r.visit_datetime NULLS LAST, r.id`;
async function listBoardRecords(salonId, from, to) {
  return db.any(BOARD_RECORDS_SQL, [salonId, from, to]);
}

async function listDocsForClients(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(`${DOC_SELECT} WHERE p.salon_id = $1 AND p.client_id = ANY($2::int[])`, [salonId, clientIds]);
}

async function listIdentitiesForClients(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT client_id, last_name, first_name, middle_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, gender, phone, email,
            contract_no, to_char(contract_date, 'YYYY-MM-DD') AS contract_date, secure_fields
     FROM client_identity WHERE salon_id = $1 AND client_id = ANY($2::int[])`,
    [salonId, clientIds],
  );
}

/** Последняя анкета каждого пациента (при равном времени — действующая: она и есть текущая). */
async function listLatestForms(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT DISTINCT ON (client_id) id, client_id, record_id, status, source, created_at, expires_at, delivered_via, delivered_at,
            opened_at, submitted_at, package_id, last_error
     FROM edoc_patient_forms WHERE salon_id = $1 AND client_id = ANY($2::int[])
     ORDER BY client_id, created_at DESC, (status = 'active') DESC`,
    [salonId, clientIds],
  );
}

/** Свежие (3 суток) строки журнала автоматики — по последней на пару «вид × запись». */
async function listAutoNotes(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT DISTINCT ON (client_id, kind, record_id) client_id, record_id, kind, status, reason, created_at
     FROM edoc_auto_jobs WHERE salon_id = $1 AND client_id = ANY($2::int[]) AND created_at > NOW() - INTERVAL '3 days'
     ORDER BY client_id, kind, record_id, created_at DESC`,
    [salonId, clientIds],
  );
}

// «Вся база»: флаги по каждому пациенту. Незакрытые акты — состоявшиеся оплаченные визиты с
// acts_required_from без подписанного акта (того же правила, что и карточки дашборда).
const BASE_FILTERS = {
  all: '',
  no_contract: 'AND NOT COALESCE(dc.contract_signed, false)',
  no_consent: 'AND NOT COALESCE(dc.consent_signed, false)',
  open_acts: 'AND COALESCE(a.open_acts, 0) > 0',
  pending: 'AND COALESCE(dc.pending, false)',
  ready: 'AND COALESCE(dc.contract_signed, false) AND COALESCE(dc.consent_signed, false) AND COALESCE(a.open_acts, 0) = 0',
};
async function listBaseClients(salonId, { search = '', filter = 'all', actsFrom = null, limit = 50, offset = 0 } = {}) {
  const params = [salonId, actsFrom];
  let where = '';
  const s = String(search || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4) {
    params.push(`%${digits.slice(-10)}%`);
    where = `AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $${params.length}`;
  } else if (s.length >= 2) {
    params.push(`%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where = `AND c.name ILIKE $${params.length}`;
  }
  params.push(limit, offset);
  return db.any(
    `WITH dc AS (
       SELECT p.client_id,
         bool_or(COALESCE(d.kind, t.kind) = 'contract' AND p.status IN ('signed', 'paper')) AS contract_signed,
         bool_or(COALESCE(d.kind, t.kind) = 'consent_pd' AND p.status IN ('signed', 'paper')) AS consent_signed,
         bool_or(p.status = 'sent') AS pending
       FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id LEFT JOIN edoc_templates t ON t.id = d.template_id
       WHERE p.salon_id = $1 GROUP BY p.client_id
     ), a AS (
       SELECT r.client_id, count(*)::int AS open_acts FROM records r
       WHERE r.salon_id = $1 AND r.status = 'arrived' AND (r.raw_payload->>'paid_full') = '1'
         AND r.visit_date >= COALESCE($2::date, CURRENT_DATE) AND ${LIVE_RECORD}
         AND NOT EXISTS (SELECT 1 FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id
                         LEFT JOIN edoc_templates t ON t.id = d.template_id
                         WHERE p.salon_id = r.salon_id AND p.record_id = r.id AND COALESCE(d.kind, t.kind) = 'act'
                           AND p.status IN ('signed', 'paper'))
       GROUP BY r.client_id
     )
     SELECT c.id, c.name, c.phone, c.last_visit_at,
       COALESCE(dc.contract_signed, false) AS contract_signed, COALESCE(dc.consent_signed, false) AS consent_signed,
       COALESCE(dc.pending, false) AS pending, COALESCE(a.open_acts, 0) AS open_acts, count(*) OVER () AS total
     FROM clients c LEFT JOIN dc ON dc.client_id = c.id LEFT JOIN a ON a.client_id = c.id
     WHERE c.salon_id = $1 ${where} ${BASE_FILTERS[filter] || ''}
     ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

/** Визиты пациента для страницы: от from до to (прошлые и будущие), без удалённых и неявок. */
async function listClientRecords(salonId, clientId, from, to) {
  return db.any(
    `SELECT ${RECORD_FIELDS},
       EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
               AND p.status = 'arrived' AND p.visit_date < r.visit_date) AS has_prior_visit
     FROM records r WHERE r.salon_id = $1 AND r.client_id = $2 AND r.visit_date BETWEEN $3::date AND $4::date AND ${LIVE_RECORD}
     ORDER BY r.visit_datetime NULLS LAST, r.id LIMIT 60`,
    [salonId, clientId, from, to],
  );
}

/** История пациента: журнал «Документов» по client_id (без паспортных данных — их там нет). */
async function listClientEvents(salonId, clientId, limit = 40) {
  return db.any(
    `SELECT e.id, e.kind, e.package_id, e.payload, e.created_at, u.name AS user_name
     FROM edoc_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.salon_id = $1 AND e.client_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}

/** Настройки для дашборда; acts_required_from — строкой 'YYYY-MM-DD' (DATE через to_char, см. шапку). */
async function getBoardSettings(salonId) {
  return db.oneOrNone(
    `SELECT s.*, to_char(s.acts_required_from, 'YYYY-MM-DD') AS acts_from, u.name AS auto_sender_name
     FROM edoc_settings s LEFT JOIN users u ON u.id = s.auto_sender_user_id AND u.salon_id = s.salon_id
     WHERE s.salon_id = $1`,
    [salonId],
  );
}

/** Строка настроек есть всегда: acts_required_from = дата первого открытия, если модуль не настраивали. */
async function ensureSettingsRow(salonId) {
  await db.query('INSERT INTO edoc_settings (salon_id) VALUES ($1) ON CONFLICT (salon_id) DO NOTHING', [salonId]);
}

module.exports = {
  listBoardRecords, listDocsForClients, listIdentitiesForClients, listLatestForms, listAutoNotes,
  listBaseClients, listClientRecords, listClientEvents, getBoardSettings, ensureSettingsRow, BOARD_RECORDS_SQL, BASE_FILTERS,
};
