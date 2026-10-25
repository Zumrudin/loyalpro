'use strict';
// «Подписано на бумаге» (спека 2026-10-25 §8): документ подписан вне F.Doc — комплект сразу в
// статусе 'paper' (source 'paper'), со сканом в S3 или без. F.Doc не нужен: клиника ведёт учёт
// бумажных документов и до подключения сервиса. Ошибочную отметку снимает владелец/администратор.
const crypto = require('crypto');
const store = require('./store');
const s3 = require('../s3');
const { validateImageBuffer } = require('../../utils/upload-validator');
const { EdocsError } = require('./errors');
const { safeFileName } = require('./send-body');
const { isCalendarDate, todayMsk } = require('../../utils/period');

const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const MAX_DOCS = 10;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Тип скана по СОДЕРЖИМОМУ: PDF по сигнатуре %PDF-, картинка — validateImageBuffer. */
function scanType(buf, name) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new EdocsError('bad_scan', 'Файл скана пустой', 400);
  if (buf.length > MAX_SCAN_BYTES) throw new EdocsError('bad_scan', 'Скан больше 10 МБ', 400);
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  const v = validateImageBuffer(buf, name);
  if (!v.ok) throw new EdocsError('bad_scan', `Скан: ${v.error} (подходят JPG, PNG, WEBP или PDF)`, 400);
  return { ext: v.ext.replace('.', '').replace('jpeg', 'jpg'), mime: MIME[v.ext] || 'application/octet-stream' };
}

async function markPaper({ salonId, userId, clientId, templateIds, recordId = null, signedDate = null, note = '', file = null }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const ids = [...new Set(templateIds || [])];
  if (!ids.length || ids.length > MAX_DOCS) throw new EdocsError('bad_templates', `Отметьте от 1 до ${MAX_DOCS} документов`, 400);
  const templates = await store.getTemplatesByIds(salonId, ids);
  if (templates.length !== ids.length) throw new EdocsError('bad_templates', 'Шаблон не найден', 400);
  const isAct = templates.some((t) => t.kind === 'act');
  let record = null;
  if (isAct) {
    if (!recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
    record = await store.getRecord(salonId, recordId);
    if (!record || record.client_id !== client.id) throw new EdocsError('not_found', 'Визит не найден у этого пациента', 404);
    if (record.attendance !== '1' || record.deleted) throw new EdocsError('act_visit_not_done', 'Акт — только по состоявшемуся визиту', 409);
  }
  const today = todayMsk();
  const date = signedDate || today;
  if (!isCalendarDate(date) || date > today || date < '2000-01-01') throw new EdocsError('bad_date', 'Дата подписания — не позже сегодняшней', 400);
  const text = String(note || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const packageId = crypto.randomUUID();
  let scan = null;
  if (file && file.buffer) {
    const t = scanType(file.buffer, file.originalname);
    const key = `edocs/${salonId}/paper/${packageId}/${crypto.randomUUID()}.${t.ext}`;
    await s3.putObject(key, file.buffer, t.mime);
    scan = { key, mime: t.mime, size: file.buffer.length };
  }
  const docs = templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, kind: t.kind, title: t.title, file_name: safeFileName(t.title), sort_order: i }));
  await store.insertPackage({
    id: packageId, salon_id: salonId, client_id: client.id, record_id: record ? record.id : null, kind: isAct ? 'act' : 'onboarding',
    title: `На бумаге: ${templates.map((t) => t.title).join(', ')}`.slice(0, 200), sent_by: userId, status: 'paper', source: 'paper',
    signed_at: `${date}T12:00:00+03:00`, payload: { templateIds: ids, paper: { signedDate: date, note: text, scan } },
  }, docs);
  await store.logEvent({ salonId, packageId, clientId: client.id, kind: 'paper', userId, payload: { templateIds: ids, recordId: record ? record.id : null, scan: !!scan } });
  return { packageId };
}

async function revokePaper({ salonId, userId, packageId, reason }) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (why.length < 3) throw new EdocsError('bad_reason', 'Укажите причину', 400);
  const pkg = await store.getPackage(salonId, packageId);
  if (!pkg) throw new EdocsError('not_found', 'Комплект не найден', 404);
  if (pkg.status !== 'paper' || pkg.source !== 'paper') throw new EdocsError('bad_status', 'Снять можно только отметку «Подписано на бумаге»', 409);
  if (!(await store.revokePaperPackage(salonId, pkg.id))) throw new EdocsError('bad_status', 'Отметку уже сняли', 409);
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'paper_revoke', userId, payload: { reason: why } });
  return { ok: true };
}

async function scanUrl({ salonId, packageId }) {
  const pkg = await store.getPackage(salonId, packageId);
  const scan = pkg && pkg.payload && pkg.payload.paper && pkg.payload.paper.scan;
  if (!scan || !scan.key) throw new EdocsError('not_found', 'Скана нет', 404);
  return { url: await s3.presignGet(scan.key, 900) };
}

module.exports = { markPaper, revokePaper, scanUrl, scanType, MAX_SCAN_BYTES };
