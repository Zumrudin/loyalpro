'use strict';
// Анкета пациента (спека 2026-10-25 §6): пациент сам вносит данные для договора по ссылке —
// в мессенджере или по QR-коду у стойки. Ссылка: <EDOCS_PUBLIC_URL>/anketa/<токен>; в БД — sha256
// токена (поиск) и его шифротекст (показать QR и переотправить ту же ссылку). Публичная сторона
// НИЧЕГО из уже известных данных пациента не показывает, кроме личного имени для приветствия:
// у кого ссылка, тот паспорт не прочитает. Телефон анкетой не меняется — на него F.Doc шлёт SMS.
const crypto = require('crypto');
const QRCode = require('qrcode');
const sharp = require('sharp');
const store = require('./store');
const fstore = require('./forms-store');
const boardStore = require('./board-store');
const packages = require('./packages');
const delivery = require('./form-delivery');
const identity = require('./identity');
const { kindState, BAD } = require('./board');
const secretBox = require('../../utils/secret-box');
const config = require('../../config');
const { FIELDS } = require('./placeholders');
const { resolveGivenName } = require('../../utils/person-name');
const { validateImageBuffer } = require('../../utils/upload-validator');
const { EdocsError, shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsForms');
const FIELD_ORDER = ['last_name', 'first_name', 'middle_name', 'birth_date', 'gender', 'passport_series', 'passport_number',
  'issue_date', 'authority_code', 'issued_by', 'birth_place', 'address', 'email'];
const ALWAYS = ['last_name', 'first_name', 'middle_name'];
const NEVER = new Set(['phone', 'contract_no', 'contract_date']);   // телефон — якорь SMS; договор — сторона клиники
const SECURE = new Set(identity.SECURE_KEYS);
const LABELS = {
  last_name: 'Фамилия', first_name: 'Имя', middle_name: 'Отчество (если есть)', birth_date: 'Дата рождения', gender: 'Пол',
  passport_series: 'Серия паспорта', passport_number: 'Номер паспорта', issue_date: 'Дата выдачи паспорта',
  authority_code: 'Код подразделения', issued_by: 'Кем выдан паспорт', birth_place: 'Место рождения', address: 'Адрес регистрации', email: 'E-mail',
};
const TYPES = { birth_date: 'date', issue_date: 'date', gender: 'gender', email: 'email', passport_series: 'digits', passport_number: 'digits', authority_code: 'code' };
const FORM_KINDS = ['contract', 'consent_pd', 'act'];
const RECOGNIZE_LIMIT = 3;
const ATTEMPT_LIMIT = 20;
const CONSENT_VERSION = 'anketa-v1';
const DEFAULT_MESSAGE = 'Здравствуйте, {имя}! Перед визитом в {клиника} {дата} заполните, пожалуйста, данные для договора — это займёт 2 минуты: {ссылка}';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;
function clampInt(v, min, max, dflt) { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; }
/** { date: 'YYYY-MM-DD', time: 'HH:MM', label: '26 октября, 11:00', phrase: '26 октября в 11:00' } по Москве или null. */
function visitInfo(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return null;
  const parts = Object.fromEntries(MSK.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const day = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}`;
  return { date, time, label: `${day}, ${time}`, phrase: `${day} в ${time}` };
}

/** Какие поля спрашивать: всё, что требуют шаблоны, + ФИО; без телефона и номера/даты договора. */
function fieldsFor(templates) {
  const need = new Set(ALWAYS);
  for (const t of templates || []) for (const name of t.placeholders || []) { const f = FIELDS[name]; if (f) for (const r of f.requires) need.add(r); }
  return FIELD_ORDER.filter((k) => need.has(k) && !NEVER.has(k)).map((k) => ({ key: k, required: k !== 'middle_name' }));
}

/** Шаблоны по умолчанию для видов (первый активный по порядку). */
async function templatesForKinds(salonId, kinds) {
  const active = await store.listTemplates(salonId, { activeOnly: true });
  return kinds.map((k) => active.filter((t) => t.kind === k).sort(bySort)[0]).filter(Boolean);
}

/** Текст сообщения со ссылкой. Нет имени — «Здравствуйте!», а не «Здравствуйте, !». */
function renderMessage(template, { name = '', clinic = '', date = '', url = '' }) {
  return String(template || DEFAULT_MESSAGE)
    .replace(/\{имя\}/g, () => name).replace(/\{клиника\}/g, () => clinic || 'клинику')
    .replace(/\{дата\}/g, () => date).replace(/\{ссылка\}/g, () => url)
    .replace(/,\s*!/g, '!').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

async function givenName(salonId, clientId, client) {
  const row = await store.getIdentityRow(salonId, clientId);
  return (row && row.first_name) || resolveGivenName(client && client.name) || '';
}

async function visitOf(form) {
  const r = form.record_id ? await fstore.recordVisit(form.salon_id, form.record_id) : await fstore.nextVisit(form.salon_id, form.client_id);
  return r ? visitInfo(r.visit_datetime) : null;
}

function publicBaseOr(publicBase) {
  const base = config.EDOCS_PUBLIC_URL || String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new EdocsError('no_public_url', 'Не задан адрес для ссылок анкеты (EDOCS_PUBLIC_URL)', 409);
  return base;
}

async function sendLink({ salonId, form, client, url, settings }) {
  const visit = await visitOf(form);
  const text = renderMessage(settings.form_message, {
    name: await givenName(salonId, form.client_id, client), clinic: await fstore.salonName(salonId), date: visit ? visit.phrase : '', url,
  });
  try {
    const r = await delivery.deliverText({ salonId, phone: client.phone, text });
    await fstore.setDelivered(form.id, r.channel);
    await store.logEvent({ salonId, clientId: form.client_id, kind: 'form_sent', payload: { formId: form.id, channel: r.channel } });
    return { ok: true, channel: r.channel };
  } catch (e) {
    await store.logEvent({ salonId, clientId: form.client_id, kind: 'form_send_error', payload: { formId: form.id, code: (e && e.code) || null, message: shortError(e) } });
    if (e && e.name === 'EdocsError') return { ok: false, code: e.code, error: e.message };
    logger.warn(`анкета ${form.id}: доставка: ${shortError(e)}`);
    return { ok: false, code: 'error', error: 'Не удалось отправить сообщение' };
  }
}

/**
 * Новая анкета. kinds — какие документы отправить после заполнения (по умолчанию договор и согласие);
 * deliver — 'messenger' | 'none' (только ссылка и QR). Прежняя активная анкета пациента отзывается.
 */
async function createForm({ salonId, userId = null, clientId, recordId = null, kinds = null, sendDocs = true, deliver = 'none', source = 'manual', senderUserId = null, publicBase = '' }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const wanted = Array.isArray(kinds) && kinds.length ? [...new Set(kinds)] : ['contract', 'consent_pd'];
  if (wanted.some((k) => !FORM_KINDS.includes(k))) throw new EdocsError('bad_kinds', 'Неизвестный вид документа', 400);
  if (wanted.includes('act') && !recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
  const templates = await templatesForKinds(salonId, wanted);
  if (!templates.length) throw new EdocsError('no_templates', 'Нет активных шаблонов этих документов — загрузите их в настройках', 409);
  const base = publicBaseOr(publicBase);
  const settings = (await store.getSettings(salonId)) || {};
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomUUID(), salon_id: salonId, client_id: client.id, record_id: recordId || null, token_hash: sha256(token),
    token_enc: secretBox.box().encrypt(token), fields: fieldsFor(templates), kinds: templates.map((t) => t.kind), send_docs: !!sendDocs,
    sender_user_id: senderUserId || userId || null, source, created_by: userId || null,
    expires_at: new Date(Date.now() + clampInt(settings.form_ttl_days, 1, 30, 7) * 86400000).toISOString(),
  };
  const revoked = await fstore.insertForm(row);
  for (const id of revoked) await store.logEvent({ salonId, clientId: client.id, kind: 'form_revoked', userId, payload: { formId: id, reason: 'replaced' } });
  await store.logEvent({ salonId, clientId: client.id, kind: 'form_created', userId, payload: { formId: row.id, source, kinds: row.kinds, sendDocs: row.send_docs, fields: row.fields.map((f) => f.key) } });
  const url = `${base}/anketa/${token}`;
  const out = { formId: row.id, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: row.expires_at, delivery: null };
  if (deliver === 'messenger') out.delivery = await sendLink({ salonId, form: row, client, url, settings });
  return out;
}

async function activeForm(salonId, formId) {
  const form = await fstore.getForm(salonId, formId);
  if (!form) throw new EdocsError('not_found', 'Анкета не найдена', 404);
  if (form.status !== 'active' || Date.parse(form.expires_at) <= Date.now()) throw new EdocsError('form_inactive', 'Анкета уже не действует — создайте новую', 409);
  return form;
}

/** Ссылка и QR действующей анкеты (тот же токен). */
async function formLink({ salonId, formId, publicBase = '' }) {
  const form = await activeForm(salonId, formId);
  const url = `${publicBaseOr(publicBase)}/anketa/${secretBox.box().decrypt(form.token_enc)}`;
  return { formId: form.id, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: new Date(form.expires_at).toISOString() };
}

/** Переотправить ту же ссылку в мессенджер (кнопка «Повторить анкету», автоматика). */
async function resendForm({ salonId, formId, publicBase = '' }) {
  const form = await activeForm(salonId, formId);
  const client = await store.getClient(salonId, form.client_id);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const url = `${publicBaseOr(publicBase)}/anketa/${secretBox.box().decrypt(form.token_enc)}`;
  return sendLink({ salonId, form, client, url, settings: (await store.getSettings(salonId)) || {} });
}

async function revokeForm({ salonId, formId, userId = null }) {
  const r = await fstore.revoke(salonId, formId);
  if (!r) throw new EdocsError('form_inactive', 'Анкета уже не действует', 409);
  await store.logEvent({ salonId, clientId: r.client_id, kind: 'form_revoked', userId, payload: { formId, reason: 'manual' } });
  return { ok: true };
}

/** Крон: устаревшие активные анкеты → expired. */
async function expireForms() {
  const rows = await fstore.expireDue();
  for (const r of rows) await store.logEvent({ salonId: r.salon_id, clientId: r.client_id, kind: 'form_expired', payload: { formId: r.id } });
  return rows.length;
}

// ── публичная сторона ──
async function findByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return { form: null, state: 'not_found' };
  const form = await fstore.getFormByHash(sha256(token));
  if (!form) return { form: null, state: 'not_found' };
  if (form.status === 'active' && Date.parse(form.expires_at) <= Date.now()) return { form, state: 'expired' };
  return { form, state: form.status };
}
const GONE = {
  not_found: ['form_not_found', 'Ссылка не найдена', 404], submitted: ['form_submitted', 'Анкета уже заполнена — спасибо!', 410],
  revoked: ['form_revoked', 'Ссылка больше не действует — попросите клинику прислать новую', 410],
  expired: ['form_expired', 'Срок действия ссылки истёк — попросите клинику прислать новую', 410],
};
async function mustActive(token) {
  const r = await findByToken(token);
  if (r.state === 'active') return r.form;
  const [code, msg, st] = GONE[r.state] || GONE.not_found;
  throw new EdocsError(code, msg, st);
}

async function canRecognize(form, settings) {
  if (!settings || !settings.enabled || !settings.corp_id || !form.sender_user_id) return false;
  if (Number(form.recognize_count) >= RECOGNIZE_LIMIT) return false;
  const cred = await store.getCredentials(form.salon_id, form.sender_user_id);
  return !!(cred && cred.fail_count < 3);
}

/** Что показать пациенту. Состояние не «active» — только статус. */
async function publicView(token) {
  const { form, state } = await findByToken(token);
  if (state !== 'active') return { status: state };
  const client = await store.getClient(form.salon_id, form.client_id);
  const settings = await store.getSettings(form.salon_id);
  if (await fstore.markOpened(form.id)) await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_opened', payload: { formId: form.id } });
  return {
    status: 'active', clinic: await fstore.salonName(form.salon_id), greetingName: await givenName(form.salon_id, form.client_id, client),
    visit: await visitOf(form),
    fields: (form.fields || []).map((f) => ({ key: f.key, label: LABELS[f.key] || f.key, type: TYPES[f.key] || 'text', required: !!f.required })),
    canRecognize: await canRecognize(form, settings), policyUrl: config.CERT_REQUEST_POLICY_URL || '',
  };
}

/** Документы после заполнения: только те, что ещё не подписаны и не ждут подписи. Не бросает. */
async function sendDocsAfter(form) {
  try {
    const templates = await templatesForKinds(form.salon_id, form.kinds || []);
    const docs = await boardStore.listDocsForClients(form.salon_id, [form.client_id]);
    const need = templates.filter((t) => BAD.has(kindState(docs, t.kind, { recordId: form.record_id }).state));
    if (!need.length) return null;
    const r = await packages.send({ salonId: form.salon_id, userId: form.sender_user_id, clientId: form.client_id, templateIds: need.map((t) => t.id),
      recordId: need.some((t) => t.kind === 'act') ? form.record_id : null, source: 'form' });
    await fstore.setResult(form.id, { packageId: r.packageId });
    await store.logEvent({ salonId: form.salon_id, packageId: r.packageId, clientId: form.client_id, kind: 'form_docs_sent', payload: { formId: form.id } });
    return r.packageId;
  } catch (e) {
    try { await fstore.setResult(form.id, { error: shortError(e) }); } catch (_) { /* журнал ниже всё равно запишется */ }
    await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_docs_error', payload: { formId: form.id, code: (e && e.code) || null, message: shortError(e) } });
    logger.warn(`анкета ${form.id}: документы не отправлены: ${shortError(e)}`);
    return null;
  }
}

/**
 * Пациент отправил анкету. Поля — только из form.fields; телефон берётся из данных или карточки.
 * Возвращает { ok, docs: 'sending'|'none', _background } — _background (промис отправки документов)
 * только для тестов, роутер его не отдаёт.
 */
async function publicSubmit(token, body, { ip = '' } = {}) {
  const form = await mustActive(token);
  if ((await fstore.incAttempts(form.id)) > ATTEMPT_LIMIT) throw new EdocsError('too_many_attempts', 'Слишком много попыток — попросите клинику прислать новую ссылку', 429);
  const b = body || {};
  if (b.consent !== true) throw new EdocsError('consent', 'Подтвердите согласие на обработку персональных данных', 400);
  const sid = form.salon_id;
  const client = await store.getClient(sid, form.client_id);
  if (!client) throw new EdocsError('form_not_found', 'Ссылка не найдена', 404);
  const row = await store.getIdentityRow(sid, form.client_id);
  const cur = identity.decodeRow(row, row && row.secure_enc ? secretBox.box() : null) || { plain: {}, secure: {} };
  const merged = { ...cur.plain, secure: { ...cur.secure } };
  for (const f of form.fields || []) {
    const v = b[f.key] === undefined || b[f.key] === null ? '' : String(b[f.key]);
    if (SECURE.has(f.key)) merged.secure[f.key] = v; else merged[f.key] = v;
  }
  if (!merged.phone) merged.phone = client.phone || '';
  const v = identity.validateIdentity(merged);
  if (v.error) throw new EdocsError('bad_field', v.error, 400);
  const empty = (form.fields || []).filter((f) => f.required && !String((SECURE.has(f.key) ? v.value.secure[f.key] : v.value.plain[f.key]) || '').trim());
  if (empty.length) throw new EdocsError('missing_fields', `Заполните: ${empty.map((f) => (LABELS[f.key] || f.key).toLowerCase()).join(', ')}`, 400);
  const enc = identity.encodeSecure(v.value.secure, secretBox.box());
  const consent = { accepted: true, at: new Date().toISOString(), version: CONSENT_VERSION, policyUrl: config.CERT_REQUEST_POLICY_URL || '', ipHash: sha256(`${form.id}:${ip}`).slice(0, 16) };
  if (!(await fstore.markSubmitted(form.id, consent))) throw new EdocsError('form_submitted', 'Анкета уже заполнена — спасибо!', 410);
  try {
    await store.upsertIdentity(sid, form.client_id, { plain: v.value.plain, secure_enc: enc.secure_enc, secure_fields: enc.secure_fields, source: 'patient_form', userId: null });
  } catch (e) {
    try { await fstore.reopen(form.id); } catch (_) { /* исходная ошибка важнее */ }   // данные не сохранились — пусть пациент повторит
    throw e;
  }
  await store.logEvent({ salonId: sid, clientId: form.client_id, kind: 'identity_edit', payload: { source: 'patient_form', plain: Object.keys(v.value.plain).filter((k) => v.value.plain[k]), secure: enc.secure_fields } });
  await store.logEvent({ salonId: sid, clientId: form.client_id, kind: 'form_submitted', payload: { formId: form.id, fields: (form.fields || []).map((f) => f.key) } });
  const background = form.send_docs ? sendDocsAfter(form) : null;
  return { ok: true, docs: form.send_docs ? 'sending' : 'none', _background: background };
}

/** Фото паспорта с публичной страницы → поля для формы пациента (фото не сохраняется). */
async function publicPhoto(token, file) {
  const form = await mustActive(token);
  if (!file || !file.buffer) throw new EdocsError('bad_image', 'Приложите фото паспорта', 400);
  const check = validateImageBuffer(file.buffer, file.originalname);
  if (!check.ok) throw new EdocsError('bad_image', check.error, 400);
  const settings = await store.getSettings(form.salon_id);
  if (!(await canRecognize(form, settings))) throw new EdocsError('recognize_unavailable', 'Распознавание сейчас недоступно — введите данные вручную', 409);
  if (!(await fstore.takeRecognize(form.id, RECOGNIZE_LIMIT))) throw new EdocsError('recognize_limit', 'Распознать можно не больше 3 раз — введите данные вручную', 429);
  let jpeg;
  try {
    jpeg = await sharp(file.buffer).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch (e) { throw new EdocsError('bad_image', 'Не удалось прочитать фото — снимите ещё раз', 400); }
  const result = await packages.recognize({ salonId: form.salon_id, userId: form.sender_user_id, imageBase64: jpeg.toString('base64') });
  await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_photo', payload: { formId: form.id, recognized: !!result } });
  if (!result) return { recognized: false, fields: {} };
  const r = identity.fromRecognized(result);
  const keys = new Set((form.fields || []).map((f) => f.key));
  const fields = {};
  for (const [k, v] of Object.entries({ ...r.plain, ...r.secure })) if (keys.has(k) && v) fields[k] = v;
  return { recognized: true, fields, confidence: r.confidence };
}

module.exports = {
  fieldsFor, renderMessage, visitInfo, createForm, formLink, resendForm, revokeForm, expireForms, sendLink,
  publicView, publicSubmit, publicPhoto, findByToken, LABELS, DEFAULT_MESSAGE, RECOGNIZE_LIMIT, ATTEMPT_LIMIT,
};
