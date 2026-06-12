// ============================================================
// Staff Analytics Service
// ============================================================
const { db } = require('../db');
const { ycGet } = require('./yclients');
const { createLogger } = require('../logger');
const logger = createLogger('Staff');

function calcWorkMinutes(from, to) {
  if (!from || !to) return 0;
  const [fh, fm] = (from + ':00').split(':').map(Number);
  const [th, tm] = (to + ':00').split(':').map(Number);
  return Math.max(0, (th * 60 + tm) - (fh * 60 + fm));
}

async function syncStaffData(salon) {
  try {
    const allStaff = await ycGet(salon, `/staff/${salon.yclients_company_id}`, {});
    if (!Array.isArray(allStaff)) return;

    const activeIds = [];
    for (const s of allStaff) {
      const isActive = !s.fired;
      await db.query(`
        INSERT INTO staff_members (salon_id, yclients_staff_id, name, specialization, avatar_url, is_active, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (salon_id, yclients_staff_id) DO UPDATE
          SET name=$3, specialization=$4, avatar_url=$5, is_active=$6, synced_at=NOW()
      `, [salon.id, s.id, s.name || 'Сотрудник', s.specialization || null, s.avatar || null, isActive]);
      if (isActive) activeIds.push(s.id);
    }

    const staffList = allStaff.filter(s => !s.fired);
    logger.info(`Salon ${salon.id}: ${staffList.length} active, ${allStaff.length - staffList.length} fired`);

    const now = new Date();
    for (let mo = -1; mo <= 0; mo++) {
      const d = new Date(now.getFullYear(), now.getMonth() + mo, 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const startDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;

      const endDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      for (const s of staffList) {
        try {
          // YClients: даты — сегменты пути (/schedule/{cid}/{staff}/{from}/{to});
          // query-вариант с date/count возвращает 405. Ответ: {date, is_working, slots:[{from,to}]}.
          const sched = await ycGet(salon,
            `/schedule/${salon.yclients_company_id}/${s.id}/${startDate}/${endDate}`, {});
          if (!Array.isArray(sched)) continue;
          for (const day of sched) {
            if (!day.date) continue;
            const slots = Array.isArray(day.slots) ? day.slots : [];
            const working = day.is_working && slots.length > 0;
            const wm = working
              ? slots.reduce((sum, sl) => sum + calcWorkMinutes(sl.from, sl.to), 0)
              : 0;
            const fromT = working ? slots[0].from : null;
            const toT   = working ? slots[slots.length - 1].to : null;
            await db.query(`
              INSERT INTO staff_schedule (salon_id, yclients_staff_id, date, from_time, to_time, work_minutes)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (salon_id, yclients_staff_id, date)
              DO UPDATE SET from_time=$4, to_time=$5, work_minutes=$6
            `, [salon.id, s.id, day.date, fromT, toT, wm]);
          }
          await new Promise(r => setTimeout(r, 150));
        } catch (e) {
          logger.warn(`Schedule sync failed staff=${s.id}: ${e.message}`);
        }
      }
    }
    logger.info(`Salon ${salon.id}: ${staffList.length} staff synced`);
  } catch(e) {
    logger.error(`Error salon ${salon.id}: ${e.message}`);
  }
}

async function syncGoodsSales(salonId) {
  logger.info(`Salon ${salonId}: starting goods sync...`);

  const records = await db.many(`
    SELECT id, yclients_record_id, client_id, yclients_client_id, visit_date,
           raw_payload->'goods_transactions' AS goods_transactions
    FROM records
    WHERE salon_id = $1
      AND raw_payload->'goods_transactions' IS NOT NULL
      AND raw_payload->'goods_transactions' != 'null'::jsonb
      AND jsonb_array_length(raw_payload->'goods_transactions') > 0
  `, [salonId]);

  logger.info(`Found ${records.length} records with goods`);

  let inserted = 0, updated = 0;

  for (const rec of records) {
    const items = rec.goods_transactions;
    if (!Array.isArray(items) || !items.length) continue;

    const totalAmount = items.reduce((sum, it) => sum + (parseFloat(it.cost_to_pay) || 0), 0);

    const sale = await db.one(`
      INSERT INTO goods_sales
        (salon_id, yclients_record_id, source, yclients_client_id, client_id, sale_date, total_amount)
      VALUES ($1, $2, 'record', $3, $4, $5, $6)
      ON CONFLICT (salon_id, yclients_record_id) DO UPDATE
        SET total_amount = EXCLUDED.total_amount, synced_at = NOW()
      RETURNING id, (xmax = 0) AS is_insert
    `, [salonId, rec.yclients_record_id, rec.yclients_client_id,
        rec.client_id, rec.visit_date, totalAmount]);

    if (sale.is_insert) inserted++; else updated++;

    for (const it of items) {
      await db.query(`
        INSERT INTO goods_sale_items
          (sale_id, yclients_transaction_id, yclients_goods_id, title, article,
           quantity, price_per_unit, total_price, discount,
           assigned_staff_yclients_id, storage_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (yclients_transaction_id) DO UPDATE
          SET sale_id                    = EXCLUDED.sale_id,
              yclients_goods_id          = EXCLUDED.yclients_goods_id,
              title                      = EXCLUDED.title,
              article                    = EXCLUDED.article,
              quantity                   = EXCLUDED.quantity,
              price_per_unit             = EXCLUDED.price_per_unit,
              total_price                = EXCLUDED.total_price,
              discount                   = EXCLUDED.discount,
              assigned_staff_yclients_id = EXCLUDED.assigned_staff_yclients_id,
              storage_id                 = EXCLUDED.storage_id
      `, [
        sale.id, it.id, it.good_id || null, it.title || '', it.article || null,
        Math.abs(parseFloat(it.amount) || 1), parseFloat(it.cost_per_unit) || 0,
        parseFloat(it.cost_to_pay) || 0, parseFloat(it.discount) || 0,
        it.master_id || null, it.storage_id || null,
      ]);
    }
  }

  logger.info(`Done: inserted=${inserted} updated=${updated}`);
  return { inserted, updated, total: records.length };
}

async function getStaffList(salonId) {
  const fromTable = await db.many(
    `SELECT yclients_staff_id AS id, name, specialization, avatar_url
     FROM staff_members WHERE salon_id=$1 AND is_active=TRUE ORDER BY name`,
    [salonId]
  );
  if (fromTable.length > 0) return fromTable;

  return db.many(`
    SELECT DISTINCT
      (se->>'id')::int AS id,
      (se->>'name') AS name,
      (se->>'specialization') AS specialization,
      NULL AS avatar_url
    FROM records r, jsonb_array_elements(r.staff::jsonb) se
    WHERE r.salon_id=$1 AND r.staff IS NOT NULL AND r.staff != '[]'
      AND (se->>'name') IS NOT NULL
    ORDER BY name
  `, [salonId]);
}

async function computeStaffMetrics(salonId, ycStaffId, fromDate, toDate) {
  const sid = parseInt(ycStaffId);
  const DONE = `status IN ('completed','arrived')`;
  const CANCELLED = `status IN ('no_show','deleted','cancelled')`;
  const [basic, ret, reapp, sched, consult, goods] = await Promise.all([
    db.one(`
      SELECT
        COUNT(*) FILTER (WHERE ${DONE}) AS visits,
        COALESCE(SUM(amount) FILTER (WHERE ${DONE}), 0) AS revenue,
        COALESCE(AVG(amount) FILTER (WHERE ${DONE}), 0) AS avg_check,
        COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled,
        COALESCE(SUM(amount) FILTER (WHERE ${CANCELLED}), 0) AS cancelled_rev
      FROM records WHERE salon_id=$1 AND (staff->>'id')::int = $2
        AND visit_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH
      period_clients AS (
        SELECT DISTINCT yclients_client_id
        FROM records
        WHERE salon_id=$1 AND (staff->>'id')::int = $2
          AND ${DONE} AND visit_date BETWEEN $3 AND $4
          AND yclients_client_id IS NOT NULL
      ),
      new_clients AS (
        SELECT DISTINCT r.yclients_client_id
        FROM records r
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
          AND r.yclients_client_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM records r2
            WHERE r2.salon_id=$1 AND (r2.staff->>'id')::int = $2
              AND ${DONE} AND r2.visit_date < $3
              AND r2.yclients_client_id = r.yclients_client_id
          )
      ),
      base_45 AS (
        SELECT DISTINCT yclients_client_id
        FROM records
        WHERE salon_id=$1 AND (staff->>'id')::int = $2
          AND ${DONE}
          AND visit_date BETWEEN ($3::date - INTERVAL '45 days')::date
                              AND ($3::date - INTERVAL '1 day')::date
          AND yclients_client_id IS NOT NULL
      ),
      returned AS (
        SELECT b.yclients_client_id FROM base_45 b
        JOIN period_clients p USING (yclients_client_id)
      )
      SELECT
        (SELECT COUNT(*) FROM period_clients) AS total,
        (SELECT COUNT(*) FROM new_clients)    AS new_clients,
        (SELECT COUNT(*) FROM base_45)        AS base_45_days,
        (SELECT COUNT(*) FROM returned)       AS returned_count
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH vis AS (
        SELECT r.id, r.yclients_client_id, r.visit_datetime,
          EXISTS (
            SELECT 1 FROM records r2
            WHERE r2.salon_id=r.salon_id AND r2.yclients_client_id=r.yclients_client_id
              AND r2.id != r.id
              AND (r2.raw_payload::jsonb->>'create_date') IS NOT NULL
              AND (r2.raw_payload::jsonb->>'create_date')::timestamptz
                  BETWEEN r.visit_datetime::timestamptz
                      AND r.visit_datetime::timestamptz + INTERVAL '24 hours'
          ) AS reapp
        FROM records r
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
          AND r.visit_datetime IS NOT NULL
      )
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE reapp) AS with_reapp FROM vis
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      SELECT
        COUNT(DISTINCT visit_date) AS working_days,
        COALESCE(SUM(
          CASE WHEN raw_payload IS NOT NULL
                    AND (raw_payload::jsonb->>'seance_length') ~ '^[0-9]+$'
               THEN (raw_payload::jsonb->>'seance_length')::int / 60
               ELSE 0 END
        ), 0) AS booked_mins
      FROM records
      WHERE salon_id=$1 AND (staff->>'id')::int = $2
        AND ${DONE} AND visit_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH con AS (
        SELECT DISTINCT r.yclients_client_id, r.visit_date
        FROM records r
        CROSS JOIN LATERAL jsonb_array_elements(r.services::jsonb) sv
        JOIN services_config sc ON sc.salon_id=r.salon_id
          AND sc.yclients_service_id=(sv->>'id')::int AND sc.tag='consultation'
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
      ),
      conv AS (
        SELECT DISTINCT c.yclients_client_id
        FROM con c WHERE EXISTS (
          SELECT 1 FROM records r2
          WHERE r2.salon_id=$1 AND r2.yclients_client_id=c.yclients_client_id
            AND ${DONE.replace(/r\./g,'')}
            AND r2.visit_date > c.visit_date AND r2.visit_date <= c.visit_date + 30
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(r2.services::jsonb) s2
              CROSS JOIN LATERAL (
                SELECT 1 FROM services_config sc2
                WHERE sc2.salon_id=r2.salon_id
                  AND sc2.yclients_service_id=(s2->>'id')::int AND sc2.tag='consultation'
              ) x
            )
        )
      )
      SELECT COUNT(DISTINCT c.yclients_client_id) AS total,
             COUNT(DISTINCT cv.yclients_client_id) AS converted
      FROM con c LEFT JOIN conv cv ON cv.yclients_client_id=c.yclients_client_id
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      SELECT
        COALESCE(COUNT(gsi.id), 0)        AS count,
        COALESCE(SUM(gsi.total_price), 0) AS revenue
      FROM goods_sale_items gsi
      JOIN goods_sales gs ON gs.id = gsi.sale_id
      WHERE gs.salon_id = $1
        AND gsi.assigned_staff_yclients_id = $2
        AND gs.sale_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),
  ]);

  const visits      = parseInt(basic.visits) || 0;
  const workingDays = parseInt(sched.working_days) || 0;
  const bookedMins  = parseInt(sched.booked_mins) || 0;
  const availMins   = workingDays * 480;

  const retTotal    = parseInt(ret.total) || 0;
  const retNew      = parseInt(ret.new_clients) || 0;
  const retBase45   = parseInt(ret.base_45_days) || 0;
  const retReturned = parseInt(ret.returned_count) || 0;

  return {
    totalVisits:        visits,
    totalRevenue:       parseFloat(basic.revenue) || 0,
    avgCheck:           parseFloat(basic.avg_check) || 0,
    cancelledCount:     parseInt(basic.cancelled) || 0,
    cancelledRevenue:   parseFloat(basic.cancelled_rev) || 0,
    clientsTotal:       retTotal,
    newClients:         retNew,
    returningClients:   retTotal - retNew,
    base45days:         retBase45,
    returnedFrom45:     retReturned,
    retentionRate:      retBase45 > 0 ? parseFloat((retReturned / retBase45 * 100).toFixed(1)) : null,
    reappointmentRate:  reapp.total > 0 ? parseFloat((reapp.with_reapp / reapp.total * 100).toFixed(1)) : 0,
    goodsCount:         parseInt(goods.count) || 0,
    goodsRevenue:       parseFloat(goods.revenue) || 0,
    bookedMins,
    workingDays,
    utilizationRate:    availMins > 0 ? parseFloat(Math.min(100, bookedMins / availMins * 100).toFixed(1)) : null,
    consultConversion:  consult.total > 0 ? parseFloat((consult.converted / consult.total * 100).toFixed(1)) : null,
    totalConsults:      parseInt(consult.total) || 0,
  };
}

async function computeStaffSparklines(salonId, ycStaffId) {
  return db.many(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', visit_date::date), 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE status IN ('completed','arrived')) AS visits,
      COALESCE(AVG(amount) FILTER (WHERE status IN ('completed','arrived')), 0) AS avg_check,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('completed','arrived')), 0) AS revenue
    FROM records
    WHERE salon_id=$1 AND (staff->>'id')::int = $2
      AND visit_date >= (CURRENT_DATE - INTERVAL '6 months')::date
    GROUP BY 1 ORDER BY 1
  `, [salonId, parseInt(ycStaffId)]);
}

module.exports = {
  calcWorkMinutes, syncStaffData, syncGoodsSales,
  getStaffList, computeStaffMetrics, computeStaffSparklines,
};
