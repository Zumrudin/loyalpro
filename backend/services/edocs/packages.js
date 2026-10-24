'use strict';
// Комплекты «Документов»: сборка DOCX, отправка в F.Doc, повтор без дубля, статусы,
// подписанные PDF и действия по комплекту. Источник истины по статусу — ответ F.Doc
// под нашим токеном; вебхук лишь просит перечитать (routes/fdoc-webhook.js).
// Подписант от клиники — организация (operatorAutoSign + qesCertAlias), отправитель —
// сотрудник под своей учётной записью F.Doc (решение владельца 24.10.2026).
const crypto = require('crypto');
const store = require('./store');
const s3 = require('../s3');
const { client: fdoc } = require('../fdoc/client');
const secretBox = require('../../utils/secret-box');
const docx = require('./docx');
const { missingFor } = require('./placeholders');
const { decodeRow } = require('./identity');
const { buildRenderData } = require('./fill');
const { linesFromRecord, normalizeLines, doctorOf } = require('./act-lines');
const { applyWorkflow } = require('./statuses');
const { EdocsError, shortError } = require('./errors');
const { buildSendBody, safeFileName, uniqueNames, fioOf } = require('./send-body');
const { fmtDate } = require('./format');
const { todayMsk } = require('../../utils/period');
const { createLogger } = require('../../logger');
const config = require('../../config');

const logger = createLogger('Edocs');
const MAX_DOCS = 10;          // предел F.Doc: 10 файлов на комплект
const STATUS_CHUNK = 10;      // предел F.Doc: 10 комплектов в запросе статусов

/** Настройки салона → параметры клиента F.Doc (секреты расшифрованы). */
function fdocConfig(row, { requireCorp = true, requireEnabled = true } = {}) {
  if (requireEnabled && (!row || !row.enabled)) throw new EdocsError('not_enabled', 'Модуль «Документы» выключен в настройках', 409);
  if (!row || !row.api_key_enc || !row.app_login || !row.app_password_enc || !row.app_code) {
    throw new EdocsError('not_configured', 'F.Doc не подключён: заполните ключ API и данные приложения в настройках', 409);
  }
  if (requireCorp && !row.corp_id) throw new EdocsError('not_configured', 'Проверьте подключение к F.Doc в настройках', 409);
  const box = secretBox.box();
  return {
    baseUrl: row.base_url, apiKey: box.decrypt(row.api_key_enc), appLogin: row.app_login,
    appPassword: box.decrypt(row.app_password_enc), appCode: row.app_code, corpId: row.corp_id || null,
  };
}

/** Учётные данные F.Doc пользователя; fallback — любые рабочие в салоне (фоновый опрос). */
async function credFor(salonId, userId, { fallback = false } = {}) {
  let row = userId ? await store.getCredentials(salonId, userId) : null;
  if (fallback && (!row || row.fail_count >= 3)) row = await store.pickCredentials(salonId, userId);
  if (!row) throw new EdocsError('fdoc_no_credentials', 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»', 409);
  if (row.fail_count >= 3) throw new EdocsError('fdoc_credentials_invalid', 'F.Doc трижды не принял ваш пароль — обновите его в «Мой F.Doc»', 409);
  return { userId: row.user_id, login: row.login, password: secretBox.box().decrypt(row.password_enc), failCount: row.fail_count };
}

// Неверный пароль — счётчик отказов (после трёх учётка не используется) и 409 для фронта.
async function withCred(cred, fn) {
  try {
    const r = await fn();
    if (cred.failCount > 0) { await store.markCredentialsOk(cred.userId); cred.failCount = 0; }
    return r;
  } catch (e) {
    if (e && e.code === 'fdoc_credentials_invalid') {
      await store.markCredentialsFail(cred.userId, shortError(e));
      throw new EdocsError('fdoc_credentials_invalid', 'F.Doc не принял логин или пароль — обновите их в «Мой F.Doc»', 409);
    }
    throw e;
  }
}

/** Всё, что нужно для заполнения: настройки, пациент, шаблоны, акт, данные; проверка полноты. */
async function prepare(input, { needFdoc = true, allowMissing = false } = {}) {
  const { salonId, userId, clientId } = input;
  const settingsRow = await store.getSettings(salonId);
  const cfg = needFdoc ? fdocConfig(settingsRow) : null;
  const cred = needFdoc ? await credFor(salonId, userId) : null;
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const ids = [...new Set(input.templateIds || [])];
  if (!ids.length || ids.length > MAX_DOCS) throw new EdocsError('bad_templates', `Выберите от 1 до ${MAX_DOCS} документов`, 400);
  const templates = await store.getTemplatesByIds(salonId, ids);
  if (templates.length !== ids.length || templates.some((t) => !t.is_active)) throw new EdocsError('bad_templates', 'Шаблон не найден или выключен', 400);
  const isAct = templates.some((t) => t.kind === 'act');
  let act = null;
  let record = null;
  if (isAct) {
    if (!input.recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
    record = await store.getRecord(salonId, input.recordId);
    if (!record || record.client_id !== client.id) throw new EdocsError('not_found', 'Визит не найден у этого пациента', 404);
    if (record.attendance !== '1' || record.deleted) throw new EdocsError('act_visit_not_done', 'Акт оформляется только по состоявшемуся визиту', 409);
    const lines = input.actLines ? normalizeLines(input.actLines) : { value: linesFromRecord(record.services) };
    if (lines.error) throw new EdocsError('bad_act_lines', lines.error, 400);
    if (!lines.value.length) throw new EdocsError('bad_act_lines', 'В акте нет ни одной строки', 400);
    const doctor = doctorOf(record.staff);
    act = {
      act_no: String(record.yclients_record_id || record.id), visit_date: record.visit_date,
      doctor_name: doctor.name, doctor_position: doctor.position, lines: lines.value,
    };
  }
  const identityRow = await store.getIdentityRow(salonId, client.id);
  const requisites = (settingsRow && settingsRow.requisites) || {};
  const missing = missingFor(identityRow, templates, requisites);
  if (!allowMissing && (missing.identity.length || missing.org.length)) {
    throw new EdocsError('missing_fields', 'Не хватает данных для выбранных документов', 400, { missing });
  }
  const identity = decodeRow(identityRow, secretBox.box()) || { plain: {}, secure: {}, secure_fields: [] };
  return { salonId, userId, settingsRow: settingsRow || {}, cfg, cred, client, templates, isAct, act, record, identity, requisites, missing, docDate: input.docDate || todayMsk() };
}

async function renderTemplate(ctx, t) {
  const buf = await s3.getObjectBuffer(t.file_key);
  return docx.render(buf, buildRenderData({ identity: ctx.identity, requisites: ctx.requisites, docDate: ctx.docDate, act: t.kind === 'act' ? ctx.act : null }));
}

async function transmit(ctx, packageId, body) {
  try {
    const res = await withCred(ctx.cred, () => fdoc.sendPackage(ctx.cfg, ctx.cred, body));
    await store.markSent(ctx.salonId, packageId, { employeeUrl: (res && res.url) || null, userId: ctx.userId });
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send', userId: ctx.userId, payload: { documents: body.documents.length } });
  } catch (e) {
    await store.markSendError(ctx.salonId, packageId, shortError(e));
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send_error', userId: ctx.userId,
      payload: { code: e.code || null, status: e.status || null, message: shortError(e) } });
    if (e.name === 'EdocsError') { e.packageId = packageId; throw e; }
    throw new EdocsError('fdoc_send_failed', `F.Doc не принял комплект: ${shortError(e)}`, 502, { packageId });
  }
  // Автоподпись клиники могла уже сдвинуть статус — перечитываем сразу; сбой не страшен, догонит опрос.
  try { await refreshRows(ctx.salonId, [await store.getPackage(ctx.salonId, packageId)]); } catch (e) { logger.warn(`edocs refresh after send ${packageId}: ${shortError(e)}`); }
  return { packageId };
}

// Демо-стенд F.Doc шлёт настоящие SMS, а в дев-БД — живые пациенты: туда только тестовые номера.
function assertDemoPhone(ctx) {
  let host = '';
  try { host = new URL(ctx.cfg.baseUrl).hostname; } catch (e) { host = ''; }
  if (!host.startsWith('demo.')) return;
  const allowed = config.EDOCS_DEMO_PHONES || [];
  if (!allowed.includes(String(ctx.identity.plain.phone || ''))) {
    throw new EdocsError('demo_phone_blocked', `Демо-стенд F.Doc: отправка только на тестовые номера (${allowed.join(', ') || 'не заданы'}) — переменная EDOCS_DEMO_PHONES`, 409);
  }
}

/** Собрать комплект из шаблонов и отправить на подписание. */
async function send(input) {
  const ctx = await prepare(input);
  assertDemoPhone(ctx);
  const files = [];
  for (const t of ctx.templates) files.push(await renderTemplate(ctx, t));
  const packageId = crypto.randomUUID();
  const names = uniqueNames(ctx.templates.map((t) => safeFileName(t.title)));
  const docs = ctx.templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, title: t.title, file_name: names[i], sort_order: i }));
  const title = `${ctx.isAct ? 'Акт' : 'Документы'} от ${fmtDate(ctx.docDate)}`;
  await store.insertPackage({
    id: packageId, salon_id: ctx.salonId, client_id: ctx.client.id, record_id: ctx.isAct ? ctx.record.id : null,
    kind: ctx.isAct ? 'act' : 'onboarding', title, sent_by: ctx.userId,
    payload: { templateIds: ctx.templates.map((t) => t.id), docDate: ctx.docDate, act: ctx.act, patient: { fio: fioOf(ctx.identity), phone: ctx.identity.plain.phone } },
  }, docs);
  return transmit(ctx, packageId, buildSendBody({ packageId, title, clientId: ctx.client.id, docs, files, identity: ctx.identity, settings: ctx.settingsRow }));
}

/** Повтор отправки черновика: сначала спросить F.Doc — ответ мог потеряться, а комплект дойти. */
async function resend({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'draft') throw new EdocsError('already_sent', 'Комплект уже принят F.Doc', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  const known = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, [pkg.id]));
  const wf = known.packages.find((x) => x && x.id === pkg.id) || (known.packages.length === 1 ? known.packages[0] : null);
  if (wf) {
    await store.markSent(salonId, pkg.id, { userId });
    await applyOne(salonId, { ...pkg, status: 'sent' }, wf);
    await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'send_recovered', userId, payload: { fdoc: wf.status || null } });
    return { packageId: pkg.id, recovered: true };
  }
  const docs = await store.listDocuments(pkg.id);
  if (docs.some((d) => !d.template_id)) throw new EdocsError('template_gone', 'Шаблон документа удалён — оформите комплект заново', 409);
  const p = pkg.payload || {};
  const ctx = await prepare({ salonId, userId, clientId: pkg.client_id, templateIds: docs.map((d) => d.template_id), recordId: pkg.record_id, actLines: p.act ? p.act.lines : null, docDate: p.docDate });
  assertDemoPhone(ctx);
  const byId = new Map(ctx.templates.map((t) => [t.id, t]));
  const files = [];
  for (const d of docs) files.push(await renderTemplate(ctx, byId.get(d.template_id)));
  return transmit(ctx, pkg.id, buildSendBody({ packageId: pkg.id, title: pkg.title, clientId: pkg.client_id, docs, files, identity: ctx.identity, settings: ctx.settingsRow }));
}

async function applyOne(salonId, row, wf) {
  const docs = await store.listDocuments(row.id);
  const upd = applyWorkflow(row, docs, wf);
  await store.applyStatus(salonId, row.id, upd);
  if (upd.package.unknownStatus) logger.warn(`edocs: незнакомый статус F.Doc «${wf.status}» у комплекта ${row.id}`);
  if (upd.package.status === row.status) return false;
  await store.logEvent({ salonId, packageId: row.id, clientId: row.client_id, kind: 'status', payload: { from: row.status, to: upd.package.status, fdoc: wf.status || null } });
  return true;
}

/** PDF подписанных документов → S3 (только те, что ещё не скачаны). */
async function fetchPdfs(salonId, pkg, cfg) {
  const docs = (await store.listDocuments(pkg.id)).filter((d) => !d.pdf_key);
  if (!docs.length) return 0;
  const cred = await credFor(salonId, pkg.sent_by, { fallback: true });
  let n = 0;
  for (const d of docs) {
    const buf = await withCred(cred, () => fdoc.downloadPdf(cfg, cred, pkg.fdoc_package_guid || pkg.id, d.fdoc_document_guid || d.id));
    const key = `edocs/${salonId}/packages/${pkg.id}/${d.id}.pdf`;
    await s3.putObject(key, buf, 'application/pdf');
    await store.setDocumentPdf(d.id, key);
    n++;
  }
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'pdf', payload: { documents: n } });
  return n;
}

/** Перечитать статусы комплектов одного салона (под учёткой отправителя, иначе любой рабочей). */
async function refreshRows(salonId, rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return { checked: 0, changed: 0 };
  const cfg = fdocConfig(await store.getSettings(salonId));
  let checked = 0, changed = 0;
  const groups = new Map();
  for (const r of list) { const k = r.sent_by || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const [userId, group] of groups) {
    let cred;
    try { cred = await credFor(salonId, userId, { fallback: true }); } catch (e) {
      logger.warn(`edocs: в салоне ${salonId} нет рабочих учётных данных F.Doc — статусы не проверены`);
      continue;
    }
    for (let i = 0; i < group.length; i += STATUS_CHUNK) {
      const chunk = group.slice(i, i + STATUS_CHUNK);
      const res = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, chunk.map((r) => r.fdoc_package_guid || r.id)));
      for (const wf of res.packages) {
        const row = chunk.find((r) => wf && (r.id === wf.id || (r.fdoc_package_guid && r.fdoc_package_guid === wf.id))) || (chunk.length === 1 ? chunk[0] : null);
        if (!row) { logger.warn(`edocs: F.Doc вернул комплект ${wf && wf.id}, которого нет в запросе`); continue; }
        checked++;
        if (await applyOne(salonId, row, wf)) changed++;
      }
      await store.touchStatusCheck(chunk.map((r) => r.id));
    }
  }
  for (const r of list) {
    const fresh = await store.getPackage(salonId, r.id);
    if (fresh && fresh.status === 'signed') await fetchPdfs(salonId, fresh, cfg).catch((e) => logger.warn(`edocs PDF ${r.id}: ${shortError(e)}`));
  }
  return { checked, changed };
}

let pollRunning = false;
/** Фоновый опрос (крон каждые 5 минут): страховка к потерянным вебхукам и докачка PDF. */
async function refreshDue() {
  if (pollRunning) return { skipped: true };
  pollRunning = true;
  try {
    const rows = await store.listDuePackages(200);
    const bySalon = new Map();
    for (const r of rows) { if (!bySalon.has(r.salon_id)) bySalon.set(r.salon_id, []); bySalon.get(r.salon_id).push(r); }
    let checked = 0, changed = 0;
    for (const [salonId, list] of bySalon) {
      try {
        const r = await refreshRows(salonId, list);
        checked += r.checked; changed += r.changed;
      } catch (e) {
        logger.warn(`edocs poll salon ${salonId}: ${shortError(e)}`);
        // Сломанные настройки салона не должны опрашиваться каждый тик подряд.
        try { await store.touchStatusCheck(list.map((x) => x.id)); } catch (_) { /* повторит следующий тик */ }
      }
    }
    return { checked, changed };
  } finally { pollRunning = false; }
}

async function mustPackage(salonId, packageId) {
  const pkg = await store.getPackage(salonId, packageId);
  if (!pkg) throw new EdocsError('not_found', 'Комплект не найден', 404);
  return pkg;
}

/** Ссылка в окно сотрудника — под учёткой ТЕКУЩЕГО пользователя (живёт 30 минут). */
async function employeeUrl({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status === 'draft') throw new EdocsError('not_sent', 'Комплект ещё не принят F.Doc', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  const url = await withCred(cred, () => fdoc.employeeUrl(cfg, cred, pkg.fdoc_package_guid || pkg.id));
  if (!url) throw new EdocsError('fdoc_no_url', 'F.Doc не вернул ссылку', 502);
  await store.setEmployeeUrl(salonId, pkg.id, url);
  return { url };
}

async function permalink({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'sent') throw new EdocsError('bad_status', 'Ссылку можно отправить только по комплекту, который ждёт подписи', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  await withCred(cred, () => fdoc.sendPermalink(cfg, cred, pkg.fdoc_package_guid || pkg.id, [String(pkg.client_id)]));
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'permalink', userId });
  return { ok: true };
}

async function annul({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (!['sent', 'error'].includes(pkg.status)) {
    throw new EdocsError('bad_status', 'Здесь аннулируется только неподписанный комплект; подписанный — в окне F.Doc (нужно соглашение с пациентом)', 409);
  }
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  await withCred(cred, () => fdoc.declinePackage(cfg, cred, pkg.fdoc_package_guid || pkg.id));
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'annul', userId });
  await refreshRows(salonId, [pkg]).catch((e) => logger.warn(`edocs refresh after annul ${pkg.id}: ${shortError(e)}`));
  return { ok: true };
}

/** Заполненный DOCX без отправки (пропуски видны как «________»). F.Doc не нужен. */
async function preview(input) {
  const ctx = await prepare({ ...input, templateIds: [input.templateId] }, { needFdoc: false, allowMissing: true });
  const t = ctx.templates[0];
  const buf = await renderTemplate(ctx, t);
  return { fileName: safeFileName(t.title), base64: buf.toString('base64') };
}

/** Чего не хватает пациенту для набора шаблонов (без исключения — для формы). */
async function check({ salonId, clientId, templateIds }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const templates = await store.getTemplatesByIds(salonId, [...new Set(templateIds || [])]);
  const settingsRow = await store.getSettings(salonId);
  return { missing: missingFor(await store.getIdentityRow(salonId, clientId), templates, (settingsRow && settingsRow.requisites) || {}) };
}

module.exports = {
  send, resend, refreshRows, refreshDue, fetchPdfs, employeeUrl, permalink, annul, preview, check,
  fdocConfig, credFor, MAX_DOCS,
};
