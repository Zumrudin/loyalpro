// backend/services/cert-request.js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATH = path.join(__dirname, '../assets/fonts/PTSans-Regular.ttf');
const RELATIONSHIP_LABELS = {
  spouse: 'супругом(ой)', parent: 'родителем', child: 'ребёнком', ward: 'подопечным',
};

// Коды вида документа (классификатор ФНС): паспорт РФ и свидетельство о рождении.
const DOC_TYPE_PASSPORT = '21';
const DOC_TYPE_BIRTH_CERT = '03';
const PATIENT_DOC_TYPES = new Set([DOC_TYPE_PASSPORT, DOC_TYPE_BIRTH_CERT]);

// Телефон → только цифры (нормализация для хранения и сравнения).
function normalizePhone(raw) {
  return (raw == null ? '' : String(raw)).replace(/\D/g, '');
}

// Телефон → канонический «+7XXXXXXXXXX» или null, если не похоже на рос. номер.
// 8XXXXXXXXXX и 7XXXXXXXXXX и XXXXXXXXXX (10 цифр) приводим к одному виду.
function toRuPhone(raw) {
  let d = normalizePhone(raw);
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  if (d.length !== 10) return null;
  return '+7' + d;
}

// Серия+номер паспорта РФ: ровно 10 цифр (4 серия + 6 номер).
function validatePassportSerieNumber(raw) {
  return /^\d{10}$/.test((raw == null ? '' : String(raw)).replace(/\D/g, ''));
}

// Совершеннолетие на дату ref (по умолчанию — сегодня). birthdate в 'YYYY-MM-DD'.
function isAdult(birthdate, ref = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate || '')) return false;
  const [y, m, d] = birthdate.split('-').map(Number);
  let age = ref.getFullYear() - y;
  const mm = ref.getMonth() + 1;
  if (mm < m || (mm === m && ref.getDate() < d)) age -= 1;
  return age >= 18;
}

// ИНН → только цифры (пользователь может ввести с пробелами/дефисами).
function normalizeInn(raw) {
  return (raw == null ? '' : String(raw)).replace(/\D/g, '');
}

// Контрольные цифры ИНН: 10 знаков (юрлицо) или 12 (физлицо).
function validateInn(raw) {
  const s = normalizeInn(raw);
  if (!/^\d{10}$/.test(s) && !/^\d{12}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const csum = (coeffs) => coeffs.reduce((a, c, i) => a + c * d[i], 0) % 11 % 10;
  if (s.length === 10) {
    return csum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  }
  const n11 = csum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const n12 = csum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return n11 === d[10] && n12 === d[11];
}

// In-memory rate-limit по ключу (IP). now() инъектируется для тестов.
// Истёкшие записи периодически вычищаются, чтобы Map не рос неограниченно
// от разовых IP на долгоживущем сервере.
function makeRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  function prune(t) {
    for (const [k, rec] of hits) if (t >= rec.resetAt) hits.delete(k);
  }
  return function allow(key) {
    const t = now();
    if (hits.size > 1000) prune(t); // дешёвая защита от роста, только при разрастании
    const rec = hits.get(key);
    if (!rec || t >= rec.resetAt) { hits.set(key, { count: 1, resetAt: t + windowMs }); return true; }
    if (rec.count >= max) return false;
    rec.count += 1;
    return true;
  };
}

// In-memory короткоживущие токены (для скачивания «Заявления»).
function makeTokenStore({ ttlMs, now = () => Date.now() }) {
  const m = new Map(); // token -> { value, expiresAt }
  return {
    put(value) {
      const token = crypto.randomBytes(24).toString('hex');
      m.set(token, { value, expiresAt: now() + ttlMs });
      return token;
    },
    // Возвращает значение, пока токен жив. Намеренно МНОГОРАЗОВЫЙ в пределах TTL
    // (клиент может скачать «Заявление» несколько раз за 30 минут).
    get(token) {
      const rec = m.get(token);
      if (!rec) return null;
      if (now() >= rec.expiresAt) { m.delete(token); return null; }
      return rec.value;
    },
  };
}

// Поиск клиента салона по телефону (нормализуем обе стороны сравнения).
async function matchPatient({ db, salonId, phone }) {
  const norm = normalizePhone(phone);
  const tail = norm.slice(-10); // последние 10 цифр — без привязки к префиксу 8/+7
  if (tail.length < 10) return { clientId: null }; // меньше 10 цифр — слишком неоднозначно
  const row = await db.oneOrNone(
    `SELECT id FROM clients
       WHERE salon_id = $1
         AND RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = $2
       LIMIT 1`,
    [salonId, tail]);
  return { clientId: row ? row.id : null };
}

// Сумма оплат клиента за медуслуги за отчётный год (1 января — 31 декабря).
// Источник — YClients (finance «Оказание услуг») с фолбэком на revenue_operations.
// 0, если клиент не сопоставлен. Услуги — только процедуры; товары/абонементы/
// сертификаты/пополнения в налоговый вычет не входят.
async function computeYearAmount({ db, salonId, clientId, year }) {
  const { sumServicePaymentsForYear } = require('./cert-amount');
  return sumServicePaymentsForYear({ db, salonId, clientId, year });
}

// Салон по публичному slug формы.
async function resolveSalonBySlug({ db, slug }) {
  if (!slug) return null;
  return db.oneOrNone(
    'SELECT id, cert_request_slug FROM salons WHERE cert_request_slug=$1',
    [slug]);
}

// «Заявление» — A4-PDF с переносом по ширине.
async function buildApplicationPdf(r) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: false });
  const page = doc.addPage([595, 842]); // A4 в pt
  const black = rgb(0, 0, 0);
  const left = 60, right = 535, size = 12, lh = 18;
  let y = 770;

  const fio = (l, f, m) => [l, f, m].filter(Boolean).join(' ');
  const payerFio = fio(r.payer_last, r.payer_first, r.payer_middle);
  const patientFio = fio(r.patient_last, r.patient_first, r.patient_middle);
  const rel = RELATIONSHIP_LABELS[r.relationship] || 'родственником';

  const purpose = r.payer_is_patient
    ? `за оказанные мне медицинские услуги.`
    : `за медицинские услуги, оказанные ${patientFio}, являющемуся(ейся) мне ${rel}.`;

  const body =
    `Я, ${payerFio}` +
    (r.payer_doc_serie_number ? `, паспорт ${r.payer_doc_serie_number}` : '') +
    (r.payer_doc_issue_date ? `, выдан ${r.payer_doc_issue_date}` : '') +
    (r.payer_inn ? `, ИНН ${r.payer_inn}` : '') +
    `, прошу подготовить справку об оплате медицинских услуг для представления ` +
    `в налоговый орган за ${r.report_year} год ${purpose} ` +
    `Контактный телефон: ${r.payer_phone || '—'}.`;

  // Заголовок
  const title = 'Заявление';
  page.drawText(title, { x: (595 - font.widthOfTextAtSize(title, 16)) / 2, y, size: 16, font, color: black });
  y -= lh * 2;
  if (r.clinic_name) {
    page.drawText(`Кому: ${r.clinic_name}`, { x: left, y, size, font, color: black });
    y -= lh * 2;
  }

  // Тело с переносом по словам
  const words = body.split(/\s+/).filter(Boolean);
  let line = '';
  const flush = () => { if (line) { page.drawText(line, { x: left, y, size, font, color: black }); y -= lh; line = ''; } };
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) > (right - left) && line) { flush(); line = w; }
    else line = trial;
  }
  flush();

  y -= lh * 2;
  page.drawText('Дата: «___» ____________ 20__ г.', { x: left, y, size, font, color: black });
  page.drawText('Подпись: _______________', { x: right - 200, y, size, font, color: black });

  return Buffer.from(await doc.save());
}

module.exports = {
  normalizePhone, toRuPhone, normalizeInn, validateInn, validatePassportSerieNumber, isAdult,
  makeRateLimiter, makeTokenStore,
  matchPatient, computeYearAmount, resolveSalonBySlug,
  buildApplicationPdf, RELATIONSHIP_LABELS,
  DOC_TYPE_PASSPORT, DOC_TYPE_BIRTH_CERT, PATIENT_DOC_TYPES,
};
