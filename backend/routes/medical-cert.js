// backend/routes/medical-cert.js
'use strict';

const router = require('express').Router();
const multer = require('multer');
const cfg = require('../config');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { createLogger } = require('../logger');
const { buildDefaults } = require('../services/medical-cert-defaults');
const { fillCertificate } = require('../services/medical-cert-pdf');
const tpl = require('../services/medical-cert-template');
const { splitAmount, splitDateParts, splitDoc, sanitizeUpper } = require('../services/medical-cert-layout');

const logger = createLogger('MedicalCert');
const adminOnly = [auth, requireRole('owner', 'admin')];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// salon_id текущего пользователя (JWT-пейлоад использует camelCase salonId)
function salonOf(req) { return req.user.salonId; }

// GET defaults — автозаполняемые поля
router.get('/defaults', adminOnly, async (req, res) => {
  try {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const d = await buildDefaults({ db, clinic: cfg.MEDICAL_CERT_CLINIC, salonId: salonOf(req), clientId, year });
    res.json(d);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'defaults_failed' }); }
});

// Преобразование плоских значений формы в значения полей координат
function mapValues(body) {
  const v = {};
  const set = (k, val) => { if (val !== undefined && val !== null && val !== '') v[k] = val; };
  // Дата → отдельные блоки <prefix>_dd / _mm / _yyyy (каждый позиционируется отдельно).
  const setDate = (prefix, raw) => {
    const p = splitDateParts(raw);
    if (p) { v[prefix + '_dd'] = p.dd; v[prefix + '_mm'] = p.mm; v[prefix + '_yyyy'] = p.yyyy; }
  };
  // Серия и номер → блоки <serie>1/2 (серия 2+2) и <num>1/2 (номер 3+3).
  const setDoc = (serieKey, numKey, raw) => {
    const d = splitDoc(raw);
    if (!d) return;
    if (d.serie1) v[serieKey + '1'] = d.serie1;
    if (d.serie2) v[serieKey + '2'] = d.serie2;
    if (d.number1) v[numKey + '1'] = d.number1;
    if (d.number2) v[numKey + '2'] = d.number2;
  };

  set('cert_number', body.cert_number);
  set('correction_number', body.correction_number);
  set('report_year', body.report_year);
  set('org_name', body.org_name);
  if (body.org_inn) set('org_inn', String(body.org_inn));
  if (body.org_kpp) set('org_kpp', String(body.org_kpp));

  set('payer_last', sanitizeUpper(body.payer_last));
  set('payer_first', sanitizeUpper(body.payer_first));
  set('payer_middle', sanitizeUpper(body.payer_middle));
  if (body.payer_inn) set('payer_inn', String(body.payer_inn));
  setDate('payer_birthdate', body.payer_birthdate);
  if (body.doc_type_code) set('doc_type_code', String(body.doc_type_code));
  setDoc('doc_serie', 'doc_number', body.doc_serie_number);
  setDate('doc_issue_date', body.doc_issue_date);
  set('payer_is_patient', body.payer_is_patient === '1' || body.payer_is_patient === true ? '1' : '0');

  const a1 = splitAmount(body.amount1); if (a1) { v.amount1_rub = a1.rubles; v.amount1_kop = a1.kopecks; }
  const a2 = splitAmount(body.amount2); if (a2) { v.amount2_rub = a2.rubles; v.amount2_kop = a2.kopecks; }

  set('signer_last', sanitizeUpper(body.signer_last));
  set('signer_first', sanitizeUpper(body.signer_first));
  set('signer_middle', sanitizeUpper(body.signer_middle));
  setDate('sign_date', body.sign_date);
  set('pages_count', body.payer_is_patient === '1' ? '1' : '2');

  // Страница 2 — только если плательщик ≠ пациент
  if (body.payer_is_patient !== '1') {
    set('patient_last', sanitizeUpper(body.patient_last));
    set('patient_first', sanitizeUpper(body.patient_first));
    set('patient_middle', sanitizeUpper(body.patient_middle));
    if (body.patient_inn) set('patient_inn', String(body.patient_inn));
    setDate('patient_birthdate', body.patient_birthdate);
    if (body.patient_doc_type) set('patient_doc_type', String(body.patient_doc_type));
    setDoc('patient_serie', 'patient_number', body.patient_doc_serie);
    setDate('patient_doc_date', body.patient_doc_date);
  }
  return v;
}

// POST generate — вернуть PDF
router.post('/generate', adminOnly, async (req, res) => {
  try {
    const active = await tpl.getActiveTemplateForFill(salonOf(req));
    if (!active) return res.status(409).json({ error: 'no_active_template' });
    const values = mapValues(req.body || {});
    const pdf = await fillCertificate({ blank: active.blank, coords: active.coords, values });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="medical-cert.pdf"`);
    res.send(pdf);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'generate_failed' }); }
});

// GET активный шаблон (метаданные + URL)
router.get('/template', adminOnly, async (req, res) => {
  try { res.json((await tpl.getActiveTemplateMeta(salonOf(req))) || {}); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'template_meta_failed' }); }
});

// POST загрузка нового бланка
router.post('/template', adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf_only' });
    const r = await tpl.uploadTemplate(salonOf(req), req.file.buffer, req.file.originalname);
    res.json(r);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'upload_failed' }); }
});

// GET сырой PDF активного бланка — same-origin прокси для pdf.js.
// Браузерный CSP (connect-src 'self') и отсутствие CORS у S3 не дают тянуть
// presigned-URL напрямую из браузера; отдаём байты с того же origin.
router.get('/template/blank', adminOnly, async (req, res) => {
  try {
    const active = await tpl.getActiveTemplateForFill(salonOf(req));
    if (!active) return res.status(409).json({ error: 'no_active_template' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(active.blank);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'blank_failed' }); }
});

// GET/PUT координаты
router.get('/template/coords', adminOnly, async (req, res) => {
  try { res.json(await tpl.getCoords(salonOf(req))); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'coords_get_failed' }); }
});

router.put('/template/coords', adminOnly, async (req, res) => {
  try { await tpl.saveCoords(salonOf(req), req.body); res.json({ ok: true }); }
  catch (e) { logger.error(e.message); res.status(e.message === 'NO_ACTIVE_TEMPLATE' ? 409 : 500).json({ error: 'coords_save_failed' }); }
});

module.exports = router;
