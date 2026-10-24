'use strict';
// SQL модуля «Документы». Каждый запрос ограничен salon_id (правило мультисалона);
// без salon_id — только кросс-салонные выборки фонового опроса и поиск салона по
// секрету вебхука. DATE-колонки читаются через to_char: pg отдаёт DATE полуночью
// по Москве, и toISOString() дал бы вчерашний день (готча из CLAUDE.md).
const { db, withTransaction } = require('../../db');
const { createLogger } = require('../../logger');
const { STATUSES, isFinal } = require('./statuses');

const logger = createLogger('EdocsStore');
// Из этих статусов комплект не возвращается в draft/sent/error (applyStatus): финальные по
// statuses.isFinal и 'signed' — он не финальный лишь потому, что ещё может стать «аннулирован».
const NO_ROLLBACK = STATUSES.filter((s) => s === 'signed' || isFinal(s));

// ── настройки салона ────────────────────────────────────────────────────────
const SETTINGS_COLS = ['enabled', 'base_url', 'api_key_enc', 'app_login', 'app_password_enc', 'app_code', 'corp_id',
  'qes_cert_alias', 'employee_position', 'requisites', 'unsign_days', 'webhook_secret'];

async function getSettings(salonId) {
  return db.oneOrNone('SELECT * FROM edoc_settings WHERE salon_id=$1', [salonId]);
}
/** UPSERT только переданных колонок из белого списка. */
async function saveSettings(salonId, patch) {
  const cols = Object.keys(patch || {}).filter((k) => SETTINGS_COLS.includes(k));
  if (!cols.length) return;
  const vals = cols.map((k) => (k === 'requisites' ? JSON.stringify(patch[k] || {}) : patch[k]));
  const names = ['salon_id', ...cols];
  const sets = cols.map((c) => `${c}=EXCLUDED.${c}`).concat('updated_at=NOW()');
  await db.query(
    `INSERT INTO edoc_settings (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (salon_id) DO UPDATE SET ${sets.join(', ')}`,
    [salonId, ...vals],
  );
}
async function findSalonByWebhookSecret(secret) {
  const r = await db.oneOrNone('SELECT salon_id FROM edoc_settings WHERE webhook_secret=$1 AND enabled', [secret]);
  return r ? r.salon_id : null;
}
async function touchWebhook(salonId) {
  await db.query('UPDATE edoc_settings SET last_webhook_at=NOW() WHERE salon_id=$1', [salonId]);
}

// ── учётные данные F.Doc сотрудников ───────────────────────────────────────
async function getCredentials(salonId, userId) {
  return db.oneOrNone('SELECT * FROM edoc_user_credentials WHERE user_id=$1 AND salon_id=$2', [userId, salonId]);
}
/** true — записано; false — строка этого user_id принадлежит другому салону (не тронута). */
async function saveCredentials(salonId, userId, login, passwordEnc) {
  const r = await db.oneOrNone(
    `INSERT INTO edoc_user_credentials (user_id, salon_id, login, password_enc, fail_count, last_ok_at)
     VALUES ($1, $2, $3, $4, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET login=EXCLUDED.login, password_enc=EXCLUDED.password_enc,
       fail_count=0, last_ok_at=NOW(), last_error=NULL, updated_at=NOW()
     WHERE edoc_user_credentials.salon_id = EXCLUDED.salon_id
     RETURNING user_id`,
    [userId, salonId, login, passwordEnc],
  );
  return !!r;
}
async function deleteCredentials(salonId, userId) {
  await db.query('DELETE FROM edoc_user_credentials WHERE user_id=$1 AND salon_id=$2', [userId, salonId]);
}
async function markCredentialsOk(salonId, userId) {
  await db.query('UPDATE edoc_user_credentials SET fail_count=0, last_ok_at=NOW(), last_error=NULL, updated_at=NOW() WHERE user_id=$1 AND salon_id=$2', [userId, salonId]);
}
async function markCredentialsFail(salonId, userId, error) {
  await db.query('UPDATE edoc_user_credentials SET fail_count=fail_count+1, last_error=$3, updated_at=NOW() WHERE user_id=$1 AND salon_id=$2', [userId, salonId, String(error || '').slice(0, 300)]);
}
/**
 * Рабочие учётные данные салона: сначала preferUserId, иначе последние удачные.
 * failBelow — отказов меньше этого (фон берёт только учётки без записанных отказов: 1);
 * exclude — user_id, которые не брать (учётки на паузе фона).
 */
async function pickCredentials(salonId, preferUserId, { failBelow = 3, exclude = [] } = {}) {
  return db.oneOrNone(
    `SELECT * FROM edoc_user_credentials WHERE salon_id=$1 AND fail_count < $3 AND NOT (user_id = ANY($4::int[]))
     ORDER BY (user_id = $2) DESC, last_ok_at DESC NULLS LAST LIMIT 1`,
    [salonId, preferUserId || 0, failBelow, exclude],
  );
}
async function listUsersWithCredentials(salonId) {
  return db.any(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, c.login, c.last_ok_at, c.last_error, c.fail_count
     FROM users u LEFT JOIN edoc_user_credentials c ON c.user_id=u.id AND c.salon_id=u.salon_id
     WHERE u.salon_id=$1 AND u.role IN ('owner', 'admin', 'admin_cashier')
     ORDER BY u.is_active DESC, u.name`,
    [salonId],
  );
}

// ── шаблоны ────────────────────────────────────────────────────────────────
async function listTemplates(salonId, { activeOnly = false } = {}) {
  return db.any(
    `SELECT id, kind, title, file_size, placeholders, is_active, sort_order, created_at, updated_at
     FROM edoc_templates WHERE salon_id=$1 ${activeOnly ? 'AND is_active' : ''} ORDER BY sort_order, id`,
    [salonId],
  );
}
async function getTemplate(salonId, id) {
  return db.oneOrNone('SELECT * FROM edoc_templates WHERE salon_id=$1 AND id=$2', [salonId, id]);
}
async function getTemplatesByIds(salonId, ids) {
  return db.any('SELECT * FROM edoc_templates WHERE salon_id=$1 AND id = ANY($2::int[]) ORDER BY sort_order, id', [salonId, ids]);
}
async function insertTemplate(salonId, t) {
  const r = await db.oneOrNone(
    `INSERT INTO edoc_templates (salon_id, kind, title, file_key, file_size, placeholders, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id`,
    [salonId, t.kind, t.title, t.file_key, t.file_size, JSON.stringify(t.placeholders || []), t.sort_order || 0, t.created_by || null],
  );
  return r && r.id;
}
async function updateTemplateMeta(salonId, id, t) {
  const r = await db.oneOrNone(
    `UPDATE edoc_templates SET title=$3, kind=$4, is_active=$5, sort_order=$6, updated_at=NOW()
     WHERE salon_id=$1 AND id=$2 RETURNING id`,
    [salonId, id, t.title, t.kind, t.is_active, t.sort_order],
  );
  return !!r;
}
/** Замена файла шаблона; возвращает прежний ключ S3 (удаляет вызывающий) или null. */
async function replaceTemplateFile(salonId, id, t) {
  return withTransaction(async (c) => {
    const old = (await c.query('SELECT file_key FROM edoc_templates WHERE salon_id=$1 AND id=$2 FOR UPDATE', [salonId, id])).rows[0];
    if (!old) return null;
    await c.query(
      `UPDATE edoc_templates SET file_key=$3, file_size=$4, placeholders=$5::jsonb, updated_at=NOW() WHERE salon_id=$1 AND id=$2`,
      [salonId, id, t.file_key, t.file_size, JSON.stringify(t.placeholders || [])],
    );
    return old.file_key;
  });
}
/** 'busy' — шаблон в неотправленном/неподписанном комплекте; 'missing'; иначе { fileKey }. */
async function deleteTemplate(salonId, id) {
  return withTransaction(async (c) => {
    const busy = (await c.query(
      `SELECT 1 FROM edoc_documents d JOIN edoc_packages p ON p.id=d.package_id
       WHERE p.salon_id=$1 AND d.template_id=$2 AND p.status IN ('draft', 'sent', 'error') LIMIT 1`,
      [salonId, id],
    )).rows[0];
    if (busy) return 'busy';
    const r = (await c.query('DELETE FROM edoc_templates WHERE salon_id=$1 AND id=$2 RETURNING file_key', [salonId, id])).rows[0];
    return r ? { fileKey: r.file_key } : 'missing';
  });
}

// ── пациенты ───────────────────────────────────────────────────────────────
async function searchClients(salonId, q, limit = 20) {
  const s = String(q || '').trim();
  const digits = s.replace(/\D/g, '');
  const cols = `SELECT c.id, c.name, c.phone, (ci.client_id IS NOT NULL) AS has_identity
    FROM clients c LEFT JOIN client_identity ci ON ci.client_id=c.id AND ci.salon_id=c.salon_id WHERE c.salon_id=$1`;
  if (digits.length >= 4) {
    return db.any(`${cols} AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $2
      ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC LIMIT $3`, [salonId, `%${digits.slice(-10)}%`, limit]);
  }
  const like = `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return db.any(`${cols} AND c.name ILIKE $2 ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC LIMIT $3`, [salonId, like, limit]);
}
async function getClient(salonId, id) {
  return db.oneOrNone(
    `SELECT id, name, phone, email, yclients_client_id, yclients_data, to_char(birthday, 'YYYY-MM-DD') AS birthday_iso
     FROM clients WHERE salon_id=$1 AND id=$2`,
    [salonId, id],
  );
}
/** Последняя заявка на справку, сопоставленная с пациентом (для паспорта в предзаполнении). */
async function getLatestCertRequest(salonId, clientId) {
  return db.oneOrNone(
    `SELECT payer_is_patient, payer_doc_type_code, payer_doc_serie_number,
            to_char(payer_doc_issue_date, 'YYYY-MM-DD') AS payer_doc_issue_date_iso,
            to_char(payer_birthdate, 'YYYY-MM-DD') AS payer_birthdate_iso,
            patient_doc_type_code, patient_doc_serie_number,
            to_char(patient_doc_issue_date, 'YYYY-MM-DD') AS patient_doc_issue_date_iso,
            to_char(patient_birthdate, 'YYYY-MM-DD') AS patient_birthdate_iso,
            to_char(created_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS created_date
     FROM cert_requests WHERE salon_id=$1 AND matched_client_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [salonId, clientId],
  );
}
async function getIdentityRow(salonId, clientId) {
  return db.oneOrNone(
    `SELECT client_id, salon_id, last_name, first_name, middle_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
            gender, phone, email, contract_no, to_char(contract_date, 'YYYY-MM-DD') AS contract_date,
            secure_enc, secure_fields, source, updated_by, updated_at
     FROM client_identity WHERE salon_id=$1 AND client_id=$2`,
    [salonId, clientId],
  );
}
async function upsertIdentity(salonId, clientId, v) {
  const p = v.plain;
  await db.query(
    `INSERT INTO client_identity (client_id, salon_id, last_name, first_name, middle_name, birth_date, gender, phone, email,
       contract_no, contract_date, secure_enc, secure_fields, source, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
     ON CONFLICT (client_id) DO UPDATE SET last_name=EXCLUDED.last_name, first_name=EXCLUDED.first_name,
       middle_name=EXCLUDED.middle_name, birth_date=EXCLUDED.birth_date, gender=EXCLUDED.gender, phone=EXCLUDED.phone,
       email=EXCLUDED.email, contract_no=EXCLUDED.contract_no, contract_date=EXCLUDED.contract_date,
       secure_enc=EXCLUDED.secure_enc, secure_fields=EXCLUDED.secure_fields, source=EXCLUDED.source,
       updated_by=EXCLUDED.updated_by, updated_at=NOW()
     WHERE client_identity.salon_id = EXCLUDED.salon_id`,
    [clientId, salonId, p.last_name || null, p.first_name || null, p.middle_name || null, p.birth_date, p.gender, p.phone, p.email,
      p.contract_no, p.contract_date, v.secure_enc, JSON.stringify(v.secure_fields || []), v.source || 'manual', v.userId || null],
  );
}

// ── записи YClients (для акта) ─────────────────────────────────────────────
const RECORD_COLS = `r.id, r.client_id, r.yclients_record_id, r.services, r.staff, r.amount,
  to_char(COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date), 'YYYY-MM-DD') AS visit_date,
  (r.raw_payload->>'attendance') AS attendance,
  (COALESCE(r.status, '') = 'deleted' OR COALESCE((r.raw_payload->>'deleted')::boolean, false)) AS deleted`;
async function getRecord(salonId, recordId) {
  return db.oneOrNone(`SELECT ${RECORD_COLS} FROM records r WHERE r.salon_id=$1 AND r.id=$2`, [salonId, recordId]);
}
/** Последние состоявшиеся визиты пациента и статус последнего акта по каждому. */
async function listClientVisits(salonId, clientId, limit = 20) {
  return db.any(
    `SELECT ${RECORD_COLS}, a.id AS act_package_id, a.status AS act_status
     FROM records r
     LEFT JOIN LATERAL (SELECT p.id, p.status FROM edoc_packages p
       WHERE p.salon_id=r.salon_id AND p.record_id=r.id AND p.kind='act' ORDER BY p.created_at DESC LIMIT 1) a ON true
     WHERE r.salon_id=$1 AND r.client_id=$2 AND (r.raw_payload->>'attendance')='1'
       AND COALESCE(r.status, '') <> 'deleted' AND NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)
     ORDER BY r.visit_datetime DESC NULLS LAST, r.id DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}
/** Статус последнего акта по каждой записи из списка (страница «Записи»). */
async function actStatusesForRecords(salonId, recordIds) {
  return db.any(
    `SELECT DISTINCT ON (record_id) record_id, id AS package_id, status
     FROM edoc_packages WHERE salon_id=$1 AND kind='act' AND record_id = ANY($2::int[])
     ORDER BY record_id, created_at DESC`,
    [salonId, recordIds],
  );
}

// ── комплекты и документы ──────────────────────────────────────────────────
async function insertPackage(pkg, docs) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO edoc_packages (id, salon_id, client_id, record_id, kind, title, payload, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [pkg.id, pkg.salon_id, pkg.client_id, pkg.record_id || null, pkg.kind, pkg.title, JSON.stringify(pkg.payload || {}), pkg.sent_by || null],
    );
    for (const d of docs) {
      await c.query(
        `INSERT INTO edoc_documents (id, package_id, salon_id, template_id, title, file_name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [d.id, pkg.id, pkg.salon_id, d.template_id || null, d.title, d.file_name, d.sort_order || 0],
      );
    }
  });
}
/**
 * F.Doc принял комплект: время, отправитель, ссылка в окно сотрудника и снятие ошибки пишутся всегда,
 * а статус 'sent' — только из 'draft' (CASE в SET, не условие WHERE): перечитывание могло уже сдвинуть
 * его дальше, назад не возвращаем. true — статус сменился, false — не черновик или комплекта нет в салоне.
 * Прежний статус — из подзапроса FOR UPDATE: RETURNING видит только новую строку, а блокировка не даёт
 * ему разойтись с той, что обновляется.
 */
async function markSent(salonId, id, { employeeUrl = null, userId = null } = {}) {
  const r = await db.oneOrNone(
    `UPDATE edoc_packages p SET status=CASE WHEN p.status='draft' THEN 'sent' ELSE p.status END,
       sent_at=NOW(), sent_by=COALESCE($3, p.sent_by), last_error=NULL,
       employee_url=COALESCE($4, p.employee_url), employee_url_at=CASE WHEN $4::text IS NULL THEN p.employee_url_at ELSE NOW() END,
       updated_at=NOW()
     FROM (SELECT id, status FROM edoc_packages WHERE salon_id=$1 AND id=$2 FOR UPDATE) o
     WHERE p.salon_id=$1 AND p.id=o.id
     RETURNING (o.status='draft') AS changed`,
    [salonId, id, userId, employeeUrl],
  );
  return !!(r && r.changed);
}
async function markSendError(salonId, id, error) {
  await db.query('UPDATE edoc_packages SET last_error=$3, updated_at=NOW() WHERE salon_id=$1 AND id=$2', [salonId, id, String(error || '').slice(0, 500)]);
}
async function setEmployeeUrl(salonId, id, url) {
  await db.query('UPDATE edoc_packages SET employee_url=$3, employee_url_at=NOW() WHERE salon_id=$1 AND id=$2', [salonId, id, url]);
}
/**
 * Применить statuses.applyWorkflow(): комплект и его документы одной транзакцией.
 * Статус только вперёд: из NO_ROLLBACK комплект переходит лишь в NO_ROLLBACK (signed → annulled
 * законен). Условие — в WHERE, а не в JS: иначе устаревший ответ F.Doc, прочитанный параллельно,
 * откатил бы статус. Документы — только если строка комплекта обновилась.
 * true — применено; false — комплект не найден в салоне или переход назад отвергнут.
 */
async function applyStatus(salonId, id, upd) {
  return withTransaction(async (c) => {
    const p = upd.package;
    const hit = (await c.query(
      `UPDATE edoc_packages SET status=$3, fdoc_status=$4, fdoc_package_guid=COALESCE($5, fdoc_package_guid),
         signed_at=COALESCE(signed_at, $6::timestamptz), last_status_check_at=NOW(), updated_at=NOW()
       WHERE salon_id=$1 AND id=$2 AND (status <> ALL($7::text[]) OR $3::text = ANY($7::text[]))
       RETURNING id`,
      [salonId, id, p.status, p.fdoc_status, p.fdoc_package_guid, p.signed_at, NO_ROLLBACK],
    )).rows[0];
    if (!hit) return false;
    for (const d of upd.documents || []) {
      await c.query(
        `UPDATE edoc_documents SET fdoc_document_guid=COALESCE($4, fdoc_document_guid), fdoc_status=$5,
           client_signed_at=COALESCE($6::timestamptz, client_signed_at), corp_signed_at=COALESCE($7::timestamptz, corp_signed_at),
           updated_at=NOW()
         WHERE salon_id=$1 AND package_id=$2 AND id=$3`,
        [salonId, id, d.id, d.fdoc_document_guid, d.fdoc_status, d.client_signed_at, d.corp_signed_at],
      );
    }
    return true;
  });
}
async function touchStatusCheck(salonId, ids) {
  if (!ids.length) return;
  await db.query('UPDATE edoc_packages SET last_status_check_at=NOW() WHERE salon_id=$1 AND id = ANY($2::uuid[])', [salonId, ids]);
}
const PACKAGE_SELECT = `SELECT p.*, c.name AS client_name, c.phone AS client_phone, u.name AS sent_by_name
  FROM edoc_packages p JOIN clients c ON c.id=p.client_id LEFT JOIN users u ON u.id=p.sent_by`;
async function getPackage(salonId, id) {
  return db.oneOrNone(`${PACKAGE_SELECT} WHERE p.salon_id=$1 AND p.id=$2`, [salonId, id]);
}
async function findPackageByAnyId(salonId, anyId) {
  return db.oneOrNone('SELECT * FROM edoc_packages WHERE salon_id=$1 AND (id::text=$2 OR fdoc_package_guid=$2) LIMIT 1', [salonId, anyId]);
}
async function listDocuments(salonId, packageId) {
  return db.any('SELECT * FROM edoc_documents WHERE salon_id=$1 AND package_id=$2 ORDER BY sort_order, created_at', [salonId, packageId]);
}
async function getDocument(salonId, id) {
  return db.oneOrNone(
    `SELECT d.*, p.status AS package_status, p.client_id FROM edoc_documents d JOIN edoc_packages p ON p.id=d.package_id
     WHERE d.salon_id=$1 AND d.id=$2`,
    [salonId, id],
  );
}
async function setDocumentPdf(salonId, docId, key) {
  await db.query('UPDATE edoc_documents SET pdf_key=$3, pdf_fetched_at=NOW(), updated_at=NOW() WHERE salon_id=$1 AND id=$2', [salonId, docId, key]);
}
/** Список комплектов салона с фильтрами; from/to — даты создания по Москве. */
async function listPackages(salonId, { status = null, clientId = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
  const where = ['p.salon_id=$1']; const params = [salonId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (status) add('p.status=?', status);
  if (clientId) add('p.client_id=?', clientId);
  if (from) add(`(p.created_at AT TIME ZONE 'Europe/Moscow')::date >= ?::date`, from);
  if (to) add(`(p.created_at AT TIME ZONE 'Europe/Moscow')::date <= ?::date`, to);
  const w = where.join(' AND ');
  const total = Number((await db.oneOrNone(`SELECT COUNT(*) AS n FROM edoc_packages p WHERE ${w}`, params)).n);
  const rows = await db.any(
    `${PACKAGE_SELECT} WHERE ${w} ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { total, rows };
}
async function listClientPackages(salonId, clientId, limit = 20) {
  return db.any(
    `SELECT p.id, p.kind, p.title, p.status, p.record_id, p.created_at, p.sent_at, p.signed_at, p.last_error
     FROM edoc_packages p WHERE p.salon_id=$1 AND p.client_id=$2 ORDER BY p.created_at DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}
// Кого опросить фоном: незавершённые — каждые 5 минут первые 60 дней, дальше раз в сутки;
// подписанные — раз в сутки 30 дней (подписанный ещё может стать «аннулирован»);
// подписанные без PDF — каждые 5 минут, пока PDF не скачаны, но тоже не дольше 30 дней
// с подписи: PDF, который не скачивается, иначе опрашивался бы вечно.
const DUE_SQL = `
  SELECT p.* FROM edoc_packages p JOIN edoc_settings s ON s.salon_id=p.salon_id AND s.enabled
  WHERE (p.status IN ('sent', 'error') AND p.created_at > NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
     OR (p.status IN ('sent', 'error') AND p.created_at <= NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '1 day'))
     OR (p.status = 'signed' AND p.signed_at > NOW() - INTERVAL '30 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '1 day'))
     OR (p.status = 'signed' AND p.signed_at > NOW() - INTERVAL '30 days'
          AND EXISTS (SELECT 1 FROM edoc_documents d WHERE d.package_id=p.id AND d.pdf_key IS NULL)
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
  ORDER BY p.last_status_check_at NULLS FIRST, p.created_at
  LIMIT $1`;
async function listDuePackages(limit = 200) {
  return db.any(DUE_SQL, [limit]);
}

// ── журнал ─────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Запись журнала — best-effort: сбой журнала не должен ронять отправку или вебхук. */
async function logEvent({ salonId, packageId = null, clientId = null, kind, userId = null, payload = {} }) {
  try {
    await db.query(
      `INSERT INTO edoc_events (salon_id, package_id, client_id, kind, user_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [salonId, packageId && UUID_RE.test(packageId) ? packageId : null, clientId, kind, userId, JSON.stringify(payload || {})],
    );
  } catch (e) { logger.warn(`edoc_events ${kind}: ${e.message}`); }
}
async function listEvents(salonId, packageId, limit = 30) {
  return db.any(
    `SELECT e.id, e.kind, e.payload, e.created_at, u.name AS user_name FROM edoc_events e LEFT JOIN users u ON u.id=e.user_id
     WHERE e.salon_id=$1 AND e.package_id=$2 ORDER BY e.created_at DESC LIMIT $3`,
    [salonId, packageId, limit],
  );
}

module.exports = {
  getSettings, saveSettings, findSalonByWebhookSecret, touchWebhook,
  getCredentials, saveCredentials, deleteCredentials, markCredentialsOk, markCredentialsFail, pickCredentials, listUsersWithCredentials,
  listTemplates, getTemplate, getTemplatesByIds, insertTemplate, updateTemplateMeta, replaceTemplateFile, deleteTemplate,
  searchClients, getClient, getLatestCertRequest, getIdentityRow, upsertIdentity,
  getRecord, listClientVisits, actStatusesForRecords,
  insertPackage, markSent, markSendError, setEmployeeUrl, applyStatus, touchStatusCheck, getPackage, findPackageByAnyId,
  listDocuments, getDocument, setDocumentPdf, listPackages, listClientPackages, listDuePackages, DUE_SQL,
  logEvent, listEvents, UUID_RE,
};
