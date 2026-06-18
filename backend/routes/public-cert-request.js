// backend/routes/public-cert-request.js
// Публичный роутер (БЕЗ JWT) — форма заявки на справку для встройки в Wix.
'use strict';

const path = require('path');
const router = require('express').Router();
const cfg = require('../config');
const { db } = require('../db');
const { createLogger } = require('../logger');
const svc = require('../services/cert-request');

const logger = createLogger('CertRequestPublic');

// Анти-спам: не более 5 заявок/час на IP. Токены заявления живут 30 минут.
const rateLimit = svc.makeRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const appTokens = svc.makeTokenStore({ ttlMs: 30 * 60 * 1000 });

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// Дата 'YYYY-MM-DD' или '' → null; иначе строка (для DATE-колонок).
function dateOrNull(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null; }

// pg отдаёт DATE как JS Date в локальной полуночи; берём ЛОКАЛЬНЫЕ части,
// иначе toISOString() сдвигает день на -1 в TZ=Europe/Moscow.
function pgDateToISO(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Доступные отчётные годы: текущий и 2 предыдущих (TZ Москвы — сервер уже в ней).
function availableYears() {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2];
}

// Страница-форма: разрешаем встраивание в iframe для доменов из конфига.
router.get('/cert-request/:slug', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).send('Форма не найдена');
    res.removeHeader('X-Frame-Options');
    // Страница встраивается в iframe на чужом домене (Wix). helmet по умолчанию
    // ставит CORP/COOP = same-origin, что в браузерах с COEP отдаёт пустой
    // (серый) фрейм. Для встраиваемого ресурса нужен cross-origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    const ancestors = ["'self'", ...cfg.CERT_REQUEST_FRAME_ANCESTORS].join(' ');
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors ${ancestors}`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '../../frontend/cert-request.html'));
  } catch (e) { logger.error(e.message); res.status(503).send('Сервис временно недоступен'); }
});

// Конфиг формы (публичный): название клиники, годы, степени родства, ссылка на политику.
router.get('/api/public/cert-requests/:slug/config', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });
    res.json({
      clinicName: cfg.MEDICAL_CERT_CLINIC.org_name,
      years: availableYears(),
      relationships: Object.entries(svc.RELATIONSHIP_LABELS).map(([code, label]) => ({ code, label })),
      policyUrl: cfg.CERT_REQUEST_POLICY_URL,
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'config_failed' }); }
});

// Приём заявки.
router.post('/api/public/cert-requests/:slug', async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot: скрытое поле должно быть пустым у людей. Проверяем до запроса в БД.
    if (b.website) return res.json({ ok: true }); // тихо игнорируем бота

    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });

    const ip = clientIp(req);
    if (!rateLimit(ip)) return res.status(429).json({ error: 'too_many_requests' });

    // Валидация.
    const errors = [];
    const samePerson = b.payer_is_patient === true || b.payer_is_patient === '1' || b.payer_is_patient === 'true';
    const year = Number(b.report_year);
    if (!availableYears().includes(year)) errors.push('report_year');
    if (!b.consent) errors.push('consent');
    if (!b.payer_last || !b.payer_first) errors.push('payer_name');
    if (b.payer_inn && !svc.validateInn(b.payer_inn)) errors.push('payer_inn');
    const payerPhone = svc.normalizePhone(b.payer_phone);
    if (payerPhone.length < 10) errors.push('payer_phone');

    let patientPhone = '';
    if (!samePerson) {
      if (!b.patient_last || !b.patient_first) errors.push('patient_name');
      if (b.patient_inn && !svc.validateInn(b.patient_inn)) errors.push('patient_inn');
      patientPhone = svc.normalizePhone(b.patient_phone);
      if (patientPhone.length < 10) errors.push('patient_phone');
      if (!svc.RELATIONSHIP_LABELS[b.relationship]) errors.push('relationship');
    }
    if (errors.length) return res.status(400).json({ error: 'validation', fields: errors });

    // Матчинг: всегда по телефону ПАЦИЕНТА (== плательщика, если одно лицо).
    const matchPhone = samePerson ? payerPhone : patientPhone;
    const { clientId } = await svc.matchPatient({ db, salonId: salon.id, phone: matchPhone });
    const amount = await svc.computeYearAmount({ db, salonId: salon.id, clientId, year });

    const row = await db.one(
      `INSERT INTO cert_requests (
         salon_id, status, report_year, payer_is_patient,
         payer_last, payer_first, payer_middle, payer_birthdate, payer_inn,
         payer_doc_type_code, payer_doc_serie_number, payer_doc_issue_date, payer_phone, payer_email,
         patient_last, patient_first, patient_middle, patient_birthdate, patient_inn,
         patient_doc_type_code, patient_doc_serie_number, patient_doc_issue_date, patient_phone,
         relationship, matched_client_id, computed_amount, consent_at, ip, user_agent
       ) VALUES (
         $1,'new',$2,$3,
         $4,$5,$6,$7,$8,
         $9,$10,$11,$12,$13,
         $14,$15,$16,$17,$18,
         $19,$20,$21,$22,
         $23,$24,$25, now(), $26, $27
       ) RETURNING id`,
      [
        salon.id, year, samePerson,
        b.payer_last, b.payer_first, b.payer_middle || null, dateOrNull(b.payer_birthdate), svc.normalizeInn(b.payer_inn) || null,
        (b.payer_doc_type_code || '').slice(0, 2) || null, b.payer_doc_serie_number || null, dateOrNull(b.payer_doc_issue_date), payerPhone, b.payer_email || null,
        samePerson ? null : b.patient_last, samePerson ? null : b.patient_first, samePerson ? null : (b.patient_middle || null),
        samePerson ? null : dateOrNull(b.patient_birthdate), samePerson ? null : (svc.normalizeInn(b.patient_inn) || null),
        samePerson ? null : ((b.patient_doc_type_code || '').slice(0, 2) || null), samePerson ? null : (b.patient_doc_serie_number || null),
        samePerson ? null : dateOrNull(b.patient_doc_date), samePerson ? null : patientPhone, // поле формы patient_doc_date → колонка patient_doc_issue_date
        samePerson ? null : b.relationship, clientId, amount, ip, String(req.headers['user-agent'] || '').slice(0, 400),
      ]);

    const token = appTokens.put({ requestId: row.id, salonId: salon.id });
    res.json({ ok: true, applicationToken: token });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'submit_failed' }); }
});

// Скачивание «Заявления» по короткоживущему токену.
router.get('/api/public/cert-requests/:slug/application/:token', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });
    const ref = appTokens.get(req.params.token);
    if (!ref || ref.salonId !== salon.id) return res.status(404).json({ error: 'expired' });

    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [ref.requestId, salon.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });

    const pdf = await svc.buildApplicationPdf({
      ...r,
      payer_birthdate: pgDateToISO(r.payer_birthdate),
      payer_doc_issue_date: pgDateToISO(r.payer_doc_issue_date),
      patient_birthdate: pgDateToISO(r.patient_birthdate),
      patient_doc_issue_date: pgDateToISO(r.patient_doc_issue_date),
      clinic_name: cfg.MEDICAL_CERT_CLINIC.org_name,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="zayavlenie.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'application_failed' }); }
});

module.exports = router;
