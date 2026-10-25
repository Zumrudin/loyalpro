'use strict';
// /api/edocs/admin — подключение F.Doc, реквизиты клиники, шаблоны документов.
// Только владелец и администратор. Секреты (ключ API, пароль приложения) наружу не
// отдаются никогда — только признак «сохранён». Парсеры экспортируются ради тестов.
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const crypto = require('crypto');
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const docx = require('../services/edocs/docx');
const s3 = require('../services/s3');
const secretBox = require('../utils/secret-box');
const { client: fdoc } = require('../services/fdoc/client');
const { KINDS, ORG_KEYS, validateTags, dictionary } = require('../services/edocs/placeholders');
const { sendError } = require('../services/edocs/errors');
const counter = require('../services/edocs/counter');
const forms = require('../services/edocs/forms');
const config = require('../config');
const { db } = require('../db');
const { isCalendarDate, todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsAdminAPI');
const URL_ERR = 'Адрес F.Doc — https://… на домене fdoc.ru';
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: docx.MAX_TEMPLATE_BYTES, files: 1 } });

const str = (v, max) => String(v === undefined || v === null ? '' : v).replace(CONTROL_RE, '').trim().slice(0, max);
const idParam = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const publicBase = (req) => `${req.protocol}://${req.get('host')}`;
// Шаблон в неподписанном комплекте не удаляется, не заменяется, не выключается и не меняет вид: один ответ на всё.
const templateBusy = (res) => res.status(409).json({ error: 'Шаблон в неподписанном комплекте — дождитесь подписи или аннулируйте комплект' });
const subscribing = new Set();   // салоны, у которых подписка на вебхук F.Doc идёт прямо сейчас (память процесса)

/**
 * Тело PUT /settings. Секреты: undefined/null — не менять, '' — очистить, строка — заменить.
 * Адрес стенда — только https на домене fdoc.ru: туда уходят пароли сотрудников.
 */
function parseSettings(b) {
  b = b || {};
  const out = { enabled: b.enabled === true };
  let u;
  try { u = new URL(String(b.baseUrl || 'https://demo.fdoc.ru').trim()); } catch (e) { return { error: URL_ERR }; }
  if (u.protocol !== 'https:' || !(u.hostname === 'fdoc.ru' || u.hostname.endsWith('.fdoc.ru'))
    || u.username || u.password || u.port || u.search || u.hash || (u.pathname && u.pathname !== '/')) return { error: URL_ERR };
  out.base_url = u.origin;
  for (const [field, col, label] of [['apiKey', 'api_key', 'Ключ API'], ['appPassword', 'app_password', 'Пароль приложения']]) {
    const v = b[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > 500) return { error: `${label}: строка до 500 символов` };
    out[col] = v.trim();
  }
  out.app_login = str(b.appLogin, 200) || null;
  out.app_code = str(b.appCode, 100) || null;
  out.qes_cert_alias = str(b.qesCertAlias, 200) || null;
  out.employee_position = str(b.employeePosition, 200) || null;
  const raw = b.unsignDays;
  const days = raw === undefined || raw === null || raw === '' ? 14 : (typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'Срок подписания — от 1 до 90 дней' };
  out.unsign_days = days;
  const r = b.requisites && typeof b.requisites === 'object' && !Array.isArray(b.requisites) ? b.requisites : {};
  out.requisites = {};
  for (const k of ORG_KEYS) {
    const v = str(r[k], ['name', 'address', 'bank'].includes(k) ? 500 : 200);
    if (v) out.requisites[k] = v;
  }
  return { value: out };
}

/** title + kind (+ isActive/sortOrder для PUT). Поля multipart приходят строками. */
function parseTemplateMeta(b, { full = false } = {}) {
  b = b || {};
  const title = String(b.title || '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200) return { error: 'Название — 1–200 символов' };
  if (!KINDS.includes(b.kind)) return { error: 'Вид документа: договор, согласие, акт или другой' };
  const out = { title, kind: b.kind };
  if (full) {
    out.is_active = !(b.isActive === false || b.isActive === 'false');
    const so = b.sortOrder === undefined || b.sortOrder === null || b.sortOrder === '' ? 0 : Number(b.sortOrder);
    if (!Number.isInteger(so) || so < 0 || so > 9999) return { error: 'Порядок — целое от 0 до 9999' };
    out.sort_order = so;
  }
  return { value: out };
}

function uploadDocx(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Шаблон больше 10 МБ' : 'Не удалось принять файл' });
    if (!req.file) return res.status(400).json({ error: 'Приложите файл .docx' });
    if (!/\.docx$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'Нужен файл Word в формате .docx' });
    return next();
  });
}

router.use(auth, requireRole('owner', 'admin'));

// ── подключение и реквизиты ──
router.get('/settings', async (req, res) => {
  try {
    const s = (await store.getSettings(req.user.salonId)) || {};
    res.json({
      enabled: !!s.enabled, baseUrl: s.base_url || 'https://demo.fdoc.ru', appLogin: s.app_login || '', appCode: s.app_code || '',
      corpId: s.corp_id || null, qesCertAlias: s.qes_cert_alias || '', employeePosition: s.employee_position || '',
      unsignDays: s.unsign_days || 14, requisites: s.requisites || {},
      hasApiKey: !!s.api_key_enc, hasAppPassword: !!s.app_password_enc,
      webhookUrl: s.webhook_secret ? `${publicBase(req)}/fdoc/webhook/${s.webhook_secret}` : null,
      lastWebhookAt: s.last_webhook_at || null, encReady: secretBox.isConfigured(),
    });
  } catch (e) { sendError(res, e, logger, 'edocs settings get'); }
});

router.put('/settings', async (req, res) => {
  const p = parseSettings(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const sid = req.user.salonId;
  const v = p.value;
  try {
    const cur = (await store.getSettings(sid)) || {};
    const patch = {
      enabled: v.enabled, base_url: v.base_url, app_login: v.app_login, app_code: v.app_code, qes_cert_alias: v.qes_cert_alias,
      employee_position: v.employee_position, unsign_days: v.unsign_days, requisites: v.requisites,
    };
    if (v.api_key !== undefined) patch.api_key_enc = v.api_key ? secretBox.box().encrypt(v.api_key) : null;
    if (v.app_password !== undefined) patch.app_password_enc = v.app_password ? secretBox.box().encrypt(v.app_password) : null;
    // Сменился стенд, ключ или приложение — прежний corpId недействителен: нужна новая проверка.
    const reverify = v.base_url !== (cur.base_url || null) || v.api_key !== undefined || v.app_password !== undefined
      || v.app_login !== (cur.app_login || null) || v.app_code !== (cur.app_code || null);
    if (reverify) patch.corp_id = null;
    if (v.enabled && (reverify || !cur.corp_id)) return res.status(400).json({ error: 'Включить модуль можно после успешной проверки подключения' });
    await store.saveSettings(sid, patch);
    res.json({ ok: true, needVerify: reverify });
  } catch (e) { sendError(res, e, logger, 'edocs settings save'); }
});

router.post('/settings/verify', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const row = await store.getSettings(sid);
    const cfg = packages.fdocConfig(row, { requireCorp: false, requireEnabled: false });
    const corpId = await fdoc.verifyApiKey(cfg);
    // Проверка шла по сети: PUT /settings мог за это время сохранить другой ключ или стенд и сбросить corp_id.
    // Пишем только если подключение осталось таким, каким читали до проверки, — иначе новый ключ стал бы «проверенным».
    if (!(await store.saveCorpIdIfUnchanged(sid, corpId, row))) {
      return res.status(409).json({ error: 'Настройки изменились во время проверки — проверьте ещё раз' });
    }
    res.json({ corpId });
  } catch (e) { sendError(res, e, logger, 'edocs verify'); }
});

router.get('/settings/tariff', async (req, res) => {
  try {
    const cfg = packages.fdocConfig(await store.getSettings(req.user.salonId), { requireEnabled: false });
    res.json({ tariffs: await fdoc.tariffInfo(cfg) });
  } catch (e) { sendError(res, e, logger, 'edocs tariff'); }
});

// Подписка на вебхук SetStatus. Перед ней F.Doc должен зарегистрировать IP сервера.
router.post('/settings/webhook', async (req, res) => {
  const sid = req.user.salonId;
  // Два одновременных вызова создали бы по своему секрету: в БД остался бы один, а в F.Doc — другой.
  if (subscribing.has(sid)) return res.status(409).json({ error: 'Подписка уже выполняется' });
  subscribing.add(sid);
  try {
    const row = await store.getSettings(sid);
    const cfg = packages.fdocConfig(row, { requireEnabled: false });
    const secret = row.webhook_secret || crypto.randomBytes(24).toString('hex');
    if (!row.webhook_secret) await store.saveSettings(sid, { webhook_secret: secret });
    const url = `${publicBase(req)}/fdoc/webhook/${secret}`;
    await fdoc.putWebhooks(cfg, url);
    res.json({ url });
  } catch (e) { sendError(res, e, logger, 'edocs webhook subscribe'); } finally { subscribing.delete(sid); }
});

router.get('/users', async (req, res) => {
  try {
    const rows = await store.listUsersWithCredentials(req.user.salonId);
    res.json({ users: rows.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.is_active,
      connected: !!u.login, login: u.login || null, lastOkAt: u.last_ok_at || null, broken: (u.fail_count || 0) >= 3, lastError: u.last_error || null,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs users'); }
});

// ── автоматика, анкета, нумерация договоров (спека 2026-10-25 §7, §9) ──
/**
 * Тело PUT /automation. Флаги — строго boolean; числа — в своих границах; текст анкеты обязан
 * содержать {ссылка} (без неё сообщение бесполезно), пустой — текст по умолчанию.
 */
function parseAutomation(b, { today = todayMsk() } = {}) {
  b = b || {};
  const int = (v, min, max, dflt, label) => {
    if (v === undefined || v === null || v === '') return { v: dflt };
    const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
    return Number.isInteger(n) && n >= min && n <= max ? { v: n } : { error: `${label}: целое от ${min} до ${max}` };
  };
  const flag = (v, label) => (v === undefined || v === true || v === false ? { v: v === true } : { error: `${label}: да или нет` });
  const pv = b.previsit || {}, act = b.act || {}, rm = b.remind || {};
  const checks = {
    auto_previsit: flag(pv.on, 'Перед визитом'), auto_previsit_hours: int(pv.hours, 2, 168, 24, 'Часов до визита'),
    auto_previsit_form: flag(pv.form === undefined ? true : pv.form, 'Анкета, если данных не хватает'),
    auto_act: flag(act.on, 'Акт после оплаты'), auto_act_delay_min: int(act.delayMin, 5, 240, 15, 'Минут после оплаты'),
    auto_remind: flag(rm.on, 'Повтор'), auto_remind_hours: int(rm.hours, 1, 48, 2, 'Часов до повтора'),
    form_ttl_days: int(b.formTtlDays, 1, 30, 7, 'Срок жизни анкеты'),
    contract_autonumber: flag(b.contractAutonumber === undefined ? true : b.contractAutonumber, 'Автонумерация договоров'),
  };
  const out = {};
  for (const [k, r] of Object.entries(checks)) { if (r.error) return { error: r.error }; out[k] = r.v; }
  out.auto_previsit_scope = pv.scope === 'all' ? 'all' : 'first';
  if (pv.scope !== undefined && !['all', 'first'].includes(pv.scope)) return { error: 'Кому: первичным или всем' };
  const sender = b.senderUserId === undefined || b.senderUserId === null || b.senderUserId === '' ? null : idParam(b.senderUserId);
  if (b.senderUserId && !sender) return { error: 'Неверный сотрудник' };
  if ((out.auto_previsit || out.auto_act || out.auto_remind) && !sender) return { error: 'Выберите сотрудника, от имени которого автоматика отправляет документы' };
  out.auto_sender_user_id = sender;
  const msg = b.formMessage === undefined || b.formMessage === null ? '' : String(b.formMessage).replace(/\r/g, '').trim();
  if (msg.length > 1000) return { error: 'Текст сообщения — до 1000 символов' };
  if (msg && !msg.includes('{ссылка}')) return { error: 'В тексте сообщения нужен {ссылка} — туда подставится адрес анкеты' };
  out.form_message = msg || null;
  if (b.actsRequiredFrom !== undefined && b.actsRequiredFrom !== null && b.actsRequiredFrom !== '') {
    const d = String(b.actsRequiredFrom);
    if (!isCalendarDate(d) || d < '2020-01-01' || d > today) return { error: 'Акты требуются с даты — не позже сегодняшней' };
    out.acts_required_from = d;
  }
  let nextNo;
  if (b.contractNextNo !== undefined && b.contractNextNo !== null && b.contractNextNo !== '') {
    const r = int(b.contractNextNo, 1, 999999999999, null, 'Следующий номер договора');
    if (r.error) return { error: r.error };
    nextNo = r.v;
  }
  return { value: out, nextNo };
}

router.get('/automation', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const s = (await store.getSettings(sid)) || {};
    const [users, numbering, actsFrom] = await Promise.all([
      store.listUsersWithCredentials(sid), counter.peek(sid),
      db.oneOrNone(`SELECT to_char(acts_required_from, 'YYYY-MM-DD') AS d FROM edoc_settings WHERE salon_id=$1`, [sid]),
    ]);
    res.json({
      senderUserId: s.auto_sender_user_id || null,
      senders: users.filter((u) => u.is_active).map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, connected: !!u.login, broken: (u.fail_count || 0) >= 3 })),
      previsit: { on: !!s.auto_previsit, hours: s.auto_previsit_hours || 24, scope: s.auto_previsit_scope || 'first', form: s.auto_previsit_form !== false },
      act: { on: !!s.auto_act, delayMin: s.auto_act_delay_min || 15 },
      remind: { on: !!s.auto_remind, hours: s.auto_remind_hours || 2 },
      formMessage: s.form_message || '', formMessageDefault: forms.DEFAULT_MESSAGE, formTtlDays: s.form_ttl_days || 7,
      contractAutonumber: s.contract_autonumber !== false, contractNext: numbering,
      actsRequiredFrom: (actsFrom && actsFrom.d) || null,
      publicUrlConfigured: !!config.EDOCS_PUBLIC_URL, testPhones: config.EDOCS_TEST_PHONES || [],
    });
  } catch (e) { sendError(res, e, logger, 'edocs automation get'); }
});

router.put('/automation', async (req, res) => {
  const p = parseAutomation(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const sid = req.user.salonId;
  try {
    if (p.value.auto_sender_user_id) {
      const users = await store.listUsersWithCredentials(sid);
      if (!users.some((u) => u.id === p.value.auto_sender_user_id && u.is_active)) return res.status(400).json({ error: 'Сотрудник не найден' });
    }
    await store.saveSettings(sid, p.value);
    if (p.nextNo) await counter.setNext(sid, p.nextNo);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs automation save'); }
});

// ── шаблоны ── (статические пути — ДО /templates/:id)
router.get('/templates/dictionary', (req, res) => res.json(dictionary()));

router.get('/templates', async (req, res) => {
  try { res.json({ templates: await store.listTemplates(req.user.salonId) }); }
  catch (e) { sendError(res, e, logger, 'edocs templates'); }
});

router.post('/templates', uploadDocx, async (req, res) => {
  const m = parseTemplateMeta(req.body);
  if (m.error) return res.status(400).json({ error: m.error });
  const sid = req.user.salonId;
  try {
    const v = validateTags(docx.inspect(req.file.buffer), m.value.kind);
    if (!v.ok) return res.status(400).json({ error: 'Шаблон не прошёл проверку', details: v.errors });
    const key = `edocs/${sid}/templates/${crypto.randomUUID()}.docx`;
    await s3.putObject(key, req.file.buffer, docx.DOCX_MIME);
    const id = await store.insertTemplate(sid, { ...m.value, file_key: key, file_size: req.file.size, placeholders: v.placeholders, created_by: req.user.userId });
    res.json({ id, placeholders: v.placeholders });
  } catch (e) { sendError(res, e, logger, 'edocs template upload'); }
});

router.put('/templates/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const m = parseTemplateMeta(req.body, { full: true });
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  if (m.error) return res.status(400).json({ error: m.error });
  const sid = req.user.salonId;
  try {
    const t = await store.getTemplate(sid, id);
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    const v = validateTags(Object.fromEntries((t.placeholders || []).map((n) => [n, {}])), m.value.kind);
    if (!v.ok) return res.status(400).json({ error: 'Вид документа не подходит к тегам шаблона', details: v.errors });
    // Смена вида и выключение — как удаление: пока шаблон в неподписанном комплекте, повтор отправки собрал бы
    // документ уже по-новому. Название, порядок и включение можно всегда.
    const risky = m.value.kind !== t.kind || (t.is_active && !m.value.is_active);
    if (risky && await store.isTemplateBusy(sid, id)) return templateBusy(res);
    await store.updateTemplateMeta(sid, id, m.value);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs template update'); }
});

router.post('/templates/:id/file', uploadDocx, async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  const sid = req.user.salonId;
  try {
    const t = await store.getTemplate(sid, id);
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    // Замена меняет текст, из которого повтор отправки соберёт документ комплекта, и удаляет прежний файл.
    // Проверяем до разбора и загрузки: отказ не должен оставлять в S3 лишний файл.
    if (await store.isTemplateBusy(sid, id)) return templateBusy(res);
    const v = validateTags(docx.inspect(req.file.buffer), t.kind);
    if (!v.ok) return res.status(400).json({ error: 'Шаблон не прошёл проверку', details: v.errors });
    const key = `edocs/${sid}/templates/${crypto.randomUUID()}.docx`;
    await s3.putObject(key, req.file.buffer, docx.DOCX_MIME);
    const old = await store.replaceTemplateFile(sid, id, { file_key: key, file_size: req.file.size, placeholders: v.placeholders });
    if (old) await s3.deleteObjects([old]).catch((e) => logger.warn(`edocs old template file ${old}: ${e.message}`));
    res.json({ ok: true, placeholders: v.placeholders });
  } catch (e) { sendError(res, e, logger, 'edocs template replace'); }
});

router.get('/templates/:id/file', async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const t = id ? await store.getTemplate(req.user.salonId, id) : null;
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    res.json({ url: await s3.presignGet(t.file_key, 900) });
  } catch (e) { sendError(res, e, logger, 'edocs template file'); }
});

router.delete('/templates/:id', async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  try {
    const r = await store.deleteTemplate(req.user.salonId, id);
    if (r === 'busy') return templateBusy(res);
    if (r === 'missing') return res.status(404).json({ error: 'Шаблон не найден' });
    await s3.deleteObjects([r.fileKey]).catch((e) => logger.warn(`edocs template file ${r.fileKey}: ${e.message}`));
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs template delete'); }
});

module.exports = router;
module.exports.parseSettings = parseSettings;
module.exports.parseTemplateMeta = parseTemplateMeta;
module.exports.parseAutomation = parseAutomation;
