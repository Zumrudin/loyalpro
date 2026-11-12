'use strict';
// /api/finance — финансовые операции салона (таблица finance_operations, спека
// 2026-11-12-finance-operations-design.md, этап 2). Только owner/admin; салон — из JWT
// (req.user.salonId), параметры запроса его не задают. Таблица только читается:
// пишет в неё один модуль services/finance-ops.js.
const router = require('express').Router();
const { authOrQuery, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { isCalendarDate } = require('../utils/period');
const { KINDS, METHODS, STATUSES } = require('../services/finance-ops');
const bonusLedger = require('../services/bonus-ledger');
const { createLogger } = require('../logger');
const logger = createLogger('FinanceAPI');

const MAX_PERIOD_DAYS = 366;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const EXPORT_LIMIT = 20000;

class FinanceQueryError extends Error {
  constructor(message) { super(message); this.name = 'FinanceQueryError'; }
}
const bad = msg => { throw new FinanceQueryError(msg); };

const todayMsk = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;

const one = (v, label) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') bad(`Некорректный параметр: ${label}`);
  return v.trim();
};
function enumList(v, allowed, label) {
  const s = one(v, label);
  if (!s) return null;
  const items = s.split(',').map(x => x.trim()).filter(Boolean);
  if (!items.length || items.length > allowed.length || items.some(x => !allowed.includes(x))) bad(`Некорректный параметр: ${label}`);
  return [...new Set(items)];
}
function posInt(v, label) {
  const s = one(v, label);
  if (!s) return null;
  if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) bad(`Некорректный параметр: ${label}`);
  return Number(s);
}
const likeEscape = s => s.replace(/[\\%_]/g, c => '\\' + c);

// Разбор и проверка фильтров. Бросает FinanceQueryError (-> 400).
function parseFilters(query, { now = new Date() } = {}) {
  const q = query || {};
  let from = one(q.from, 'from'), to = one(q.to, 'to');
  const today = todayMsk(now);
  if (!from && !to) { to = today; from = today.slice(0, 8) + '01'; }
  else if (!from) from = addDays(to, -29);
  else if (!to) to = today > from ? today : from;
  if (!isCalendarDate(from) || !isCalendarDate(to)) bad('Даты периода — в формате ГГГГ-ММ-ДД.');
  if (from > to) bad('Начало периода позже конца.');
  if (daysBetween(from, to) > MAX_PERIOD_DAYS) bad(`Период не больше ${MAX_PERIOD_DAYS} дней.`);
  const search = one(q.q, 'q');
  if (search.length > 100) bad('Слишком длинный запрос поиска.');
  const account = one(q.account, 'account');
  if (account.length > 100) bad('Некорректный параметр: account');
  let limit = DEFAULT_LIMIT, offset = 0;
  if (q.limit !== undefined && q.limit !== '') {
    const s = one(q.limit, 'limit');
    if (!/^\d{1,6}$/.test(s) || Number(s) < 1) bad('Некорректный параметр: limit');
    limit = Math.min(Number(s), MAX_LIMIT);
  }
  if (q.offset !== undefined && q.offset !== '') {
    const s = one(q.offset, 'offset');
    if (!/^\d{1,9}$/.test(s)) bad('Некорректный параметр: offset');
    offset = Number(s);
  }
  return {
    from, to, kind: enumList(q.kind, KINDS, 'kind'), method: enumList(q.method, METHODS, 'method'),
    status: enumList(q.status, STATUSES, 'status'), clientId: posInt(q.clientId, 'clientId'),
    account, q: search, limit, offset,
  };
}

// WHERE + параметры (салон — первым параметром, всегда).
function buildWhere(salonId, f) {
  const params = [salonId, f.from, f.to];
  const w = ['f.salon_id=$1', 'f.op_date BETWEEN $2::date AND $3::date'];
  const add = v => { params.push(v); return '$' + params.length; };
  if (f.kind) w.push(`f.kind = ANY(${add(f.kind)}::text[])`);
  if (f.method) w.push(`f.method = ANY(${add(f.method)}::text[])`);
  if (f.status) w.push(`f.status = ANY(${add(f.status)}::text[])`);
  if (f.clientId) w.push(`f.client_id=${add(f.clientId)}`);
  if (f.account) {
    if (/^\d{1,15}$/.test(f.account)) w.push(`f.account_id=${add(Number(f.account))}`);
    else w.push(`f.account_title ILIKE ${add('%' + likeEscape(f.account) + '%')}`);
  }
  if (f.q) {
    const like = add('%' + likeEscape(f.q) + '%');
    const parts = [`c.name ILIKE ${like}`, `c.phone ILIKE ${like}`, `f.title ILIKE ${like}`];
    const dg = f.q.replace(/\D/g, '');
    if (dg.length >= 4) parts.push(`regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE ${add('%' + dg + '%')}`);
    if (/^\d{6,15}$/.test(f.q)) parts.push(`f.yclients_record_id=${add(Number(f.q))}`);
    w.push('(' + parts.join(' OR ') + ')');
  }
  return { where: w.join(' AND '), params };
}

const FROM_SQL = `FROM finance_operations f
  LEFT JOIN clients c ON c.id=f.client_id AND c.salon_id=f.salon_id
  LEFT JOIN users u ON u.id=f.user_id`;
const LIVE = `'queued','sending','confirmed'`;
const SUMMARY_SQL = `SELECT
  COALESCE(SUM(CASE WHEN f.method<>'bonus' AND f.status='confirmed' AND f.amount>0 THEN f.amount END),0) AS income,
  COALESCE(-SUM(CASE WHEN f.method<>'bonus' AND f.status='confirmed' AND f.amount<0 THEN f.amount END),0) AS expense,
  COALESCE(-SUM(CASE WHEN f.method='bonus' AND f.kind IN ('bonus_redemption','payment_reversal') AND f.status IN (${LIVE}) THEN f.amount END),0) AS bonus_redeemed,
  COALESCE(SUM(CASE WHEN f.method='bonus' AND f.amount>0 AND f.kind<>'payment_reversal' AND f.status IN (${LIVE}) THEN f.amount END),0) AS bonus_accrued,
  COUNT(*) FILTER (WHERE f.status IN ('queued','sending'))::int AS queued,
  COUNT(*)::int AS total
  ${FROM_SQL}`;
const ROW_SQL = `SELECT f.id, f.occurred_at, f.op_date, f.kind, f.method, f.amount, f.status, f.origin,
  f.account_id, f.account_title, f.client_id, c.name AS client_name, c.phone AS client_phone,
  f.yclients_record_id, f.outbox_id, f.user_id, u.name AS user_name, f.title, f.comment
  ${FROM_SQL}`;

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const dateOnly = v => (v instanceof Date ? v.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' }) : String(v || '').slice(0, 10));
function mapRow(r) {
  return {
    id: Number(r.id), occurredAt: r.occurred_at, date: dateOnly(r.op_date), kind: r.kind, method: r.method,
    amount: money(r.amount), status: r.status, origin: r.origin,
    accountId: r.account_id != null ? Number(r.account_id) : null, accountTitle: r.account_title || null,
    clientId: r.client_id != null ? Number(r.client_id) : null, clientName: r.client_name || null, clientPhone: r.client_phone || null,
    yclientsRecordId: r.yclients_record_id != null ? Number(r.yclients_record_id) : null,
    outboxId: r.outbox_id != null ? Number(r.outbox_id) : null,
    userId: r.user_id != null ? Number(r.user_id) : null, userName: r.user_name || null,
    title: r.title || null, comment: r.comment || null,
  };
}
function mapSummary(s) {
  return { income: money(s.income), expense: money(s.expense), bonusRedeemed: money(s.bonus_redeemed),
    bonusAccrued: money(s.bonus_accrued), queued: Number(s.queued) || 0 };
}

async function list(salonId, f) {
  const { where, params } = buildWhere(salonId, f);
  const [sum, rows] = await Promise.all([
    db.oneOrNone(`${SUMMARY_SQL} WHERE ${where}`, params),
    db.any(`${ROW_SQL} WHERE ${where} ORDER BY f.occurred_at DESC, f.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
  ]);
  return { rows: rows.map(mapRow), total: Number(sum?.total) || 0, summary: mapSummary(sum || {}) };
}

// ── CSV ────────────────────────────────────────────────────────────────

const KIND_RU = {
  visit_payment: 'Оплата визита', payment_reversal: 'Отмена оплаты', bonus_redemption: 'Списание бонусов',
  bonus_accrual: 'Начисление бонусов', bonus_adjustment: 'Корректировка бонусов', bonus_opening: 'Входящий остаток бонусов',
  goods_sale: 'Продажа товаров', certificate_sale: 'Продажа сертификата', abonement_sale: 'Продажа абонемента',
  deposit: 'Депозит', other_income: 'Прочий приход',
};
const METHOD_RU = { cash: 'Наличные', card: 'Карта', bonus: 'Бонусы', other: 'Другое' };
const STATUS_RU = { queued: 'В очереди', sending: 'Передаётся', confirmed: 'Проведено', cancelled: 'Отменено', failed: 'Ошибка' };
const ORIGIN_RU = { journal: 'Журнал', yclients: 'YClients', loyalpro: 'LoyalPro', staff: 'Вручную', backfill: 'Перенос истории', opening: 'Входящий остаток' };

// Текст из данных клиентов/названий не должен исполняться как формула в Excel.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const head = ['Дата', 'Время', 'Тип', 'Способ', 'Касса', 'Клиент', 'Телефон', 'Визит YClients', 'Сумма', 'Статус', 'Источник', 'Кто', 'Описание'];
  const lines = [head.map(csvCell).join(';')];
  for (const r of rows) {
    const t = r.occurredAt ? new Date(r.occurredAt) : null;
    const time = t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) : '';
    lines.push([r.date, time, KIND_RU[r.kind] || r.kind, METHOD_RU[r.method] || r.method || '', r.accountTitle || '',
      r.clientName || '', r.clientPhone || '', r.yclientsRecordId || '', String(r.amount).replace('.', ','),
      STATUS_RU[r.status] || r.status, ORIGIN_RU[r.origin] || r.origin, r.userName || '', r.title || ''].map((v, i) => (i === 8 ? String(v) : csvCell(v))).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ── роуты ──────────────────────────────────────────────────────────────

router.use(authOrQuery, requireRole('owner', 'admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof FinanceQueryError) return res.status(400).json({ error: e.message });
    if (e && e.code === '42P01') return res.status(503).json({ error: 'Таблица финансовых операций ещё не создана: нужна миграция базы.' });
    logger.error(`finance api: ${e && e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить финансовые операции.' });
  }
};

router.get('/operations', handle(async (req, res) => {
  res.json(await list(req.user.salonId, parseFilters(req.query)));
}));

router.get('/operations/export.csv', handle(async (req, res) => {
  const f = { ...parseFilters(req.query), limit: EXPORT_LIMIT, offset: 0 };
  const { rows } = await list(req.user.salonId, f);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="finance-${f.from}_${f.to}.csv"`);
  res.send(toCsv(rows));
}));

// Справочник для фильтра «Касса»: кассы из кэша журнала + встречавшиеся в операциях.
router.get('/accounts', handle(async (req, res) => {
  const salonId = req.user.salonId;
  const seen = await db.any(`SELECT DISTINCT account_id, account_title FROM finance_operations
    WHERE salon_id=$1 AND account_title IS NOT NULL`, [salonId]);
  const map = new Map();
  try {
    const cached = await require('../services/journal/reference-cache').getReference(salonId, 'accounts');
    for (const a of Array.isArray(cached) ? cached : []) if (a && a.id && a.title) map.set(String(a.title), { id: Number(a.id), title: String(a.title) });
  } catch (_) { /* справочник необязателен */ }
  for (const r of seen) if (!map.has(r.account_title)) map.set(r.account_title, { id: r.account_id != null ? Number(r.account_id) : null, title: r.account_title });
  res.json({ accounts: [...map.values()] });
}));

// Расхождения баланса бонусов с картой YClients (этап 3). Без флага — пусто, в БД не ходим.
router.get('/bonus-discrepancies', handle(async (req, res) => {
  if (!bonusLedger.isPrimary()) return res.json({ enabled: false, rows: [] });
  const s = one(req.query && req.query.limit, 'limit');
  if (s && (!/^\d{1,5}$/.test(s) || Number(s) < 1)) bad('Некорректный параметр: limit');
  res.json({ enabled: true, rows: await bonusLedger.discrepancies(req.user.salonId, { limit: s ? Number(s) : 200 }) });
}));

module.exports = router;
module.exports._test = { parseFilters, buildWhere, toCsv, csvCell, mapRow, SUMMARY_SQL, ROW_SQL, MAX_LIMIT, MAX_PERIOD_DAYS };
