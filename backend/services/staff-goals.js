// ── Staff monthly goals («Цель месяца») ────────────────────────────
// Планы руководителя на месяц по мастеру: услуги (₽) + товары (₽).
// Факты считаются теми же запросами, что и на личном дашборде специалиста
// (услуги — records.amount по мастеру визита; товары — revenue_operations
// category='goods' через связь с визитом), чтобы цифры совпадали.
'use strict';
const { db } = require('../db');

// ── Чистые помощники (unit-тесты: staff-goals.test.js) ─────────────

// 'YYYY-MM' → {from, to, daysTotal}. UTC-арифметика по строке — TZ сервера
// не влияет.
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // день 0 следующего месяца = последний день текущего
  return { from: `${month}-01`, to: last.toISOString().slice(0, 10), daysTotal: last.getUTCDate() };
}

// Сколько календарных дней месяца уже прошло (включая сегодняшний).
// 0 — месяц ещё не начался; daysTotal — месяц уже закончился.
function elapsedDaysInMonth(month, todayIso) {
  const { from, to, daysTotal } = monthBounds(month);
  if (todayIso < from) return 0;
  if (todayIso >= to) return daysTotal;
  return parseInt(todayIso.slice(8, 10), 10);
}

// Прогноз выручки на конец месяца. Приоритет — рабочие дни мастера из
// staff_schedule (честнее при графике 2/2); если расписание не
// синхронизировано — линейный run-rate по календарным дням.
function forecastMonthEnd(fact, workedDays, plannedDays, elapsedDays, totalDays) {
  const f = parseFloat(fact) || 0;
  if (workedDays > 0 && plannedDays > 0) return Math.round(f / workedDays * plannedDays);
  if (elapsedDays > 0 && totalDays > 0) return Math.round(f / elapsedDays * totalDays);
  return 0;
}

// Оценка темпа выполнения плана для автокомментария на дашборде.
// Спека: docs/superpowers/specs/2026-06-12-goal-pace-analysis-design.md
// → null            план не задан
// → {status:'done', overPct}                 факт ≥ плана
// → {status:'no_schedule', ratio}            график не синхронизирован
// → {status:'ahead'}                          прогноз ≥ 105% плана
// → {status:'tight'|'behind', perShiftNeeded, remainingShifts}
//   tight: 95–105%, behind: <95%. perShiftNeeded=null если смен не осталось.
function computePace(target, fact, forecast, workedDays, plannedDays) {
  const t = parseFloat(target) || 0;
  if (t <= 0) return null;
  const f = parseFloat(fact) || 0;
  if (f >= t) return { status: 'done', overPct: Math.round((f / t - 1) * 100) };
  const ratio = (parseFloat(forecast) || 0) / t;
  if (!(plannedDays > 0)) return { status: 'no_schedule', ratio };
  if (ratio >= 1.05) return { status: 'ahead' };
  const remainingShifts = Math.max(0, plannedDays - workedDays);
  const perShiftNeeded = remainingShifts > 0 ? Math.ceil((t - f) / remainingShifts) : null;
  return { status: ratio >= 0.95 ? 'tight' : 'behind', perShiftNeeded, remainingShifts };
}

// ── Запросы фактов ──────────────────────────────────────────────────

// Факты за период по всем мастерам салона одним проходом.
// Возвращает Map<yclients_staff_id, {services, goods}>.
async function fetchMonthFacts(salonId, from, to) {
  const [services, goods] = await Promise.all([
    db.any(`SELECT COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) AS yc,
                   COALESCE(SUM(amount),0) AS total
            FROM records r
            WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
              AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
            GROUP BY 1`, [salonId, from, to]),
    // Товары: если операция привязана к визиту — кредитуем мастера визита,
    // иначе — явного master[0] из payload операции (та же логика, что byCat
    // в /api/analytics/staff-dashboard).
    db.any(`SELECT COALESCE(
                     CASE WHEN r.id IS NOT NULL
                          THEN COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) END,
                     CASE WHEN jsonb_typeof(ro.raw_payload->'data'->'master') = 'array'
                               AND jsonb_array_length(ro.raw_payload->'data'->'master') > 0
                          THEN (ro.raw_payload->'data'->'master'->0->>'id')::int END
                   ) AS yc,
                   COALESCE(SUM(ro.amount),0) AS total
            FROM revenue_operations ro
            LEFT JOIN records r ON r.salon_id=$1 AND r.yclients_record_id = ro.yclients_record_id
            WHERE ro.salon_id=$1 AND ro.operation_date BETWEEN $2::date AND $3::date
              AND ro.category='goods'
            GROUP BY 1`, [salonId, from, to]),
  ]);
  const map = new Map();
  const get = (yc) => { if (!map.has(yc)) map.set(yc, { services: 0, goods: 0 }); return map.get(yc); };
  for (const r of services) if (r.yc != null) get(r.yc).services = parseFloat(r.total) || 0;
  for (const r of goods)    if (r.yc != null) get(r.yc).goods    = parseFloat(r.total) || 0;
  return map;
}

// Рабочие дни мастеров за месяц: planned — все дни с work_minutes>0,
// worked — из них прошедшие (date <= uptoIso). Map<yc, {planned, worked}>.
async function fetchScheduleDays(salonId, from, to, uptoIso) {
  const rows = await db.any(
    `SELECT yclients_staff_id AS yc,
            COUNT(*) FILTER (WHERE work_minutes > 0)                      AS planned,
            COUNT(*) FILTER (WHERE work_minutes > 0 AND date <= $4::date) AS worked
     FROM staff_schedule
     WHERE salon_id=$1 AND date BETWEEN $2::date AND $3::date
     GROUP BY 1`, [salonId, from, to, uptoIso]);
  return new Map(rows.map(r => [r.yc, { planned: parseInt(r.planned), worked: parseInt(r.worked) }]));
}

// ── Публичное API сервиса ───────────────────────────────────────────

// Сводка для админки: все активные мастера салона с планами, фактами
// и прогнозом за месяц 'YYYY-MM'. todayIso — сегодняшняя дата по МСК.
async function getGoalsOverview(salonId, month, todayIso) {
  const { from, to, daysTotal } = monthBounds(month);
  const elapsed = elapsedDaysInMonth(month, todayIso);
  const upto = todayIso < to ? todayIso : to;
  const [staff, goalRows, facts, sched] = await Promise.all([
    db.any(`SELECT id, yclients_staff_id, name, specialization FROM staff_members
            WHERE salon_id=$1 AND is_active=TRUE ORDER BY display_order, name`, [salonId]),
    db.any(`SELECT staff_member_id, services_target, goods_target FROM staff_goals
            WHERE salon_id=$1 AND month=$2::date`, [salonId, from]),
    fetchMonthFacts(salonId, from, to),
    fetchScheduleDays(salonId, from, to, upto),
  ]);
  const goalMap = new Map(goalRows.map(g => [g.staff_member_id, g]));
  return staff.map(sm => {
    const g  = goalMap.get(sm.id);
    const f  = facts.get(sm.yclients_staff_id) || { services: 0, goods: 0 };
    const sc = sched.get(sm.yclients_staff_id) || { planned: 0, worked: 0 };
    return {
      staff_member_id:   sm.id,
      name:              sm.name,
      specialization:    sm.specialization,
      has_goal:          !!g,
      services_target:   g ? parseFloat(g.services_target) || 0 : 0,
      goods_target:      g ? parseFloat(g.goods_target)    || 0 : 0,
      services_fact:     f.services,
      goods_fact:        f.goods,
      planned_days:      sc.planned,
      worked_days:       sc.worked,
      services_forecast: forecastMonthEnd(f.services, sc.worked, sc.planned, elapsed, daysTotal),
      goods_forecast:    forecastMonthEnd(f.goods,    sc.worked, sc.planned, elapsed, daysTotal),
    };
  });
}

// Upsert плана. Возвращает null, если staff_member не из этого салона.
async function upsertGoal(salonId, staffMemberId, month, servicesTarget, goodsTarget) {
  const owned = await db.oneOrNone(
    'SELECT id FROM staff_members WHERE id=$1 AND salon_id=$2', [staffMemberId, salonId]);
  if (!owned) return null;
  return db.one(
    `INSERT INTO staff_goals (salon_id, staff_member_id, month, services_target, goods_target)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (salon_id, staff_member_id, month)
     DO UPDATE SET services_target=$4, goods_target=$5, updated_at=NOW()
     RETURNING id`,
    [salonId, staffMemberId, month + '-01', servicesTarget, goodsTarget]);
}

// Личная цель для дашборда специалиста. null — если план не задан
// (или оба плана нулевые): фронт в этом случае не показывает карточку.
async function getGoalForStaff(salonId, staffMemberId, ycStaffId, month, todayIso) {
  const row = await db.oneOrNone(
    `SELECT services_target, goods_target FROM staff_goals
     WHERE salon_id=$1 AND staff_member_id=$2 AND month=$3::date`,
    [salonId, staffMemberId, month + '-01']);
  if (!row) return null;
  const servicesTarget = parseFloat(row.services_target) || 0;
  const goodsTarget    = parseFloat(row.goods_target)    || 0;
  if (servicesTarget <= 0 && goodsTarget <= 0) return null;

  const { from, to, daysTotal } = monthBounds(month);
  const elapsed = elapsedDaysInMonth(month, todayIso);
  const upto = todayIso < to ? todayIso : to;
  const [facts, sched] = await Promise.all([
    fetchMonthFacts(salonId, from, to),
    fetchScheduleDays(salonId, from, to, upto),
  ]);
  const f  = facts.get(ycStaffId) || { services: 0, goods: 0 };
  const sc = sched.get(ycStaffId) || { planned: 0, worked: 0 };
  return {
    month, daysTotal, elapsedDays: elapsed,
    workedDays: sc.worked, plannedDays: sc.planned,
    services: { target: servicesTarget, fact: f.services,
                forecast: forecastMonthEnd(f.services, sc.worked, sc.planned, elapsed, daysTotal) },
    goods:    { target: goodsTarget, fact: f.goods,
                forecast: forecastMonthEnd(f.goods, sc.worked, sc.planned, elapsed, daysTotal) },
  };
}

module.exports = {
  monthBounds, elapsedDaysInMonth, forecastMonthEnd, computePace,
  getGoalsOverview, upsertGoal, getGoalForStaff,
};
