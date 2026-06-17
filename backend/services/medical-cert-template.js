// backend/services/medical-cert-template.js
'use strict';

const { db } = require('../db');
const s3 = require('./s3');
const defaultCoords = require('../data/medical-cert-coords.default.json');

// Загрузить новый бланк: кладём в S3, деактивируем прежние, создаём активную запись,
// координаты копируем с предыдущего активного шаблона или из дефолта.
async function uploadTemplate(salonId, buffer, fileName) {
  const key = `medical-cert/templates/${salonId}/${Date.now()}-${fileName.replace(/[^\w.-]/g, '_')}`;
  await s3.putObject(key, buffer, 'application/pdf');

  const prev = await db.oneOrNone(
    `SELECT t.id, c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id = $1 AND t.is_active = TRUE
      ORDER BY t.version DESC LIMIT 1`, [salonId]);

  await db.query('UPDATE medical_cert_templates SET is_active = FALSE WHERE salon_id = $1', [salonId]);

  const nextVersion = (await db.oneOrNone(
    'SELECT COALESCE(MAX(version),0)+1 AS v FROM medical_cert_templates WHERE salon_id=$1', [salonId])).v;

  const row = await db.one(
    `INSERT INTO medical_cert_templates (salon_id, s3_key, file_name, version, is_active)
     VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
    [salonId, key, fileName, nextVersion]);

  const coords = (prev && prev.coords) ? prev.coords : defaultCoords;
  await db.query(
    `INSERT INTO medical_cert_coords (template_id, coords) VALUES ($1,$2)`,
    [row.id, coords]);

  return { id: row.id, version: nextVersion };
}

// Метаданные активного шаблона + presigned URL для предпросмотра
async function getActiveTemplateMeta(salonId) {
  const t = await db.oneOrNone(
    `SELECT id, s3_key, file_name, version, created_at
       FROM medical_cert_templates WHERE salon_id=$1 AND is_active=TRUE
       ORDER BY version DESC LIMIT 1`, [salonId]);
  if (!t) return null;
  const url = await s3.presignGet(t.s3_key);
  return { id: t.id, fileName: t.file_name, version: t.version, createdAt: t.created_at, url };
}

// Буфер активного бланка + его координаты — для генерации
async function getActiveTemplateForFill(salonId) {
  const t = await db.oneOrNone(
    `SELECT t.id, t.s3_key, c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id=$1 AND t.is_active=TRUE ORDER BY t.version DESC LIMIT 1`, [salonId]);
  if (!t) return null;
  const obj = await s3.client.send(new (require('@aws-sdk/client-s3').GetObjectCommand)({
    Bucket: require('../config').S3_BUCKET, Key: t.s3_key,
  }));
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  return { templateId: t.id, blank: buffer, coords: t.coords || defaultCoords };
}

async function getCoords(salonId) {
  const t = await db.oneOrNone(
    `SELECT c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id=$1 AND t.is_active=TRUE ORDER BY t.version DESC LIMIT 1`, [salonId]);
  return (t && t.coords) ? t.coords : defaultCoords;
}

async function saveCoords(salonId, coords) {
  const t = await db.oneOrNone(
    'SELECT id FROM medical_cert_templates WHERE salon_id=$1 AND is_active=TRUE ORDER BY version DESC LIMIT 1',
    [salonId]);
  if (!t) throw new Error('NO_ACTIVE_TEMPLATE');
  await db.query(
    `INSERT INTO medical_cert_coords (template_id, coords, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (template_id) DO UPDATE SET coords=$2, updated_at=now()`,
    [t.id, coords]);
  return true;
}

module.exports = { uploadTemplate, getActiveTemplateMeta, getActiveTemplateForFill, getCoords, saveCoords };
