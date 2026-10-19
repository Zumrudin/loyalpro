'use strict';
// /api/economics — экономика процедур. ТОЛЬКО владелец (зарплаты и закупки).
// Валидация недоверчивая, как parseRuleBody в routes/reminders.js: тела вне
// контракта — 400 с причиной. Парсеры вынесены наружу ради теста без HTTP.
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
// Любая мутация, влияющая на отчёт, сбрасывает его кэш (report.invalidate).
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const store = require('../services/economics/store');
const report = require('../services/economics/report');
const sync = require('../services/economics/sync');
const { FIXED_CATEGORIES } = require('../services/economics/fixed-categories');
const { EQUIPMENT_SEED } = require('../services/economics/equipment-seed');
const { equipmentMonthly } = require('../services/economics/allocation');
const { createLogger } = require('../logger');
const logger = createLogger('EconomicsAPI');

const MAX_PERIOD_DAYS = 731;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAY_BASES = ['gross', 'net_of_materials'];
const DRIVERS = ['minutes', 'visits'];

const isDate = (s) => ISO.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
// null/''/undefined → null; положительное целое → число; иначе NaN.
const optInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return NaN;
  const s = String(v).trim();
  if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) return NaN;
  return Number(s);
};
function parsePeriodDays(from, to) { return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1; }

// Период — тот же выбор, что у дашборда (from/to или period=today|week|month|quarter|N).
function resolvePeriod(req) {
  const todayMsk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  let { from, to } = req.query || {};
  if (isDate(from) && isDate(to)) { if (from > to) [from, to] = [to, from]; return { from, to }; }
  const preset = String((req.query || {}).period || '').toLowerCase();
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (preset === 'today') return { from: todayMsk, to: todayMsk };
  if (preset === 'week') { const dow = new Date(todayMsk + 'T00:00:00Z').getUTCDay(); return { from: addDays(todayMsk, -(dow === 0 ? 6 : dow - 1)), to: todayMsk }; }
  if (preset === 'month') return { from: todayMsk.slice(0, 8) + '01', to: todayMsk };
  if (preset === 'quarter') { const m = Number(todayMsk.slice(5, 7)); const qm = String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0'); return { from: `${todayMsk.slice(0, 4)}-${qm}-01`, to: todayMsk }; }
  const days = Math.max(1, Number.parseInt((req.query || {}).period || '30', 10) || 30);
  return { from: addDays(todayMsk, -(days - 1)), to: todayMsk };
}

function parsePayRule(b) {
  b = b || {};
  const staff = optInt(b.staffYcId), service = optInt(b.serviceYcId), category = optInt(b.categoryYcId);
  if ([staff, service, category].some(Number.isNaN)) return { error: 'Идентификаторы — целые положительные числа' };
  if (service !== null && category !== null) return { error: 'Правило либо на услугу, либо на категорию' };
  const percent = typeof b.percent === 'number' || typeof b.percent === 'string' ? Number(b.percent) : NaN;
  if (b.percent === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) return { error: 'Процент 0–100' };
  if (!PAY_BASES.includes(b.base)) return { error: 'База: gross или net_of_materials' };
  const fixed = b.fixedPerVisit === undefined || b.fixedPerVisit === null || b.fixedPerVisit === '' ? 0 : Number(b.fixedPerVisit);
  if (!Number.isFinite(fixed) || fixed < 0 || fixed > 1e7) return { error: 'Фикс за визит ≥ 0' };
  const vf = b.validFrom || null, vt = b.validTo || null;
  if ((vf && !isDate(vf)) || (vt && !isDate(vt))) return { error: 'Дата в формате YYYY-MM-DD' };
  if (vf && vt && vf > vt) return { error: 'Период: начало позже конца' };
  return { value: { staff_yc_id: staff, service_yc_id: service, category_yc_id: category, percent, base: b.base, fixed_per_visit: fixed, valid_from: vf, valid_to: vt, note: String(b.note || '').slice(0, 500) } };
}

function parseSettings(b) {
  b = b || {};
  const mult = typeof b.payrollMultiplier === 'number' || typeof b.payrollMultiplier === 'string' ? Number(b.payrollMultiplier) : NaN;
  if (b.payrollMultiplier === '' || !Number.isFinite(mult) || mult < 1 || mult > 3) return { error: 'Множитель ФОТ 1–3' };
  if (!DRIVERS.includes(b.allocationDriver)) return { error: 'Драйвер: minutes или visits' };
  const usn = b.usnRate === undefined ? 15 : (typeof b.usnRate === 'number' || typeof b.usnRate === 'string') && b.usnRate !== '' ? Number(b.usnRate) : NaN;
  if (!Number.isFinite(usn) || usn < 0 || usn > 50) return { error: 'Ставка УСН 0–50' };
  const acq = b.acquiring === undefined ? {} : b.acquiring;
  if (!acq || typeof acq !== 'object' || Array.isArray(acq)) return { error: 'Эквайринг — объект {касса: процент}' };
  const entries = Object.entries(acq);
  if (entries.length > 50) return { error: 'Эквайринг: слишком много касс' };
  const acquiring = {};
  for (const [k, v] of entries) {
    const key = String(k).slice(0, 128);
    const pct = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
    if (!key || key === '__proto__' || v === '' || !Number.isFinite(pct) || pct < 0 || pct > 10) return { error: `Эквайринг «${key}»: процент 0–10` };
    acquiring[key] = pct;
  }
  return { value: { payroll_multiplier: mult, pay_base_includes_bonuses: b.payBaseIncludesBonuses === true, allocation_driver: b.allocationDriver, usn_rate: usn, acquiring } };
}

function parsePriceBody(b) {
  b = b || {};
  if (b.unitPrice === null) return { value: null };
  const p = typeof b.unitPrice === 'number' || typeof b.unitPrice === 'string' ? Number(b.unitPrice) : NaN;
  if (b.unitPrice === '' || !Number.isFinite(p) || p <= 0 || p > 1e7) return { error: 'Цена — число больше 0 (null — снять)' };
  return { value: p };
}

function parseManualCard(b) {
  b = b || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 500) return { error: 'Название нормы 1–500 символов' };
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length || raw.length > 100) return { error: 'Нужна хотя бы одна позиция (не больше 100)' };
  const items = [];
  for (const [i, it] of raw.entries()) {
    const gid = optInt(it && it.goodId);
    const amount = it && (typeof it.amount === 'number' || typeof it.amount === 'string') && it.amount !== '' ? Number(it.amount) : NaN;
    if (!gid) return { error: `Позиция ${i + 1}: товар — целый id` };
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) return { error: `Позиция ${i + 1}: количество больше 0` };
    items.push({ good_id: gid, amount, unit: it.unit ? String(it.unit).slice(0, 50) : null, price_at_sync: null, title: null });
  }
  return { value: { title, items } };
}

async function salonOf(req) {
  return db.oneOrNone('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
}
function periodOr400(req, res) {
  const p = resolvePeriod(req);
  const days = parsePeriodDays(p.from, p.to);
  if (!(days >= 1 && days <= MAX_PERIOD_DAYS)) { res.status(400).json({ error: `Период не больше ${MAX_PERIOD_DAYS} дней` }); return null; }
  return p;
}
// Отчётные ручки: салон должен существовать (иначе 404, а не TypeError в отчёте).
async function salonOr404(req, res) {
  const salon = await salonOf(req);
  if (!salon) { res.status(404).json({ error: 'Салон не найден' }); return null; }
  return salon;
}
const fail = (res, label) => (e) => { logger.warn(`${label}: ${e.message}`); res.status(500).json({ error: e.message }); };
const idParam = (v) => Number(v);

router.use(auth, requireRole('owner'));

// ── отчёт ──
router.get('/services', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    const r = await report.buildReport(salon, p.from, p.to);
    res.json({ from: p.from, to: p.to, services: r.byService, byServiceStaff: r.byServiceStaff, summary: r.summary, settings: r.settings });
  } catch (e) { fail(res, 'services')(e); }
});
router.get('/services/:serviceId(\\d+)', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    const d = await report.serviceDetail(salon, idParam(req.params.serviceId), p.from, p.to);
    if (!d) return res.status(404).json({ error: 'Услуга без визитов в периоде' });
    res.json({ from: p.from, to: p.to, ...d });
  } catch (e) { fail(res, 'service detail')(e); }
});
router.get('/coverage', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    res.json({ from: p.from, to: p.to, ...(await report.coverage(salon, p.from, p.to)) });
  } catch (e) { fail(res, 'coverage')(e); }
});

// ── товары и цены ──
router.get('/goods', async (req, res) => {
  try {
    const search = String(req.query.search || '').slice(0, 100);
    res.json({ goods: await store.listGoods(req.user.salonId, { search, onlyConsumables: req.query.only_consumables === '1' }) });
  } catch (e) { fail(res, 'goods')(e); }
});
router.get('/goods/:goodId(\\d+)/receipts', async (req, res) => {
  try { res.json({ receipts: await store.listReceipts(req.user.salonId, idParam(req.params.goodId)) }); }
  catch (e) { fail(res, 'receipts')(e); }
});
router.put('/goods/:goodId(\\d+)/price', async (req, res) => {
  const p = parsePriceBody(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    await store.setPriceOverride(req.user.salonId, idParam(req.params.goodId), p.value, req.body && req.body.note, req.user.userId);
    report.invalidate(req.user.salonId);
    res.json({ ok: true });
  } catch (e) { fail(res, 'price override')(e); }
});

// ── техкарты (статические пути — до /:id) ──
router.get('/tech-cards', async (req, res) => {
  try { res.json({ cards: await store.listTechCards(req.user.salonId) }); } catch (e) { fail(res, 'tech-cards')(e); }
});
router.post('/tech-cards/sync', async (req, res) => {
  const sid = req.user.salonId;
  if (sync.isRunning(sid)) return res.status(409).json({ error: 'Синхронизация уже идёт' });
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    const r = await sync.syncTechCards(salon);
    report.invalidate(sid);
    res.json(r);
  } catch (e) { fail(res, 'tech-cards sync')(e); }
});
router.post('/tech-cards', async (req, res) => {
  const p = parseManualCard(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { const id = await store.insertManualCard(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); }
  catch (e) { fail(res, 'tech-card create')(e); }
});
router.put('/tech-cards/:id(\\d+)', async (req, res) => {
  const p = parseManualCard(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const ok = await store.updateManualCard(req.user.salonId, idParam(req.params.id), p.value);
    if (!ok) return res.status(404).json({ error: 'Норма не найдена или не ручная' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'tech-card update')(e); }
});
router.delete('/tech-cards/:id(\\d+)', async (req, res) => {
  try {
    const ok = await store.deleteManualCard(req.user.salonId, idParam(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Норма не найдена или не ручная' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'tech-card delete')(e); }
});
router.put('/services/:serviceId(\\d+)/tech-card', async (req, res) => {
  const sid = req.user.salonId; const serviceYcId = idParam(req.params.serviceId);
  const b = req.body || {};
  const staff = optInt(b.staffYcId); if (Number.isNaN(staff)) return res.status(400).json({ error: 'staffYcId — целое' });
  try {
    if (b.techCardId === null || b.techCardId === undefined) { await store.clearServiceTechCard(sid, serviceYcId, staff); }
    else {
      const cardId = optInt(b.techCardId);
      if (!cardId || !(await store.techCardExists(sid, cardId))) return res.status(400).json({ error: 'Техкарта не найдена' });
      await store.upsertServiceTechCard(sid, { serviceYcId, staffYcId: staff, techCardId: cardId, source: 'manual' });
    }
    report.invalidate(sid); res.json({ ok: true });
  } catch (e) { fail(res, 'service tech-card')(e); }
});
router.post('/services/:serviceId(\\d+)/tech-card/lookup', async (req, res) => {
  const staffIds = (Array.isArray(req.body && req.body.staffYcIds) ? req.body.staffYcIds : []).map(optInt).filter(x => x && !Number.isNaN(x));
  if (!staffIds.length) return res.status(400).json({ error: 'Нужен список staffYcIds' });
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    const r = await sync.lookupTechCardForService(salon, idParam(req.params.serviceId), staffIds);
    report.invalidate(req.user.salonId); res.json(r);
  } catch (e) { fail(res, 'tech-card lookup')(e); }
});

// ── правила оплаты ──
router.get('/pay-rules', async (req, res) => { try { res.json({ rules: await store.listPayRules(req.user.salonId) }); } catch (e) { fail(res, 'pay-rules')(e); } });
router.post('/pay-rules', async (req, res) => {
  const p = parsePayRule(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { const id = await store.insertPayRule(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); } catch (e) { fail(res, 'pay-rule create')(e); }
});
router.put('/pay-rules/:id(\\d+)', async (req, res) => {
  const p = parsePayRule(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const ok = await store.updatePayRule(req.user.salonId, idParam(req.params.id), p.value);
    if (!ok) return res.status(404).json({ error: 'Правило не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-rule update')(e); }
});
router.delete('/pay-rules/:id(\\d+)', async (req, res) => {
  try {
    const ok = await store.deletePayRule(req.user.salonId, idParam(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Правило не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-rule delete')(e); }
});

// ── настройки ──
router.get('/settings', async (req, res) => {
  try { res.json({ settings: await store.getSettings(req.user.salonId), accounts: await store.listAccounts(req.user.salonId) }); }
  catch (e) { fail(res, 'settings')(e); }
});
router.put('/settings', async (req, res) => {
  const p = parseSettings(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { await store.saveSettings(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ ok: true, settings: p.value }); }
  catch (e) { fail(res, 'settings save')(e); }
});

// ── ручной ночной проход ──
router.post('/sync', async (req, res) => {
  const sid = req.user.salonId;
  if (sync.isRunning(sid)) return res.status(409).json({ error: 'Синхронизация уже идёт' });
  try {
    const salon = await salonOr404(req, res); if (!salon) return;
    const r = await sync.runNightly(salon); report.invalidate(sid); res.json(r);
  } catch (e) { if (e.code === 'BUSY') return res.status(409).json({ error: e.message }); fail(res, 'sync')(e); }
});

// ── постоянные расходы и аппараты ──
// Число: только number/string, пустая строка — не число (Number('') === 0 молча пропустил бы).
const numOf = (v) => ((typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '' ? Number(v) : NaN);
function parseMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')) ? `${s}-01` : null; }
function parseFixedCost(b) {
  b = b || {};
  if (!FIXED_CATEGORIES.includes(b.category)) return { error: 'Неизвестная категория расходов' };
  const amount = numOf(b.amountMonth);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return { error: 'Сумма в месяц ≥ 0' };
  const mf = parseMonth(b.monthFrom); if (!mf) return { error: 'Месяц начала в формате YYYY-MM' };
  const mt = b.monthTo ? parseMonth(b.monthTo) : null; if (b.monthTo && !mt) return { error: 'Месяц окончания в формате YYYY-MM' };
  if (mt && mt < mf) return { error: 'Период: конец раньше начала' };
  return { value: { category: b.category, title: String(b.title || '').trim().slice(0, 255), amount_month: amount, month_from: mf, month_to: mt, note: String(b.note || '').slice(0, 500) } };
}
function parseEquipment(b) {
  b = b || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 255) return { error: 'Название 1–255 символов' };
  const price = numOf(b.purchasePrice); if (!Number.isFinite(price) || price < 0 || price > 1e9) return { error: 'Цена покупки ≥ 0' };
  const pd = b.purchaseDate || null; if (pd && !isDate(pd)) return { error: 'Дата покупки YYYY-MM-DD' };
  const life = b.usefulLifeMonths === undefined ? 60 : numOf(b.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 240) return { error: 'Срок службы 1–240 месяцев' };
  const res = b.residualPct === undefined ? 0 : numOf(b.residualPct); if (!Number.isFinite(res) || res < 0 || res > 100) return { error: 'Остаточная стоимость 0–100 %' };
  const mm = b.maintenanceMonthly === undefined ? 0 : numOf(b.maintenanceMonthly); if (!Number.isFinite(mm) || mm < 0 || mm > 1e9) return { error: 'ТО в месяц ≥ 0' };
  if (b.serviceIds !== undefined && !Array.isArray(b.serviceIds)) return { error: 'service_ids — список' };
  const ids = (b.serviceIds || []).map(optInt);
  if (ids.some(x => !x)) return { error: 'service_ids — целые id услуг' };
  return { value: { name, purchase_price: price, purchase_date: pd, useful_life_months: life, residual_pct: res, maintenance_monthly: mm, service_ids: [...new Set(ids)], is_active: b.isActive !== false, note: String(b.note || '').slice(0, 500) } };
}

const crud = (prefix, { list, parse, insert, update, remove, decorate }) => {
  router.get(`/${prefix}`, async (req, res) => { try { const rows = await list(req.user.salonId); res.json({ rows: decorate ? rows.map(decorate) : rows }); } catch (e) { fail(res, prefix)(e); } });
  router.post(`/${prefix}`, async (req, res) => {
    const p = parse(req.body); if (p.error) return res.status(400).json({ error: p.error });
    try { const id = await insert(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); } catch (e) { fail(res, prefix + ' create')(e); }
  });
  router.put(`/${prefix}/:id(\\d+)`, async (req, res) => {
    const p = parse(req.body); if (p.error) return res.status(400).json({ error: p.error });
    try { const ok = await update(req.user.salonId, idParam(req.params.id), p.value); if (!ok) return res.status(404).json({ error: 'Не найдено' }); report.invalidate(req.user.salonId); res.json({ ok: true }); }
    catch (e) { fail(res, prefix + ' update')(e); }
  });
  router.delete(`/${prefix}/:id(\\d+)`, async (req, res) => {
    try { const ok = await remove(req.user.salonId, idParam(req.params.id)); if (!ok) return res.status(404).json({ error: 'Не найдено' }); report.invalidate(req.user.salonId); res.json({ ok: true }); }
    catch (e) { fail(res, prefix + ' delete')(e); }
  });
};
// Статические пути объявлены ДО crud с /:id.
router.post('/fixed-costs/copy', async (req, res) => {
  const from = parseMonth(req.query.from), to = parseMonth(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from и to в формате YYYY-MM' });
  try { const n = await store.copyFixedCosts(req.user.salonId, from, to); report.invalidate(req.user.salonId); res.json({ copied: n }); } catch (e) { fail(res, 'fixed copy')(e); }
});
crud('fixed-costs', { list: (s) => store.listFixedCosts(s), parse: parseFixedCost, insert: (s, v) => store.insertFixedCost(s, v), update: (s, i, v) => store.updateFixedCost(s, i, v), remove: (s, i) => store.deleteFixedCost(s, i) });
router.get('/equipment/seed', (req, res) => res.json({ seed: EQUIPMENT_SEED }));
crud('equipment', { list: (s) => store.listEquipment(s), parse: parseEquipment, insert: (s, v) => store.insertEquipment(s, v), update: (s, i, v) => store.updateEquipment(s, i, v), remove: (s, i) => store.deleteEquipment(s, i),
  decorate: (e) => ({ ...e, monthly: equipmentMonthly(e) }) });

module.exports = router;
module.exports.parsePayRule = parsePayRule;
module.exports.parseSettings = parseSettings;
module.exports.parsePriceBody = parsePriceBody;
module.exports.parseManualCard = parseManualCard;
module.exports.parsePeriodDays = parsePeriodDays;
module.exports.resolvePeriod = resolvePeriod;
module.exports.parseFixedCost = parseFixedCost;
module.exports.parseEquipment = parseEquipment;
module.exports.parseMonth = parseMonth;
module.exports.FIXED_CATEGORIES = FIXED_CATEGORIES;
