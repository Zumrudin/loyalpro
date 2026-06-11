// End-to-end smoke для /api/analytics/staff-dashboard.
//
// Запуск:
//   cd backend && node scripts/staff-dashboard-smoke.js
//
// Env-флаги (опционально):
//   SMOKE_BASE       — базовый URL (default: http://localhost:3001)
//   SMOKE_USER_ID    — id специалиста (если хотите тестировать конкретного,
//                      иначе скрипт берёт первого подходящего)
//   SMOKE_FROM       — YYYY-MM-DD (default: 30 дней назад)
//   SMOKE_TO         — YYYY-MM-DD (default: сегодня MSK)
//
// Что делает:
//   1. Находит specialist-юзера (linked и unlinked).
//   2. Минтит JWT и регистрирует сессию.
//   3. Дёргает endpoint, валидирует форму ответа.
//   4. Дополнительно — кейс unlinked → ожидает {unlinked:true}.
'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';

function mskToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}
function daysAgo(n) {
  const d = new Date(mskToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return d.toISOString().slice(0, 10);
}

async function mintSession(user) {
  const tk = jwt.sign(
    { userId: user.id, salonId: user.salon_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
  await pool.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'smoke-staff-dashboard', NOW()+INTERVAL '5 minutes')`,
    [user.id, tk]
  );
  return tk;
}

function assert(cond, msg) {
  if (!cond) { console.error('  ❌', msg); process.exit(1); }
  console.log('  ✅', msg);
}

(async () => {
  const from = process.env.SMOKE_FROM || daysAgo(30);
  const to   = process.env.SMOKE_TO   || mskToday();
  console.log(`Period: ${from} … ${to}`);

  // Кейс 1: linked specialist (берём первого attached)
  let linkedUser;
  if (process.env.SMOKE_USER_ID) {
    linkedUser = (await pool.query(
      `SELECT id, salon_id, role FROM users WHERE id=$1 AND role='specialist' AND is_active=TRUE`,
      [process.env.SMOKE_USER_ID]
    )).rows[0];
    if (!linkedUser) { console.error('SMOKE_USER_ID does not match an active specialist'); process.exit(1); }
  } else {
    linkedUser = (await pool.query(
      `SELECT id, salon_id, role FROM users
       WHERE role='specialist' AND is_active=TRUE AND staff_member_id IS NOT NULL
       LIMIT 1`
    )).rows[0];
  }

  if (linkedUser) {
    console.log(`\n[1] linked specialist user_id=${linkedUser.id}`);
    const tk = await mintSession(linkedUser);
    const r = await fetch(`${BASE}/api/analytics/staff-dashboard?from=${from}&to=${to}`, {
      headers: { Authorization: 'Bearer ' + tk },
    });
    assert(r.status === 200, `HTTP 200 (got ${r.status})`);
    const j = await r.json();
    assert(j && j.stats, 'response has .stats');
    const s = j.stats;
    assert(typeof s.staffName === 'string', '.stats.staffName: string');
    assert(typeof s.periodRecords === 'number', '.stats.periodRecords: number');
    assert(typeof s.periodRevenue === 'number', '.stats.periodRevenue: number');
    assert(s.revenueByCategory && 'services' in s.revenueByCategory && 'goods' in s.revenueByCategory && 'abonement' in s.revenueByCategory,
      '.stats.revenueByCategory: {services, goods, abonement}');
    assert(typeof s.noShowClients === 'number', '.stats.noShowClients: number');
    assert(typeof s.newClients === 'number', '.stats.newClients: number');
    assert(typeof s.avgCheck === 'number', '.stats.avgCheck: number');
    assert(Array.isArray(j.topServices), '.topServices: array');
    assert(Array.isArray(j.dailyRevenue), '.dailyRevenue: array');
    assert(j.period && j.period.from === from && j.period.to === to, '.period correct');
    // Сравнение с прошлым месяцем: весь месяц + эквивалентный отрезок
    assert(j.comparison && j.comparison.prevMonth && j.comparison.prevWindow, '.comparison: {prevMonth, prevWindow}');
    const pm = j.comparison.prevMonth, pw = j.comparison.prevWindow;
    assert(/^\d{4}-\d{2}-01$/.test(pm.from), '.comparison.prevMonth.from = 1-е число');
    assert(pw.from === pm.from && pw.to <= pm.to, '.comparison.prevWindow внутри prevMonth');
    assert(typeof pm.stats.periodRevenue === 'number' && typeof pm.stats.periodRecords === 'number',
      '.comparison.prevMonth.stats: {periodRevenue, periodRecords}: numbers');
    assert('revenueByCategory' in pm.stats && 'goodsCount' in pm.stats, '.comparison.prevMonth.stats: revenueByCategory + goodsCount');
    console.log(`  Sample: visits=${s.periodRecords} revenue=${s.periodRevenue} noShow=${s.noShowClients} new=${s.newClients} avg=${s.avgCheck} (services=${s.revenueByCategory.services})`);
    console.log(`  Compare: prevMonth ${pm.from}…${pm.to} rev=${pm.stats.periodRevenue}; prevWindow ${pw.from}…${pw.to} rev=${pw.stats.periodRevenue}`);
  } else {
    console.log('\n[1] No linked specialist in DB — skip linked case');
  }

  // Кейс 2: unlinked specialist
  const unlinkedUser = (await pool.query(
    `SELECT id, salon_id, role FROM users
     WHERE role='specialist' AND is_active=TRUE AND staff_member_id IS NULL
     LIMIT 1`
  )).rows[0];
  if (unlinkedUser) {
    console.log(`\n[2] unlinked specialist user_id=${unlinkedUser.id}`);
    const tk = await mintSession(unlinkedUser);
    const r = await fetch(`${BASE}/api/analytics/staff-dashboard?from=${from}&to=${to}`, {
      headers: { Authorization: 'Bearer ' + tk },
    });
    assert(r.status === 200, `HTTP 200 (got ${r.status})`);
    const j = await r.json();
    assert(j && j.unlinked === true, 'response has unlinked:true');
  } else {
    console.log('\n[2] No unlinked specialist in DB — skip unlinked case');
  }

  // Кейс 3: owner — должен получить 403
  const owner = (await pool.query(
    `SELECT id, salon_id, role FROM users WHERE role='owner' AND is_active=TRUE LIMIT 1`
  )).rows[0];
  if (owner) {
    console.log(`\n[3] owner user_id=${owner.id} (ожидаем 403)`);
    const tk = await mintSession(owner);
    const r = await fetch(`${BASE}/api/analytics/staff-dashboard?from=${from}&to=${to}`, {
      headers: { Authorization: 'Bearer ' + tk },
    });
    assert(r.status === 403, `owner ловит 403 (got ${r.status})`);
  }

  console.log('\n🎉 smoke ok');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
