'use strict';
// /api/edocs — оформление документов: пациент, его данные, комплекты, акты.
// Роли: владелец, администратор, администратор-кассир (ресепшен; префикс открыт ему в
// config.CASHIER_ALLOWED_PREFIXES). Паспорт расшифровывается только для формы данных
// (каждый показ — в журнал edoc_events) и для заполнения документов.
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const multer = require('multer');
const sharp = require('sharp');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const identity = require('../services/edocs/identity');
const s3 = require('../services/s3');
const secretBox = require('../utils/secret-box');
const { client: fdoc } = require('../services/fdoc/client');
const { linesFromRecord, doctorOf, actTotals } = require('../services/edocs/act-lines');
const { STATUSES } = require('../services/edocs/statuses');
const { EdocsError, sendError } = require('../services/edocs/errors');
const { validateImageBuffer } = require('../utils/upload-validator');
const { isCalendarDate, todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsAPI');
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const MAX_RECOGNIZE_B64 = 6 * 1024 * 1024;   // предел F.Doc на base64 фото

const posInt = (v) => (/^\d{1,9}$/.test(String(v === undefined || v === null ? '' : v)) && Number(v) > 0 ? Number(v) : null);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Тело POST /packages, /packages/preview (single), /packages/check. */
function parsePackageBody(b, { single = false, today = todayMsk() } = {}) {
  b = b || {};
  const clientId = posInt(b.clientId);
  if (!clientId) return { error: 'Не выбран пациент' };
  let templateIds;
  if (single) {
    const t = posInt(b.templateId);
    if (!t) return { error: 'Не выбран шаблон' };
    templateIds = [t];
  } else {
    if (!Array.isArray(b.templateIds) || !b.templateIds.length || b.templateIds.length > packages.MAX_DOCS) return { error: `Выберите от 1 до ${packages.MAX_DOCS} документов` };
    templateIds = b.templateIds.map(posInt);
    if (templateIds.some((x) => !x)) return { error: 'Неверный шаблон' };
    templateIds = [...new Set(templateIds)];
  }
  let recordId = null;
  if (b.recordId !== undefined && b.recordId !== null && b.recordId !== '') {
    recordId = posInt(b.recordId);
    if (!recordId) return { error: 'Неверный визит' };
  }
  let docDate = null;
  if (b.docDate !== undefined && b.docDate !== null && b.docDate !== '') {
    docDate = String(b.docDate);
    if (!isCalendarDate(docDate) || docDate < addDays(today, -366) || docDate > addDays(today, 30)) return { error: 'Дата документа: от года назад до 30 дней вперёд' };
  }
  if (b.actLines !== undefined && b.actLines !== null && !Array.isArray(b.actLines)) return { error: 'Строки акта — список' };
  return { value: { clientId, templateIds, recordId, docDate, actLines: b.actLines || null } };
}

function packageView(p) {
  return {
    id: p.id, kind: p.kind, title: p.title, status: p.status, fdocStatus: p.fdoc_status || null,
    clientId: p.client_id, clientName: p.client_name || null, clientPhone: p.client_phone || null, recordId: p.record_id || null,
    sentAt: p.sent_at || null, signedAt: p.signed_at || null, sentByName: p.sent_by_name || null, lastError: p.last_error || null,
    createdAt: p.created_at, lastStatusCheckAt: p.last_status_check_at || null,
  };
}

router.use(auth, requireRole('owner', 'admin', 'admin_cashier'));

// ── состояние модуля и учётная запись F.Doc текущего пользователя ──
router.get('/state', async (req, res) => {
  try {
    const s = await store.getSettings(req.user.salonId);
    const c = await store.getCredentials(req.user.salonId, req.user.userId);
    res.json({
      enabled: !!(s && s.enabled), configured: !!(s && s.corp_id), encReady: secretBox.isConfigured(), role: req.user.role,
      me: { connected: !!c, login: c ? c.login : null, broken: !!(c && c.fail_count >= 3), lastError: (c && c.last_error) || null },
    });
  } catch (e) { sendError(res, e, logger, 'edocs state'); }
});

router.put('/me/credentials', async (req, res) => {
  const b = req.body || {};
  const login = typeof b.login === 'string' ? b.login.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!login || login.length > 200 || !password || password.length > 200) return res.status(400).json({ error: 'Укажите логин и пароль F.Doc' });
  const sid = req.user.salonId;
  try {
    const cfg = packages.fdocConfig(await store.getSettings(sid), { requireEnabled: false });
    try {
      await fdoc.checkCredentials(cfg, { userId: req.user.userId, login, password });
    } catch (e) {
      if (e && e.code === 'fdoc_credentials_invalid') return res.status(400).json({ error: 'F.Doc не принял логин или пароль', code: e.code });
      throw e;
    }
    await store.saveCredentials(sid, req.user.userId, login, secretBox.box().encrypt(password));
    await store.logEvent({ salonId: sid, kind: 'credentials', userId: req.user.userId, payload: { action: 'save', login } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs credentials save'); }
});

router.delete('/me/credentials', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    await store.deleteCredentials(sid, req.user.userId);
    if (s && s.corp_id) fdoc.forget(s.corp_id, req.user.userId);
    await store.logEvent({ salonId: sid, kind: 'credentials', userId: req.user.userId, payload: { action: 'delete' } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs credentials delete'); }
});

router.get('/templates', async (req, res) => {
  try {
    const rows = await store.listTemplates(req.user.salonId, { activeOnly: true });
    res.json({ templates: rows.map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders || [] })) });
  } catch (e) { sendError(res, e, logger, 'edocs templates'); }
});

// ── пациенты и их данные ──
router.get('/clients', async (req, res) => {
  const q = String(req.query.search || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ clients: [] });
  try {
    const rows = await store.searchClients(req.user.salonId, q, 20);
    res.json({ clients: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, hasIdentity: !!c.has_identity })) });
  } catch (e) { sendError(res, e, logger, 'edocs clients search'); }
});

// Сводка по пациенту. Отдаётся и при выключенном модуле: мастер оформления работает без
// F.Doc (данные, проверка документов), блокируется только отправка; блок в карточке
// клиента сам прячется по enabled:false.
router.get('/clients/:id/summary', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const row = await store.getIdentityRow(sid, id);
    let passportMask = '';
    if (row && row.secure_enc) {
      try { passportMask = identity.maskPassport(secretBox.box().decryptJson(row.secure_enc)); } catch (e) { passportMask = '— не расшифровано'; }
    }
    res.json({
      enabled: !!(s && s.enabled),
      client: { id: client.id, name: client.name, phone: client.phone },
      identity: row ? {
        exists: true, fio: [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(' '), birthDate: row.birth_date,
        passportMask, secureFields: row.secure_fields || [], updatedAt: row.updated_at,
      } : { exists: false },
      packages: (await store.listClientPackages(sid, id, 10)).map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, createdAt: p.created_at, signedAt: p.signed_at })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs client summary'); }
});

router.get('/clients/:id/identity', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const row = await store.getIdentityRow(sid, id);
    if (!row) return res.json({ exists: false });
    const decoded = identity.decodeRow(row, row.secure_enc ? secretBox.box() : null);
    if (row.secure_enc) await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_view', userId: req.user.userId });
    res.json({ exists: true, plain: decoded.plain, secure: decoded.secure, source: row.source, updatedAt: row.updated_at });
  } catch (e) { sendError(res, e, logger, 'edocs identity get'); }
});

router.get('/clients/:id/identity/prefill', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const r = identity.prefillFrom(client, await store.getLatestCertRequest(sid, id));
    if (Object.keys(r.secure).length) await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_prefill', userId: req.user.userId });
    res.json(r);
  } catch (e) { sendError(res, e, logger, 'edocs identity prefill'); }
});

router.put('/clients/:id/identity', async (req, res) => {
  const id = posInt(req.params.id);
  const v = identity.validateIdentity(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const enc = identity.encodeSecure(v.value.secure, secretBox.box());
    const source = req.body && req.body.source === 'recognize' ? 'recognize' : 'manual';
    await store.upsertIdentity(sid, id, { plain: v.value.plain, secure_enc: enc.secure_enc, secure_fields: enc.secure_fields, source, userId: req.user.userId });
    await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_edit', userId: req.user.userId, payload: {
      plain: Object.keys(v.value.plain).filter((k) => v.value.plain[k]), secure: enc.secure_fields, source,
    } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs identity save'); }
});

// Фото паспорта → поля формы через F.Doc. Фото у нас не сохраняется.
router.post('/clients/:id/identity/recognize', (req, res, next) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 15 МБ' : 'Не удалось принять фото' });
    if (!req.file) return res.status(400).json({ error: 'Приложите фото паспорта' });
    return next();
  });
}, async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const check = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const jpeg = await sharp(req.file.buffer).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const b64 = jpeg.toString('base64');
    if (b64.length > MAX_RECOGNIZE_B64) return res.status(400).json({ error: 'Фото слишком большое даже после сжатия' });
    const cfg = packages.fdocConfig(await store.getSettings(sid));
    const cred = await packages.credFor(sid, req.user.userId);
    const result = await fdoc.recognize(cfg, cred, b64, 'jpg');
    await store.logEvent({ salonId: sid, clientId: id, kind: 'recognize', userId: req.user.userId, payload: { recognized: !!result } });
    if (!result) return res.status(422).json({ error: 'F.Doc не распознал документ на фото — сфотографируйте разворот целиком' });
    res.json(identity.fromRecognized(result));
  } catch (e) { sendError(res, e, logger, 'edocs recognize'); }
});

// ── визиты и акты ──
router.get('/clients/:id/records', async (req, res) => {
  const id = posInt(req.params.id);
  try {
    const client = id ? await store.getClient(req.user.salonId, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const rows = await store.listClientVisits(req.user.salonId, id, 20);
    res.json({ records: rows.map((r) => ({
      id: r.id, visitDate: r.visit_date, staffName: doctorOf(r.staff).name,
      services: (Array.isArray(r.services) ? r.services : []).map((s) => s.title).filter(Boolean),
      total: actTotals(linesFromRecord(r.services)).total_sum,
      act: r.act_package_id ? { packageId: r.act_package_id, status: r.act_status } : null,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs client records'); }
});

router.get('/records/act-status', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(posInt).filter(Boolean).slice(0, 200);
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    if (!s || !s.enabled) return res.json({ enabled: false, statuses: {} });
    const rows = ids.length ? await store.actStatusesForRecords(sid, ids) : [];
    res.json({ enabled: true, statuses: Object.fromEntries(rows.map((r) => [r.record_id, { packageId: r.package_id, status: r.status }])) });
  } catch (e) { sendError(res, e, logger, 'edocs act statuses'); }
});

router.get('/records/:id/act-draft', async (req, res) => {
  const id = posInt(req.params.id);
  try {
    const r = id ? await store.getRecord(req.user.salonId, id) : null;
    if (!r) return res.status(404).json({ error: 'Визит не найден' });
    if (r.attendance !== '1' || r.deleted) return res.status(409).json({ error: 'Акт оформляется только по состоявшемуся визиту' });
    const lines = linesFromRecord(r.services);
    res.json({
      record: { id: r.id, clientId: r.client_id, visitDate: r.visit_date, actNo: String(r.yclients_record_id || r.id) },
      doctor: doctorOf(r.staff), lines, totals: actTotals(lines),
    });
  } catch (e) { sendError(res, e, logger, 'edocs act draft'); }
});

// ── комплекты ── (статические пути — ДО /packages/:id)
router.post('/packages/check', async (req, res) => {
  const p = parsePackageBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try { res.json(await packages.check({ salonId: req.user.salonId, clientId: p.value.clientId, templateIds: p.value.templateIds })); }
  catch (e) { sendError(res, e, logger, 'edocs check'); }
});

router.post('/packages/preview', async (req, res) => {
  const p = parsePackageBody(req.body, { single: true });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    res.json(await packages.preview({ salonId: req.user.salonId, userId: req.user.userId, clientId: p.value.clientId, templateId: p.value.templateIds[0],
      recordId: p.value.recordId, actLines: p.value.actLines, docDate: p.value.docDate }));
  } catch (e) { sendError(res, e, logger, 'edocs preview'); }
});

router.post('/packages', async (req, res) => {
  const p = parsePackageBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try { res.json(await packages.send({ salonId: req.user.salonId, userId: req.user.userId, ...p.value })); }
  catch (e) { sendError(res, e, logger, 'edocs send'); }
});

router.get('/packages', async (req, res) => {
  const q = req.query || {};
  const status = STATUSES.includes(q.status) ? q.status : null;
  const clientId = posInt(q.clientId);
  const from = isCalendarDate(q.from) ? q.from : null;
  const to = isCalendarDate(q.to) ? q.to : null;
  const page = posInt(q.page) || 1;
  try {
    const r = await store.listPackages(req.user.salonId, { status, clientId, from, to, limit: 50, offset: (page - 1) * 50 });
    res.json({ total: r.total, page, rows: r.rows.map(packageView) });
  } catch (e) { sendError(res, e, logger, 'edocs packages list'); }
});

// id комплекта — UUID: иначе pg бросит «invalid input syntax for type uuid» вместо 404.
function validPackageId(req, res) {
  if (store.UUID_RE.test(String(req.params.id))) return true;
  res.status(404).json({ error: 'Комплект не найден' });
  return false;
}

router.get('/packages/:id', async (req, res) => {
  if (!validPackageId(req, res)) return;
  const sid = req.user.salonId;
  try {
    const p = await store.getPackage(sid, req.params.id);
    if (!p) return res.status(404).json({ error: 'Комплект не найден' });
    const [docs, events] = await Promise.all([store.listDocuments(p.id), store.listEvents(sid, p.id, 30)]);
    res.json({
      ...packageView(p),
      act: (p.payload && p.payload.act) || null,
      patient: (p.payload && p.payload.patient) || null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, fileName: d.file_name, fdocStatus: d.fdoc_status || null,
        clientSignedAt: d.client_signed_at || null, corpSignedAt: d.corp_signed_at || null, hasPdf: !!d.pdf_key })),
      events: events.map((e) => ({ kind: e.kind, payload: e.payload, createdAt: e.created_at, userName: e.user_name || null })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs package get'); }
});

for (const [action, fn] of [['resend', packages.resend], ['employee-url', packages.employeeUrl], ['permalink', packages.permalink], ['annul', packages.annul]]) {
  router.post(`/packages/:id/${action}`, async (req, res) => {
    if (!validPackageId(req, res)) return;
    try { res.json(await fn({ salonId: req.user.salonId, userId: req.user.userId, packageId: req.params.id })); }
    catch (e) { sendError(res, e, logger, `edocs ${action}`); }
  });
}

router.post('/packages/:id/refresh', async (req, res) => {
  if (!validPackageId(req, res)) return;
  const sid = req.user.salonId;
  try {
    const p = await store.getPackage(sid, req.params.id);
    if (!p) return res.status(404).json({ error: 'Комплект не найден' });
    if (p.status === 'draft') throw new EdocsError('not_sent', 'Комплект ещё не принят F.Doc — повторите отправку', 409);
    res.json(await packages.refreshRows(sid, [p]));
  } catch (e) { sendError(res, e, logger, 'edocs refresh'); }
});

router.get('/documents/:id/pdf', async (req, res) => {
  if (!store.UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Документ не найден' });
  try {
    const d = await store.getDocument(req.user.salonId, req.params.id);
    if (!d) return res.status(404).json({ error: 'Документ не найден' });
    if (!d.pdf_key) return res.status(409).json({ error: 'Подписанный PDF ещё не получен — он скачается после подписи пациента' });
    res.json({ url: await s3.presignGet(d.pdf_key, 900) });
  } catch (e) { sendError(res, e, logger, 'edocs pdf'); }
});

module.exports = router;
module.exports.parsePackageBody = parsePackageBody;
