'use strict';
// /api/edocs — дашборд подписей, страница пациента, «Подписано на бумаге», анкеты пациента
// (спека docs/superpowers/specs/2026-10-25-edocs-board-design.md §11). Монтируется РАНЬШЕ общего
// роутера /api/edocs; роли те же: владелец, администратор, кассир (снять отметку «на бумаге» —
// только владелец/администратор). Все запросы ограничены req.user.salonId (НЕ salon_id).
const router = require('express').Router();
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const boardStore = require('../services/edocs/board-store');
const board = require('../services/edocs/board');
const paper = require('../services/edocs/paper');
const forms = require('../services/edocs/forms');
const counter = require('../services/edocs/counter');
const secretBox = require('../utils/secret-box');
const { missingFor } = require('../services/edocs/placeholders');
const { sendError } = require('../services/edocs/errors');
const { todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsBoardAPI');
const RANGES = ['today', 'tomorrow', 'week', 'open'];
const BASE_FILTERS = Object.keys(boardStore.BASE_FILTERS);
const FORM_KINDS = ['contract', 'consent_pd', 'act'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: paper.MAX_SCAN_BYTES, files: 1 } });

const posInt = (v) => (/^\d{1,9}$/.test(String(v === undefined || v === null ? '' : v)) && Number(v) > 0 ? Number(v) : null);
const publicBase = (req) => `${req.protocol}://${req.get('host')}`;
const idList = (v) => (Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(',')).map(posInt);

router.use(auth, requireRole('owner', 'admin', 'admin_cashier'));

/** Настройки салона для дашборда: строка заводится при первом открытии (acts_required_from = этот день). */
async function boardSettings(salonId) {
  let s = await boardStore.getBoardSettings(salonId);
  if (!s) { await boardStore.ensureSettingsRow(salonId); s = await boardStore.getBoardSettings(salonId); }
  return s || {};
}
async function moduleState(req, s) {
  const c = await store.getCredentials(req.user.salonId, req.user.userId);
  return { enabled: !!s.enabled, configured: !!s.corp_id, encReady: secretBox.isConfigured(),
    me: { connected: !!c, broken: !!(c && c.fail_count >= 3) } };
}
function automationView(s) {
  return {
    previsit: { on: !!s.auto_previsit, hours: s.auto_previsit_hours || 24, scope: s.auto_previsit_scope || 'first', form: s.auto_previsit_form !== false },
    act: { on: !!s.auto_act, delayMin: s.auto_act_delay_min || 15 },
    remind: { on: !!s.auto_remind, hours: s.auto_remind_hours || 2 },
    senderName: s.auto_sender_name || null,
  };
}
/** Предупреждения шапки: шаблонов нет, реквизиты клиники не заполнены (сами карточки про них молчат). */
function boardWarnings(templates, requisites) {
  const out = [];
  const active = templates.filter((t) => t.is_active);
  for (const k of board.KINDS) if (!active.some((t) => t.kind === k)) out.push({ code: 'no_template', kind: k });
  const org = missingFor(null, active.filter((t) => board.KINDS.includes(t.kind)), requisites || {}).org;
  if (org.length) out.push({ code: 'org_missing', fields: org.map((x) => x.label) });
  return out;
}
const settingsForBoard = (s, today) => ({ actsRequiredFrom: s.acts_from || today, autonumber: s.contract_autonumber !== false });

// ── дашборд ──
router.get('/board', async (req, res) => {
  const range = RANGES.includes(req.query.range) ? req.query.range : 'today';
  const sid = req.user.salonId;
  try {
    const s = await boardSettings(sid);
    const today = todayMsk();
    const opts = settingsForBoard(s, today);
    const win = board.windowBounds(today, opts.actsRequiredFrom);
    const records = await boardStore.listBoardRecords(sid, win.from, win.to);
    const ids = [...new Set(records.map((r) => r.client_id))];
    const [docs, identities, formRows, notes, templates] = await Promise.all([
      boardStore.listDocsForClients(sid, ids), boardStore.listIdentitiesForClients(sid, ids), boardStore.listLatestForms(sid, ids),
      boardStore.listAutoNotes(sid, ids), store.listTemplates(sid),
    ]);
    const built = board.buildBoard({ records, docs, identities: new Map(identities.map((i) => [i.client_id, i])), templates, requisites: s.requisites,
      forms: formRows, notes, settings: opts, nowMs: Date.now(), today });
    const cards = board.sliceRange(built.cards, range, today, opts.actsRequiredFrom);
    const { summary, chips } = board.summarize(cards);
    res.json({
      now: new Date().toISOString(), today, range, rangeCounts: board.rangeCounts(built.cards, today, opts.actsRequiredFrom),
      summary, chips, cards, kinds: built.kinds, module: await moduleState(req, s), automation: automationView(s),
      warnings: boardWarnings(templates, s.requisites), actsRequiredFrom: opts.actsRequiredFrom,
    });
  } catch (e) { sendError(res, e, logger, 'edocs board'); }
});

router.get('/board/clients', async (req, res) => {
  const filter = BASE_FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
  const page = posInt(req.query.page) || 1;
  const sid = req.user.salonId;
  try {
    const s = await boardSettings(sid);
    const rows = await boardStore.listBaseClients(sid, { search: String(req.query.search || '').slice(0, 100), filter,
      actsFrom: s.acts_from || todayMsk(), limit: 50, offset: (page - 1) * 50 });
    res.json({ page, filter, total: rows.length ? Number(rows[0].total) : 0, rows: rows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, lastVisitAt: r.last_visit_at || null,
      contract: !!r.contract_signed, consent: !!r.consent_signed, pending: !!r.pending, openActs: Number(r.open_acts) || 0,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs board clients'); }
});

// ── страница пациента ──
router.get('/clients/:id/page', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const s = await boardSettings(sid);
    const today = todayMsk();
    const opts = settingsForBoard(s, today);
    const [identityRow, records, docs, formRows, notes, templates, packages, events] = await Promise.all([
      store.getIdentityRow(sid, id), boardStore.listClientRecords(sid, id, board.addDays(today, -90), board.addDays(today, 30)),
      boardStore.listDocsForClients(sid, [id]), boardStore.listLatestForms(sid, [id]), boardStore.listAutoNotes(sid, [id]),
      store.listTemplates(sid), store.listClientPackages(sid, id, 20), boardStore.listClientEvents(sid, id, 40),
    ]);
    // Паспорт здесь не расшифровывается: полнота — по secure_fields; шифротекст наружу не уходит.
    const identity = identityRow ? { ...identityRow, secure_enc: undefined } : null;
    const page = board.buildClientPage({ client, identity, records, docs, templates, requisites: s.requisites, forms: formRows, notes,
      settings: opts, nowMs: Date.now(), today, focusRecordId: posInt(req.query.record) });
    const ycNo = counter.yclientsNumber(client);
    let numbering = { auto: opts.autonumber, contractNo: (identityRow && identityRow.contract_no) || null, yclientsNo: ycNo, next: null };
    if (opts.autonumber && !numbering.contractNo && !ycNo) numbering.next = (await counter.peek(sid)).next;
    res.json({
      ...page, today, numbering, actsRequiredFrom: opts.actsRequiredFrom, module: await moduleState(req, s),
      identity: identityRow ? { exists: true, source: identityRow.source, updatedAt: identityRow.updated_at, secureFields: identityRow.secure_fields || [] } : { exists: false },
      templates: templates.filter((t) => t.is_active).map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders || [] })),
      packages: packages.map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, recordId: p.record_id || null,
        createdAt: p.created_at, sentAt: p.sent_at || null, signedAt: p.signed_at || null, lastError: p.last_error || null })),
      events: events.map((e) => ({ kind: e.kind, packageId: e.package_id || null, payload: e.payload || {}, createdAt: e.created_at, userName: e.user_name || null })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs client page'); }
});

// ── «Подписано на бумаге» ──
router.post('/clients/:id/paper', (req, res, next) => {
  scanUpload.single('scan')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Скан больше 10 МБ' : 'Не удалось принять файл' });
    return next();
  });
}, async (req, res) => {
  const id = posInt(req.params.id);
  const b = req.body || {};
  const templateIds = idList(b.templateIds);
  if (!id) return res.status(404).json({ error: 'Пациент не найден' });
  if (!templateIds.length || templateIds.some((x) => !x)) return res.status(400).json({ error: 'Отметьте документы' });
  const recordId = b.recordId ? posInt(b.recordId) : null;
  if (b.recordId && !recordId) return res.status(400).json({ error: 'Неверный визит' });
  try {
    res.json(await paper.markPaper({ salonId: req.user.salonId, userId: req.user.userId, clientId: id, templateIds, recordId,
      signedDate: b.signedDate ? String(b.signedDate) : null, note: b.note, file: req.file || null }));
  } catch (e) { sendError(res, e, logger, 'edocs paper'); }
});

router.get('/packages/:id/scan', async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Комплект не найден' });
  try { res.json(await paper.scanUrl({ salonId: req.user.salonId, packageId: req.params.id })); }
  catch (e) { sendError(res, e, logger, 'edocs scan'); }
});

router.post('/packages/:id/paper-revoke', requireRole('owner', 'admin'), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Комплект не найден' });
  try { res.json(await paper.revokePaper({ salonId: req.user.salonId, userId: req.user.userId, packageId: req.params.id, reason: (req.body || {}).reason })); }
  catch (e) { sendError(res, e, logger, 'edocs paper revoke'); }
});

// ── анкета пациента ──
router.post('/clients/:id/forms', async (req, res) => {
  const id = posInt(req.params.id);
  const b = req.body || {};
  if (!id) return res.status(404).json({ error: 'Пациент не найден' });
  if (b.kinds !== undefined && (!Array.isArray(b.kinds) || b.kinds.some((k) => !FORM_KINDS.includes(k)))) return res.status(400).json({ error: 'Неверный список документов' });
  const recordId = b.recordId ? posInt(b.recordId) : null;
  if (b.recordId && !recordId) return res.status(400).json({ error: 'Неверный визит' });
  if (b.deliver !== undefined && !['messenger', 'none'].includes(b.deliver)) return res.status(400).json({ error: 'Способ доставки: messenger или none' });
  try {
    res.json(await forms.createForm({ salonId: req.user.salonId, userId: req.user.userId, clientId: id, recordId, kinds: b.kinds || null,
      sendDocs: b.sendDocs !== false, deliver: b.deliver || 'none', source: 'manual', publicBase: publicBase(req) }));
  } catch (e) { sendError(res, e, logger, 'edocs form create'); }
});

function formId(req, res) {
  if (UUID_RE.test(String(req.params.id))) return req.params.id;
  res.status(404).json({ error: 'Анкета не найдена' });
  return null;
}
router.get('/forms/:id/link', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.formLink({ salonId: req.user.salonId, formId: fid, publicBase: publicBase(req) })); }
  catch (e) { sendError(res, e, logger, 'edocs form link'); }
});
router.post('/forms/:id/send', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.resendForm({ salonId: req.user.salonId, formId: fid, publicBase: publicBase(req) })); }
  catch (e) { sendError(res, e, logger, 'edocs form send'); }
});
router.post('/forms/:id/revoke', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.revokeForm({ salonId: req.user.salonId, formId: fid, userId: req.user.userId })); }
  catch (e) { sendError(res, e, logger, 'edocs form revoke'); }
});

module.exports = router;
