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
      `SELECT id, salon_id, role, staff_member_id FROM users WHERE id=$1 AND role='specialist' AND is_active=TRUE`,
      [process.env.SMOKE_USER_ID]
    )).rows[0];
    if (!linkedUser) { console.error('SMOKE_USER_ID does not match an active specialist'); process.exit(1); }
  } else {
    linkedUser = (await pool.query(
      `SELECT id, salon_id, role, staff_member_id FROM users
       WHERE role='specialist' AND is_active=TRUE AND staff_member_id IS NOT NULL
       LIMIT 1`
    )).rows[0];
  }

  // Кейс 0: «Цель месяца» — ставим план linked-специалисту через admin API,
  // чтобы кейс 1 мог проверить блок goal в ответе дашборда.
  const curMonth = mskToday().slice(0, 7);
  const admin = (await pool.query(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND is_active=TRUE
     AND salon_id=$1 LIMIT 1`, [linkedUser?.salon_id || 1]
  )).rows[0];
  if (linkedUser && admin) {
    console.log(`\n[0] staff-goals admin API (user_id=${admin.id}, month=${curMonth})`);
    const atk = await mintSession(admin);
    const put = await fetch(`${BASE}/api/staff-goals`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + atk, 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffMemberId: linkedUser.staff_member_id, month: curMonth,
                             servicesTarget: 500000, goodsTarget: 50000 }),
    });
    assert(put.status === 200, `PUT /api/staff-goals → 200 (got ${put.status})`);
    const get = await fetch(`${BASE}/api/staff-goals?month=${curMonth}`, {
      headers: { Authorization: 'Bearer ' + atk },
    });
    assert(get.status === 200, `GET /api/staff-goals → 200 (got ${get.status})`);
    const gj = await get.json();
    const mine = (gj.goals || []).find(g => g.staff_member_id === linkedUser.staff_member_id);
    assert(mine && mine.services_target === 500000 && mine.goods_target === 50000,
      'GET returns the upserted targets');
    assert(typeof mine.services_fact === 'number' && typeof mine.services_forecast === 'number',
      'goal row has numeric fact + forecast');
  } else {
    console.log('\n[0] No admin/owner or linked specialist — skip staff-goals case');
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
    // Цель месяца: null (план не задан) или объект с services/goods
    if (j.goal === null) {
      console.log('  ⚠️  .goal is null (no plan set for current month)');
    } else {
      assert(j.goal.month === curMonth, `.goal.month = ${curMonth}`);
      assert(j.goal.services && typeof j.goal.services.target === 'number'
        && typeof j.goal.services.fact === 'number' && typeof j.goal.services.forecast === 'number',
        '.goal.services: {target, fact, forecast}: numbers');
      assert(j.goal.goods && typeof j.goal.goods.forecast === 'number', '.goal.goods: {…forecast}: number');
      assert(typeof j.goal.daysTotal === 'number' && typeof j.goal.elapsedDays === 'number',
        '.goal: daysTotal + elapsedDays');
      console.log(`  Goal: services ${j.goal.services.fact}/${j.goal.services.target} fc=${j.goal.services.forecast}; goods ${j.goal.goods.fact}/${j.goal.goods.target} fc=${j.goal.goods.forecast}; days ${j.goal.workedDays}/${j.goal.plannedDays} (cal ${j.goal.elapsedDays}/${j.goal.daysTotal})`);
    }
    // Специалисту /api/staff-goals недоступен (нет в allowlist) → 403
    const sg403 = await fetch(`${BASE}/api/staff-goals?month=${curMonth}`, {
      headers: { Authorization: 'Bearer ' + tk },
    });
    assert(sg403.status === 403, `specialist на /api/staff-goals ловит 403 (got ${sg403.status})`);
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
