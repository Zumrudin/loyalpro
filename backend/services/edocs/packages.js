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
const counter = require('./counter');
const testPhones = require('./test-phones');
const { fmtDate } = require('./format');
const { todayMsk } = require('../../utils/period');
const { createLogger } = require('../../logger');
const config = require('../../config');

const logger = createLogger('Edocs');
const MAX_DOCS = 10;          // предел F.Doc: 10 файлов на комплект
const STATUS_CHUNK = 10;      // предел F.Doc: 10 комплектов в запросе статусов
const WARN_EVERY_MS = 60 * 60 * 1000;   // WARN о проблеме опроса салона — раз в час на причину (спека §5.4)
const SEND_STALE_MS = 5 * 60 * 1000;    // дольше любой отправки (вход 30 с + POST до 120 с)
const BG_PAUSE_MS = 60 * 60 * 1000;     // пауза фона для учётки, которую F.Doc отверг

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

// Фон не долбит F.Doc неверным паролем: учётку, которую F.Doc отверг в фоне, фон не берёт час —
// иначе крон входил бы ею каждые 5 минут, и F.Doc мог бы запереть её у себя за серию неудачных
// входов. Память процесса; действия пользователя паузу не учитывают, удачный вход её снимает.
const bgPause = new Map();   // `${salonId}:${userId}` → до какого времени (мс) фон учётку не берёт
const pauseKey = (salonId, userId) => `${salonId}:${userId}`;
/** user_id учёток салона на паузе фона (истёкшие паузы вычищаются). */
function pausedUserIds(salonId) {
  const now = Date.now();
  const ids = [];
  for (const [k, until] of bgPause) {
    if (until <= now) { bgPause.delete(k); continue; }
    const [s, u] = k.split(':');
    if (s === String(salonId)) ids.push(Number(u));
  }
  return ids;
}
/** Учётку обновили и проверили входом («Мой F.Doc») — фон снова может её брать. */
function clearCredentialPause(salonId, userId) { bgPause.delete(pauseKey(salonId, userId)); }

/**
 * Учётные данные F.Doc пользователя. fallback — для фона: учётку с записанным отказом (пусть человек
 * сначала обновит пароль) и на паузе фон не берёт, вместо неё — любая другая рабочая в салоне.
 */
async function credFor(salonId, userId, { fallback = false } = {}) {
  let row = userId ? await store.getCredentials(salonId, userId) : null;
  if (fallback) {
    const paused = pausedUserIds(salonId);
    if (!row || row.fail_count >= 1 || paused.includes(row.user_id)) row = await store.pickCredentials(salonId, userId, { failBelow: 1, exclude: paused });
  }
  if (!row) throw new EdocsError('fdoc_no_credentials', 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»', 409);
  if (row.fail_count >= 3) throw new EdocsError('fdoc_credentials_invalid', 'F.Doc трижды не принял ваш пароль — обновите его в «Мой F.Doc»', 409);
  return { salonId, userId: row.user_id, login: row.login, password: secretBox.box().decrypt(row.password_enc), failCount: row.fail_count };
}

// Неверный пароль — счётчик отказов (после трёх учётка не используется) и 409 для фронта.
// Фон (опрос, вебхук, докачка PDF) счётчик не меняет и не сбрасывает: сбой входа, общий для всех
// (ключ API, настройки приложения), за несколько тиков запер бы по очереди все учётки салона —
// fallback берёт следующую. Счётчик ведут только действия пользователя.
async function withCred(cred, fn, { background = false } = {}) {
  if (background) {
    try { return await fn(); } catch (e) {
      if (e && e.code === 'fdoc_credentials_invalid') bgPause.set(pauseKey(cred.salonId, cred.userId), Date.now() + BG_PAUSE_MS);
      throw e;
    }
  }
  try {
    const r = await fn();
    clearCredentialPause(cred.salonId, cred.userId);   // вход пользователя удался — пауза фона снята
    if (cred.failCount > 0) { await store.markCredentialsOk(cred.salonId, cred.userId); cred.failCount = 0; }
    return r;
  } catch (e) {
    if (e && e.code === 'fdoc_credentials_invalid') {
      await store.markCredentialsFail(cred.salonId, cred.userId, shortError(e));
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
    // Врач и дата визита — обязательные реквизиты акта: без них пациент подписал бы акт с пропуском
    // «________». Должность врача не обязательна.
    const doctor = doctorOf(record.staff);
    if (!doctor.name) throw new EdocsError('act_no_doctor', 'В визите не указан врач — укажите исполнителя в YClients и повторите', 409);
    if (!record.visit_date) throw new EdocsError('act_no_date', 'У визита нет даты', 409);
    const lines = input.actLines ? normalizeLines(input.actLines) : { value: linesFromRecord(record.services) };
    if (lines.error) throw new EdocsError('bad_act_lines', lines.error, 400);
    if (!lines.value.length) throw new EdocsError('bad_act_lines', 'В акте нет ни одной строки', 400);
    act = {
      act_no: String(record.yclients_record_id || record.id), visit_date: record.visit_date,
      doctor_name: doctor.name, doctor_position: doctor.position, lines: lines.value,
    };
  }
  const identityRow = await store.getIdentityRow(salonId, client.id);
  const requisites = (settingsRow && settingsRow.requisites) || {};
  // Номер договора при включённой автонумерации присвоит send() (counter.ensureContractNo) —
  // его отсутствие отправку не блокирует.
  const autoContractNo = usesAutoContractNo(settingsRow, templates);
  const missing = missingFor(identityRow, templates, requisites, { autoContractNo });
  if (!allowMissing && (missing.identity.length || missing.org.length)) {
    throw new EdocsError('missing_fields', 'Не хватает данных для выбранных документов', 400, { missing });
  }
  const identity = decodeRow(identityRow, secretBox.box()) || { plain: {}, secure: {}, secure_fields: [] };
  return { salonId, userId, settingsRow: settingsRow || {}, cfg, cred, client, templates, isAct, act, record, identity, requisites, missing, autoContractNo, docDate: input.docDate || todayMsk() };
}

/** Автонумерация договоров включена (по умолчанию да; нет строки настроек — тоже да). */
function autonumberOn(settingsRow) { return !settingsRow || settingsRow.contract_autonumber !== false; }
/** Номер присвоит автонумерация: она включена, и номер печатает шаблон договора из набора. */
function usesAutoContractNo(settingsRow, templates) {
  return autonumberOn(settingsRow) && (templates || []).some((t) => t.kind === 'contract' && (t.placeholders || []).includes('contract_no'));
}

/**
 * В комплекте договор, а номера у пациента нет — присвоить ДО сборки DOCX (counter.ensureContractNo
 * сразу пишет его в данные пациента: повтор отправки возьмёт тот же номер, дыр в нумерации нет).
 */
async function assignContractNo(ctx) {
  if (!ctx.autoContractNo || String(ctx.identity.plain.contract_no || '').trim()) return;
  const r = await counter.ensureContractNo({ salonId: ctx.salonId, clientId: ctx.client.id, client: ctx.client, docDate: ctx.docDate });
  ctx.identity.plain.contract_no = r.contractNo;
  if (!ctx.identity.plain.contract_date) ctx.identity.plain.contract_date = ctx.docDate;
  if (r.assigned) {
    await store.logEvent({ salonId: ctx.salonId, clientId: ctx.client.id, kind: 'contract_no', userId: ctx.userId, payload: { contractNo: r.contractNo, source: r.source } });
  }
}

async function renderTemplate(ctx, t) {
  const buf = await s3.getObjectBuffer(t.file_key);
  return docx.render(buf, buildRenderData({ identity: ctx.identity, requisites: ctx.requisites, docDate: ctx.docDate, act: t.kind === 'act' ? ctx.act : null }));
}

// Отправка не прошла. Однозначный отказ (HTTP 4xx) — комплекта в F.Doc нет. Без статуса (сеть,
// таймаут) и 5xx — мог и дойти, поэтому «Повторить» начнёт с проверки (resend). Учётка — как есть.
function sendFailure(e, packageId) {
  if (e && e.name === 'EdocsError') { e.packageId = packageId; return e; }
  const st = Number(e && e.status);
  if (st >= 400 && st < 500) return new EdocsError('fdoc_rejected', `F.Doc не принял комплект: ${shortError(e)}`, 502, { packageId });
  return new EdocsError('fdoc_send_unknown', 'Не удалось подтвердить отправку в F.Doc — откройте комплект и нажмите «Повторить»: сначала проверим, не дошёл ли он', 502, { packageId });
}

/** Отправка в F.Doc. Вызывающий (send/resend) держит замок комплекта. */
async function transmit(ctx, packageId, body) {
  let res;
  try {
    res = await withCred(ctx.cred, () => fdoc.sendPackage(ctx.cfg, ctx.cred, body));
  } catch (e) {
    try { await store.markSendError(ctx.salonId, packageId, shortError(e)); } catch (dbErr) {
      logger.error(`edocs: ошибка отправки комплекта ${packageId} не записана: ${shortError(dbErr)}`);
    }
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send_error', userId: ctx.userId,
      payload: { code: e.code || null, status: e.status || null, message: shortError(e) } });
    throw sendFailure(e, packageId);
  }
  // Комплект принят — дальше сбой только наш, отдельным try: иначе пользователь прочёл бы «F.Doc не
  // принял», а markSendError пометил бы ошибкой уже принятый комплект.
  try {
    // false — статус уже сдвинут перечитыванием: не ошибка, поля отправки всё равно записаны.
    await store.markSent(ctx.salonId, packageId, { employeeUrl: (res && res.url) || null, userId: ctx.userId });
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send', userId: ctx.userId, payload: { documents: body.documents.length } });
  } catch (e) {
    logger.error(`edocs: F.Doc принял комплект ${packageId} (салон ${ctx.salonId}), но отправка не сохранилась: ${(e && e.code) || ''} ${shortError(e)}`);
    throw new EdocsError('saved_partially', 'F.Doc принял комплект, но статус не сохранился — откройте комплект и нажмите «Повторить»: мы найдём его в F.Doc и отметим отправленным', 500, { packageId });
  }
  // Автоподпись клиники могла уже сдвинуть статус — перечитываем сразу. Замок комплекта уже наш
  // (через refreshRows перечитывание ждало бы само себя); сбой не страшен, догонит опрос.
  const fresh = await refreshLocked(ctx.salonId, [packageId]);
  if (fresh.errors.length) logger.warn(`edocs refresh after send ${packageId}: ${shortError(fresh.errors[0])}`);
  return { packageId };
}

// Демо-стенд F.Doc шлёт настоящие SMS, а в дев-БД — живые пациенты: туда только тестовые номера.
// Плюс общий тестовый режим модуля (EDOCS_TEST_PHONES) — на любом стенде.
function assertDemoPhone(ctx) {
  testPhones.assertAllowed(ctx.identity.plain.phone);
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
  await assignContractNo(ctx);
  const files = [];
  for (const t of ctx.templates) files.push(await renderTemplate(ctx, t));
  const packageId = crypto.randomUUID();
  const names = uniqueNames(ctx.templates.map((t) => safeFileName(t.title)));
  const docs = ctx.templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, kind: t.kind, title: t.title, file_name: names[i], sort_order: i }));
  const title = `${ctx.isAct ? 'Акт' : 'Документы'} от ${fmtDate(ctx.docDate)}`;
  // Замок — уже на вставке: черновик сразу виден в списке, и «Повторить» не должно пойти параллельно.
  return exclusive(ctx.salonId, packageId, async () => {
    await store.insertPackage({
      id: packageId, salon_id: ctx.salonId, client_id: ctx.client.id, record_id: ctx.isAct ? ctx.record.id : null,
      kind: ctx.isAct ? 'act' : 'onboarding', title, sent_by: ctx.userId, source: input.source || 'manual',
      payload: { templateIds: ctx.templates.map((t) => t.id), docDate: ctx.docDate, act: ctx.act, patient: { fio: fioOf(ctx.identity), phone: ctx.identity.plain.phone } },
    }, docs);
    return transmit(ctx, packageId, buildSendBody({ packageId, title, clientId: ctx.client.id, docs, files, identity: ctx.identity, settings: ctx.settingsRow }));
  });
}

/** Повтор отправки черновика: сначала спросить F.Doc — ответ мог потеряться, а комплект дойти. */
async function resend({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'draft') throw new EdocsError('already_sent', 'Комплект уже принят F.Doc', 409);
  // Черновик без ошибки моложе 5 минут — отправка, скорее всего, ещё идёт (здесь или в другом
  // процессе), повтор дал бы второй POST. Старше — процесс упал посреди отправки.
  if (!pkg.last_error && !(Date.now() - new Date(pkg.created_at).getTime() > SEND_STALE_MS)) {
    throw new EdocsError('send_in_progress', 'Комплект ещё отправляется — повторить можно через 5 минут после начала отправки', 409);
  }
  return exclusive(salonId, pkg.id, () => resendLocked(salonId, userId, pkg.id));
}

const checkFailed = () => new EdocsError('fdoc_check_failed', 'Не удалось проверить комплект в F.Doc — повторите позже', 502);

// Комплект в F.Doc может быть виден только отправителю — проверяем его учёткой; её нет или она
// заперта — учёткой текущего пользователя.
async function checkCredFor(salonId, pkg, userId) {
  if (pkg.sent_by && pkg.sent_by !== userId) {
    try { return await credFor(salonId, pkg.sent_by); } catch (e) {
      if (!e || !['fdoc_no_credentials', 'fdoc_credentials_invalid'].includes(e.code)) throw e;
    }
  }
  return credFor(salonId, userId);
}

async function resendLocked(salonId, userId, packageId) {
  // Заново под замком: пока ждали, комплект могли отправить или перечитать.
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'draft') throw new EdocsError('already_sent', 'Комплект уже принят F.Doc', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await checkCredFor(salonId, pkg, userId);
  let known;
  try {
    known = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, [pkg.id]));
  } catch (e) {
    if (e && e.name === 'EdocsError' && cred.userId === userId) throw e;   // свой пароль — 409 и «Мой F.Doc»
    logger.warn(`edocs resend ${pkg.id}: проверка в F.Doc не удалась: ${shortError(e)}`);
    throw checkFailed();
  }
  const list = Array.isArray(known && known.packages) ? known.packages : null;
  const fails = Array.isArray(known && known.failures) ? known.failures : null;
  if (!list || !fails) throw checkFailed();
  const ours = (x) => x && (x.id === pkg.id || (pkg.fdoc_package_guid && x.id === pkg.fdoc_package_guid));
  // Единственный комплект без id — тоже наш (F.Doc мог id не вернуть); с чужим id — нет.
  const only = list.length === 1 ? list[0] : null;
  const wf = list.find(ours) || (only && !only.id ? only : null);
  if (wf) {
    // Отправитель — тот, чьей учёткой комплект нашёлся: под ней его и опрашивать.
    await store.markSent(salonId, pkg.id, { userId: cred.userId });
    await applyOne(salonId, { ...pkg, status: 'sent' }, wf);
    await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'send_recovered', userId, payload: { fdoc: wf.status || null } });
    return { packageId: pkg.id, recovered: true };
  }
  // Повторный POST — только если F.Doc однозначно ответил «такого нет»: пустой ответ без failures или
  // NOT_FOUND по нашему id. Иное (другой код, чужой комплект, failure без id) — вслепую задвоили бы
  // комплект у пациента.
  const absent = !list.length && fails.every((f) => f && f.id === pkg.id && String(f.code || '').toUpperCase() === 'NOT_FOUND');
  if (!absent) {
    logger.warn(`edocs resend ${pkg.id}: непонятный ответ F.Doc — packages ${JSON.stringify(list.map((x) => x && x.id))}, failures ${JSON.stringify(fails.map((f) => f && [f.id, f.code]))}`);
    throw checkFailed();
  }
  const docs = await store.listDocuments(salonId, pkg.id);
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
  const docs = await store.listDocuments(salonId, row.id);
  const upd = applyWorkflow(row, docs, wf);
  const applied = await store.applyStatus(salonId, row.id, upd);
  if (upd.package.unknownStatus) pollWarn(salonId, `status:${wf.status}`, `edocs: незнакомый статус F.Doc «${wf.status}» у комплекта ${row.id}`);
  if (!applied || upd.package.status === row.status) return false;
  await store.logEvent({ salonId, packageId: row.id, clientId: row.client_id, kind: 'status', payload: { from: row.status, to: upd.package.status, fdoc: wf.status || null } });
  return true;
}

/** PDF подписанных документов → S3 (только те, что ещё не скачаны). */
async function fetchPdfs(salonId, pkg, cfg) {
  const docs = (await store.listDocuments(salonId, pkg.id)).filter((d) => !d.pdf_key);
  if (!docs.length) return 0;
  const cred = await credFor(salonId, pkg.sent_by, { fallback: true });
  let n = 0;
  for (const d of docs) {
    const buf = await withCred(cred, () => fdoc.downloadPdf(cfg, cred, pkg.fdoc_package_guid || pkg.id, d.fdoc_document_guid || d.id), { background: true });
    const key = `edocs/${salonId}/packages/${pkg.id}/${d.id}.pdf`;
    await s3.putObject(key, buf, 'application/pdf');
    await store.setDocumentPdf(salonId, d.id, key);
    n++;
  }
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'pdf', payload: { documents: n } });
  return n;
}

const warnedAt = new Map();   // `${salonId}:${причина}` → когда писали
/** WARN о проблеме опроса салона — не чаще раза в час на пару салон+причина (иначе — каждый тик крона). */
function pollWarn(salonId, reason, text) {
  const k = `${salonId}:${reason}`;
  const now = Date.now();
  if (warnedAt.has(k) && now - warnedAt.get(k) < WARN_EVERY_MS) return;
  warnedAt.set(k, now);
  logger.warn(text);
}

// Замок комплекта внутри процесса: packageId → идущая операция { salonId, dirty, after }.
// Под ним — отправка (send/resend) и перечитывание статуса: параллельные перечитывания одного
// комплекта (вебхук на каждый SetStatus + крон) дважды качали PDF, дублировали события и
// откатывали статус устаревшим ответом. Перечитывание, запрошенное во время операции, не идёт
// параллельно: комплект помечается «грязным» и перечитывается ОДИН раз после неё — повторный
// SetStatus мог принести более новый статус. Отправка не ждёт, а сразу отказывает (exclusive).
const pkgOps = new Map();

function tryLock(salonId, id) {
  if (pkgOps.has(id)) return false;
  pkgOps.set(id, { salonId, dirty: false, after: null });
  return true;
}

/** Перечитать после текущей операции: один раз на все запросы, пришедшие за время операции. */
function rereadAfter(id) {
  const op = pkgOps.get(id);
  op.dirty = true;
  if (!op.after) {
    let resolve;
    op.after = { promise: new Promise((r) => { resolve = r; }), resolve };
  }
  return op.after.promise;
}

function unlock(id) {
  const op = pkgOps.get(id);
  if (!op || !op.dirty) { pkgOps.delete(id); return; }
  // Замок не освобождаем: им сразу владеет перечитывание — иначе его перехватила бы новая операция.
  pkgOps.set(id, { salonId: op.salonId, dirty: false, after: null });
  const done = (r) => { unlock(id); op.after.resolve(r); };
  refreshLocked(op.salonId, [id]).then(done, (e) => done({ checked: 0, changed: 0, errors: [e] }));
}

/** Операция отправки под замком комплекта: занят — сразу 409, не ждём. */
async function exclusive(salonId, id, fn) {
  if (!tryLock(salonId, id)) throw new EdocsError('busy', 'Комплект уже отправляется', 409);
  try { return await fn(); } finally { unlock(id); }
}

/**
 * Перечитать статусы комплектов одного салона (под учёткой отправителя, иначе любой рабочей).
 * Комплект, по которому идёт другая операция, перечитывается один раз после неё; wait=false —
 * не ждать этого (крон: зависшая чужая операция не должна стопорить опрос всех салонов).
 * Сбой группы или пачки не обрывает остальные; исключение — только если не проверен ни один
 * комплект, а ошибка была (кнопка «Обновить статус» её покажет, refreshDue — в WARN).
 */
async function refreshRows(salonId, rows, { wait = true } = {}) {
  const mine = [];
  const waits = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    if (tryLock(salonId, r.id)) mine.push(r.id); else waits.push(rereadAfter(r.id));
  }
  let res = { checked: 0, changed: 0, errors: [] };
  try { if (mine.length) res = await refreshLocked(salonId, mine); } finally { for (const id of mine) unlock(id); }
  if (wait) {
    for (const w of await Promise.all(waits)) { res.checked += w.checked; res.changed += w.changed; res.errors.push(...w.errors); }
  }
  if (!res.checked && res.errors.length) throw res.errors[0];
  return { checked: res.checked, changed: res.changed };
}

/** Перечитывание под замком: вызывающий держит замки всех ids. Не бросает — ошибки в errors. */
async function refreshLocked(salonId, ids) {
  const out = { checked: 0, changed: 0, errors: [] };
  let cfg;
  const list = [];
  try {
    cfg = fdocConfig(await store.getSettings(salonId));
    // Строки — заново из БД: снимок вызывающего (вебхук, крон) мог устареть, пока шла прошлая
    // операция, и applyOne записал бы по нему дубль события «sent → signed».
    for (const id of ids) { const r = await store.getPackage(salonId, id); if (r) list.push(r); }
  } catch (e) { out.errors.push(e); return out; }
  const groups = new Map();
  for (const r of list) { const k = r.sent_by || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  // Учётка группы; нет рабочей — группа пропускается (часовой WARN).
  const groupCred = async (userId) => {
    try { return await credFor(salonId, userId, { fallback: true }); } catch (e) {
      if (e && e.name === 'EdocsError') pollWarn(salonId, e.code, `edocs: в салоне ${salonId} нет рабочих учётных данных F.Doc — статусы не проверены`);
      else { out.errors.push(e); pollWarn(salonId, (e && e.code) || 'credentials', `edocs: учётные данные F.Doc салона ${salonId}: ${shortError(e)}`); }
      return null;
    }
  };
  for (const [userId, group] of groups) {
    let cred = await groupCred(userId);
    for (let i = 0; i < group.length; i += STATUS_CHUNK) {
      const chunk = group.slice(i, i + STATUS_CHUNK);
      if (cred) {
        try {
          const res = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, chunk.map((r) => r.fdoc_package_guid || r.id)), { background: true });
          for (const wf of res.packages) {
            const row = chunk.find((r) => wf && (r.id === wf.id || (r.fdoc_package_guid && r.fdoc_package_guid === wf.id))) || (chunk.length === 1 ? chunk[0] : null);
            if (!row) { pollWarn(salonId, 'foreign_package', `edocs: F.Doc вернул комплект ${wf && wf.id}, которого нет в запросе`); continue; }
            out.checked++;
            if (await applyOne(salonId, row, wf)) out.changed++;
          }
        } catch (e) {
          out.errors.push(e);
          pollWarn(salonId, (e && e.code) || 'error', `edocs: статусы комплектов салона ${salonId} не проверены: ${shortError(e)}`);
          // Учётка ушла на паузу — остальные пачки группы не входят тем же паролем, а берут другую.
          if (e && e.code === 'fdoc_credentials_invalid') cred = await groupCred(userId);
        }
      }
      // Отметка и после сбоя: сломанная пачка не должна опрашиваться каждый тик подряд.
      try { await store.touchStatusCheck(salonId, chunk.map((r) => r.id)); } catch (e) {
        out.errors.push(e);
        pollWarn(salonId, 'touch', `edocs: отметка проверки статусов салона ${salonId}: ${shortError(e)}`);
      }
    }
  }
  for (const r of list) {
    try {
      const fresh = await store.getPackage(salonId, r.id);
      if (fresh && fresh.status === 'signed') await fetchPdfs(salonId, fresh, cfg);
    } catch (e) { pollWarn(salonId, `pdf:${(e && e.code) || 'error'}`, `edocs PDF ${r.id}: ${shortError(e)}`); }
  }
  return out;
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
        const r = await refreshRows(salonId, list, { wait: false });
        checked += r.checked; changed += r.changed;
      } catch (e) {
        pollWarn(salonId, (e && e.code) || 'error', `edocs poll salon ${salonId}: ${shortError(e)}`);
        // Сломанные настройки салона не должны опрашиваться каждый тик подряд.
        try { await store.touchStatusCheck(salonId, list.map((x) => x.id)); } catch (_) { /* повторит следующий тик */ }
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
  testPhones.assertAllowed((pkg.payload && pkg.payload.patient && pkg.payload.patient.phone) || pkg.client_phone);
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

/**
 * Фото паспорта → распознанные поля (первый результат или null). Интерактивное действие
 * пользователя, поэтому вход идёт через withCred БЕЗ background: неверный пароль F.Doc здесь
 * считается в fail_count, как и в остальных действиях. Фото роутер уже сжал в JPEG; у нас оно не хранится.
 */
async function recognize({ salonId, userId, imageBase64, ext = 'jpg' }) {
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  return withCred(cred, () => fdoc.recognize(cfg, cred, imageBase64, ext));
}

/** Чего не хватает пациенту для набора шаблонов (без исключения — для формы). */
async function check({ salonId, clientId, templateIds }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const templates = await store.getTemplatesByIds(salonId, [...new Set(templateIds || [])]);
  const settingsRow = await store.getSettings(salonId);
  return { missing: missingFor(await store.getIdentityRow(salonId, clientId), templates, (settingsRow && settingsRow.requisites) || {},
    { autoContractNo: usesAutoContractNo(settingsRow, templates) }) };
}

/** Только для тестов: сбросить память процесса (WARN раз в час, паузы учёток фона). */
function _reset() { warnedAt.clear(); bgPause.clear(); }

module.exports = {
  send, resend, refreshRows, refreshDue, fetchPdfs, employeeUrl, permalink, annul, preview, check, recognize,
  fdocConfig, credFor, clearCredentialPause, autonumberOn, usesAutoContractNo, MAX_DOCS, _reset,
};
