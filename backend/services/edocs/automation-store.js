'use strict';
// SQL автоматики «Документов»: кандидаты на действие и журнал edoc_auto_jobs. Кандидат, по
// которому уже есть строка журнала, в выборку не попадает — действие at-most-once.
const { db } = require('../../db');

const LIVE = `NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)`;

async function listAutomationSalons() {
  return db.any('SELECT * FROM edoc_settings WHERE auto_previsit OR auto_act OR auto_remind ORDER BY salon_id');
}

/** Записи «ждёт/подтвердил» с началом в (from, to]; first — только первичные (ни одной состоявшейся раньше). */
const PREVISIT_SQL = `
  SELECT r.id, r.client_id, r.visit_datetime, c.phone, c.name
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.visit_datetime > $2::timestamptz AND r.visit_datetime <= $3::timestamptz
    AND r.status IN ('waiting', 'confirmed') AND ${LIVE}
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = r.salon_id AND j.kind = 'previsit' AND j.ref = r.id::text)
    AND (NOT $4::boolean OR NOT EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
                                        AND p.status = 'arrived' AND p.visit_date < r.visit_date))
  ORDER BY r.visit_datetime LIMIT 50`;
async function previsitCandidates(salonId, fromIso, toIso, firstOnly) {
  return db.any(PREVISIT_SQL, [salonId, fromIso, toIso, !!firstOnly]);
}

/** Оплаченные состоявшиеся визиты с fromDate, изменённые не позже delayMin минут назад, без единого комплекта с актом. */
const ACT_SQL = `
  SELECT r.id, r.client_id, c.phone
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.status = 'arrived' AND (r.raw_payload->>'paid_full') = '1' AND r.visit_date >= $2::date
    AND r.updated_at <= NOW() - make_interval(mins => $3::int) AND ${LIVE}
    AND NOT EXISTS (SELECT 1 FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id
                    LEFT JOIN edoc_templates t ON t.id = d.template_id
                    WHERE p.salon_id = r.salon_id AND p.record_id = r.id AND COALESCE(d.kind, t.kind) = 'act')
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = r.salon_id AND j.kind = 'act' AND j.ref = r.id::text)
  ORDER BY r.visit_datetime LIMIT 50`;
async function actCandidates(salonId, fromDate, delayMin) {
  return db.any(ACT_SQL, [salonId, fromDate, delayMin]);
}

/** Комплекты, ждущие подписи дольше hours часов (но не дольше 3 суток), без повтора. */
const REMIND_PACKAGES_SQL = `
  SELECT p.id, p.client_id, p.sent_by, p.payload, c.phone AS client_phone
  FROM edoc_packages p JOIN clients c ON c.id = p.client_id
  WHERE p.salon_id = $1 AND p.status = 'sent' AND p.source <> 'paper'
    AND p.sent_at <= NOW() - make_interval(hours => $2::int) AND p.sent_at > NOW() - INTERVAL '3 days'
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = p.salon_id AND j.kind = 'remind' AND j.ref = p.id::text)
  ORDER BY p.sent_at LIMIT 50`;
async function remindPackages(salonId, hours) {
  return db.any(REMIND_PACKAGES_SQL, [salonId, hours]);
}

/** Активные анкеты, доставленные в мессенджер дольше hours часов назад и не заполненные, без повтора. */
const REMIND_FORMS_SQL = `
  SELECT f.id, f.client_id, c.phone
  FROM edoc_patient_forms f JOIN clients c ON c.id = f.client_id
  WHERE f.salon_id = $1 AND f.status = 'active' AND f.expires_at > NOW() AND f.delivered_via IS NOT NULL
    AND f.delivered_at <= NOW() - make_interval(hours => $2::int)
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = f.salon_id AND j.kind = 'remind_form' AND j.ref = f.id::text)
  ORDER BY f.delivered_at LIMIT 50`;
async function remindForms(salonId, hours) {
  return db.any(REMIND_FORMS_SQL, [salonId, hours]);
}

/** Застолбить действие. null — уже было (другой процесс или прошлый тик). */
async function claim(salonId, kind, ref, { clientId = null, recordId = null, packageId = null, formId = null } = {}) {
  const r = await db.oneOrNone(
    `INSERT INTO edoc_auto_jobs (salon_id, kind, ref, client_id, record_id, package_id, form_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (salon_id, kind, ref) DO NOTHING RETURNING id`,
    [salonId, kind, String(ref), clientId, recordId, packageId, formId],
  );
  return r ? r.id : null;
}
async function finish(id, status, reason, { packageId = null, formId = null } = {}) {
  await db.query(
    `UPDATE edoc_auto_jobs SET status=$2, reason=$3, package_id=COALESCE($4, package_id), form_id=COALESCE($5, form_id), updated_at=NOW() WHERE id=$1`,
    [id, status, reason ? String(reason).slice(0, 300) : null, packageId, formId],
  );
}

module.exports = {
  listAutomationSalons, previsitCandidates, actCandidates, remindPackages, remindForms, claim, finish,
  PREVISIT_SQL, ACT_SQL, REMIND_PACKAGES_SQL, REMIND_FORMS_SQL,
};
