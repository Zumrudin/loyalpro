const router = require('express').Router();
const { pool, db, botDb } = require('../db');
const { auth } = require('../middleware/auth');
const { buildClientsQuery } = require('../clients-query');
const { ycGet, ycGetClientCards, ycGetCardTransactions, ycWebSessions } = require('../services/yclients');
const { getLoyaltySettings, getLevel, runSync, sleep } = require('../services/loyalty');
const { computeStaffMetrics } = require('../services/staff');
const { createLogger } = require('../logger');
const logger = createLogger('API');

// ── Records ──────────────────────────────────────────────────
router.get('/records', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  try {
    const { dateFrom, dateTo, status, phone, client: clientName, page = 1, limit = 50 } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const pageSize = Math.min(200, Math.max(10, parseInt(limit)));
    const offset   = (pageNum - 1) * pageSize;

    let where = ['r.salon_id=$1'], params = [req.user.salonId], i = 2;
    if (dateFrom) { where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) >= $${i}::date`); params.push(dateFrom); i++; }
    if (dateTo)   { where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) <= $${i}::date`); params.push(dateTo); i++; }
    if (phone)      { where.push(`c.phone ILIKE $${i}`); params.push('%' + phone.replace(/\D/g,'').slice(-10) + '%'); i++; }
    if (clientName) { where.push(`c.name ILIKE $${i}`); params.push('%' + clientName + '%'); i++; }
    if (status) {
      const statusMap = {
        completed:  { stored: ['completed'],                sids: [4],     atts: [] },
        arrived:    { stored: ['arrived'],                  sids: [3],     atts: [1] },
        confirmed:  { stored: ['confirmed', 'waiting'],     sids: [2],     atts: [2] },
        waiting:    { stored: ['waiting', 'pending'],       sids: [1],     atts: [0] },
        cancelled:  { stored: ['cancelled'],                sids: [5],     atts: [] },
        no_show:    { stored: ['no_show'],                  sids: [6],     atts: [-1] },
        deleted:    { stored: ['deleted'],                  sids: [7],     atts: [] },
      };
      const map = statusMap[status];
      if (map) {
        where.push(`(
          (r.raw_payload->>'attendance')::int = ANY($${i+2}::int[])
          OR (r.raw_payload->>'status_id')::int = ANY($${i+1}::int[])
          OR (r.status = ANY($${i}::text[])
              AND (r.raw_payload->>'attendance') IS NULL
              AND (r.raw_payload->>'status_id') IS NULL)
        )`);
        params.push(map.stored, map.sids, map.atts); i += 3;
      } else { where.push(`r.status=$${i}`); params.push(status); i++; }
    }
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) FROM records r LEFT JOIN clients c ON c.id=r.client_id WHERE ${w}`, params)).count;
    // db.any() instead of db.many() — empty result set is valid (no records in range)
    const records = await db.any(
      `SELECT r.*,
              c.name as client_name, c.phone as client_phone,
              COALESCE(
                (SELECT SUM((svc->>'cost_to_pay')::numeric) FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc WHERE (svc->>'cost_to_pay') IS NOT NULL),
                (SELECT SUM((svc->>'cost')::numeric) FROM jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc WHERE (svc->>'cost') IS NOT NULL),
                r.amount
              ) as real_amount,
              (SELECT SUM(lct.amount) FROM loyalty_card_transactions lct WHERE lct.salon_id=r.salon_id AND lct.amount>0
               AND (lct.record_id=r.id OR lct.record_id=r.yclients_record_id OR (lct.record_id IS NULL AND lct.client_id=r.client_id AND r.visit_date IS NOT NULL AND lct.txn_date::date=r.visit_date::date))
              ) as real_bonus_accrued,
              (SELECT ABS(SUM(lct.amount)) FROM loyalty_card_transactions lct WHERE lct.salon_id=r.salon_id AND lct.amount<0
               AND (lct.record_id=r.id OR lct.record_id=r.yclients_record_id OR (lct.record_id IS NULL AND lct.client_id=r.client_id AND r.visit_date IS NOT NULL AND lct.txn_date::date=r.visit_date::date))
              ) as real_bonus_redeemed,
              COALESCE((SELECT SUM(GREATEST(0,(svc->>'cost')::numeric - COALESCE((svc->>'cost_to_pay')::numeric,(svc->>'cost')::numeric)))
                FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc
                WHERE (svc->>'cost') IS NOT NULL AND (svc->>'discount')::numeric > 0),0) as discount_from_payload,
              COALESCE(CASE
                WHEN (r.raw_payload->>'deleted')::boolean = true THEN 'deleted'
                WHEN (r.raw_payload->>'attendance') IS NOT NULL THEN
                  CASE (r.raw_payload->>'attendance')::int WHEN 1 THEN 'arrived' WHEN 2 THEN 'confirmed' WHEN -1 THEN 'no_show' WHEN 0 THEN 'waiting' ELSE r.status END
                WHEN (r.raw_payload->>'status_id') IS NOT NULL THEN
                  CASE (r.raw_payload->>'status_id')::int WHEN 4 THEN 'completed' WHEN 3 THEN 'arrived' WHEN 2 THEN 'confirmed' WHEN 5 THEN 'cancelled' WHEN 7 THEN 'deleted' WHEN 6 THEN 'no_show' WHEN 1 THEN 'waiting' ELSE r.status END
                ELSE r.status
              END, r.status) as yclients_status,
              CASE WHEN (r.raw_payload->>'paid_full')::int = 1 THEN true ELSE false END as is_paid_full,
              to_char(CASE WHEN r.visit_datetime IS NOT NULL THEN (r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date ELSE r.visit_date END,'YYYY-MM-DD') as visit_date_msk
       FROM records r LEFT JOIN clients c ON c.id=r.client_id
       WHERE ${w} ORDER BY r.visit_datetime DESC NULLS LAST, r.visit_date DESC, r.id DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, pageSize, offset]
    );
    const enriched = records.map(r => ({
      ...r,
      amount:        parseFloat(r.real_amount || r.amount || 0),
      bonus_accrued: parseFloat(r.real_bonus_accrued || r.bonus_accrued || 0),
      bonus_redeemed: parseFloat(r.real_bonus_redeemed||0) > 0 ? parseFloat(r.real_bonus_redeemed) : parseFloat(r.discount_from_payload||0),
      status: r.yclients_status || r.status,
    }));
    res.json({ records: enriched, total: parseInt(total), page: pageNum, limit: pageSize, totalPages: Math.ceil(parseInt(total)/pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ────────────────────────────────────────────────
// Resolve from/to inclusive Moscow-local dates (YYYY-MM-DD).
// Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD, falls back to legacy ?period=N (N days back from Moscow today).
function resolvePeriod(req) {
  const todayMsk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  let { from, to } = req.query;
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isDate(from) && isDate(to)) {
    if (from > to) [from, to] = [to, from];
    return { from, to };
  }
  const days = Math.max(1, parseInt(req.query.period || 30));
  const back = new Date(todayMsk + 'T00:00:00Z');
  back.setUTCDate(back.getUTCDate() - (days - 1));
  return { from: back.toISOString().slice(0, 10), to: todayMsk };
}

router.get('/analytics/dashboard', auth, async (req, res) => {
  try {
    const sid = req.user.salonId;
    const { from, to } = resolvePeriod(req);
    // $1 = salon_id, $2 = from (date), $3 = to (date) — all period-bounded queries
    const p = [sid, from, to];
    const bonusStatsSql = `
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as accrued,
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as redeemed
      FROM (
        SELECT amount FROM loyalty_card_transactions lct JOIN clients c ON c.id=lct.client_id
        WHERE c.salon_id=$1 AND (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
        UNION ALL
        SELECT amount FROM bonus_transactions bt WHERE bt.salon_id=$1
          AND (bt.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
          AND bt.description NOT LIKE '%импорт%'
      ) combined`;
    // "Первичные" пациенты за период.
    // Правило: клиент первичный, если его ПЕРВЫЙ состоявшийся и полностью
    // оплаченный деньгами визит попал в период [from,to]. Квалифицирующий визит =
    //   • статус 'completed' ИЛИ 'arrived' (визит реально состоялся — см. логику кэшбэка);
    //   • paid_full=1 (полная оплата);
    //   • без скидок (ни одна услуга не имеет discount>0);
    //   • без списания бонусов (нет связанной расходной loyalty-транзакции).
    // Отменённые/несостоявшиеся (cancelled/no_show/waiting) записи НЕ учитываются,
    // поэтому клиент, у которого ранее были только отменённые записи, считается
    // первичным в день первого выполненного оплаченного визита.
    // Считаем по фактической дате визита, а НЕ по clients.created_at (дата импорта в БД).
    const primaryClientsSql = `
      WITH qualifying AS (
        SELECT r.client_id,
               MIN(COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)) AS first_visit
        FROM records r
        WHERE r.salon_id = $1
          AND r.client_id IS NOT NULL
          AND r.status IN ('completed','arrived')
          AND (r.raw_payload->>'paid_full')::int = 1
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc
            WHERE COALESCE(NULLIF(svc->>'discount','')::numeric, 0) > 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM loyalty_card_transactions lct
            WHERE lct.salon_id = r.salon_id AND lct.amount < 0
              AND (lct.record_id = r.id
                   OR lct.record_id = r.yclients_record_id
                   OR (lct.record_id IS NULL AND lct.client_id = r.client_id
                       AND r.visit_date IS NOT NULL AND lct.txn_date::date = r.visit_date::date))
          )
        GROUP BY r.client_id
      )
      SELECT COUNT(*) FROM qualifying
      WHERE first_visit BETWEEN $2::date AND $3::date`;
    const [tc,ac,slp,nc,bs,rev,bonusStat,topSvc,lvlDist,daily,recentTx,lastSync,tgCount,cardCount,bonEconomy,revByCatRows] = await Promise.all([
      db.one('SELECT COUNT(*) FROM clients WHERE salon_id=$1',[sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND (last_visit_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date`,p),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at<NOW()-INTERVAL '60 days' AND visits_count>0`,[sid]),
      db.one(primaryClientsSql,p),
      db.one(`SELECT COALESCE(SUM(bonus_balance),0) as tb, COALESCE(SUM(total_spent),0) as ts FROM clients WHERE salon_id=$1`,[sid]),
      db.one(`SELECT COUNT(*) as rc, COALESCE(SUM(amount),0) as rv FROM records WHERE salon_id=$1 AND status IN ('completed','confirmed','arrived') AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) BETWEEN $2::date AND $3::date`,p),
      db.one(bonusStatsSql,p),
      // db.any() — may be empty if no completed records in period
      db.any(`SELECT svc->>'title' as service_name, COUNT(DISTINCT r.id) as cnt, SUM((svc->>'cost_to_pay')::numeric) as total_amount FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc WHERE r.salon_id=$1 AND r.status IN ('completed','confirmed','arrived') AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date AND svc->>'title' IS NOT NULL GROUP BY svc->>'title' ORDER BY svc->>'title' ASC LIMIT 100000`,p),
      // db.any() — may be empty if no clients yet
      db.any(`SELECT loyalty_level, COUNT(*) as cnt FROM clients WHERE salon_id=$1 GROUP BY loyalty_level`,[sid]),
      // db.any() — may be empty if no revenue data in period
      db.any(`WITH rev AS (SELECT COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)::date as d, COUNT(*) as records, COALESCE(SUM(amount),0) as revenue FROM records WHERE salon_id=$1 AND status IN ('completed','confirmed','arrived') AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) BETWEEN $2::date AND $3::date GROUP BY COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)), bon AS (SELECT (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date as d, COALESCE(SUM(CASE WHEN lct.amount>0 THEN lct.amount ELSE 0 END),0) as bonuses_accrued, COALESCE(SUM(CASE WHEN lct.amount<0 THEN ABS(lct.amount) ELSE 0 END),0) as bonuses_redeemed FROM loyalty_card_transactions lct JOIN clients c ON c.id=lct.client_id WHERE c.salon_id=$1 AND (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date GROUP BY (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date) SELECT rev.d::text as visit_date, rev.records, rev.revenue, COALESCE(bon.bonuses_accrued,0) as bonuses_accrued, COALESCE(bon.bonuses_redeemed,0) as bonuses_redeemed FROM rev LEFT JOIN bon ON bon.d=rev.d ORDER BY rev.d`,p),
      // db.any() — may be empty if no transactions yet
      db.any(`SELECT sub.*, c.name as client_name FROM (SELECT DISTINCT ON (client_id, title, txn_date::date, amount) lct.id, lct.txn_date as created_at, lct.amount, lct.title as description, lct.client_id FROM loyalty_card_transactions lct JOIN clients c2 ON c2.id=lct.client_id WHERE c2.salon_id=$1 ORDER BY client_id, title, txn_date::date, amount, lct.txn_date DESC NULLS LAST) sub JOIN clients c ON c.id=sub.client_id ORDER BY sub.created_at DESC NULLS LAST LIMIT 15`,[sid]),
      // db.oneOrNone() — sync may never have run; db.one() would throw on 0 rows
      db.oneOrNone(`SELECT * FROM sync_logs WHERE salon_id=$1 ORDER BY started_at DESC LIMIT 1`,[sid]),
      botDb.one(`SELECT COUNT(*) FROM clients_peri WHERE tg_id IS NOT NULL`),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND yclients_card_id IS NOT NULL`,[sid]),
      // db.any() — may be empty if no transactions in period
      db.any(`SELECT CASE WHEN lct.title ILIKE '%день рождения%' OR lct.title ILIKE '%ДР%' OR lct.title ILIKE '%подарок%' THEN 'birthday' WHEN lct.type='redemption' AND lct.title ILIKE '%отмена%' THEN 'cancellation' WHEN lct.type='redemption' THEN 'redemption' ELSE 'accrual' END as type, COALESCE(SUM(ABS(lct.amount)),0) as total FROM loyalty_card_transactions lct JOIN clients c ON c.id=lct.client_id WHERE c.salon_id=$1 AND (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY total DESC`,p),
      // db.any() — revenue breakdown by category; empty if revenue_operations has no rows in period
      db.any(`
        SELECT category, COALESCE(SUM(amount),0) AS total
        FROM revenue_operations
        WHERE salon_id=$1
          AND operation_date BETWEEN $2::date AND $3::date
          AND category IN ('services','goods','abonement','certificate','deposit')
        GROUP BY category
      `, p),
    ]);
    const revByCat = { services: 0, goods: 0, abonement: 0, certificate: 0, deposit: 0 };
    for (const row of revByCatRows) {
      if (row.category in revByCat) revByCat[row.category] = parseFloat(row.total);
    }
    revByCat.total = revByCat.services + revByCat.goods + revByCat.abonement + revByCat.certificate + revByCat.deposit;
    // Fallback: if revenue_operations has no data for the period, use records.amount as services revenue
    if (revByCat.total === 0) {
      revByCat.services = parseFloat(rev.rv) || 0;
      revByCat.total = revByCat.services;
    }
    res.json({ stats: { totalClients: parseInt(tc.count), activeClients: parseInt(ac.count), sleepingClients: parseInt(slp.count), newClients: parseInt(nc.count), totalBonusBalance: parseFloat(bs.tb), totalSpent: parseFloat(bs.ts), periodRevenue: revByCat.total, periodRevenueByCategory: revByCat, periodRecords: parseInt(rev.rc), periodBonuses: parseFloat(bonusStat.accrued), periodRedeemed: parseFloat(bonusStat.redeemed), telegramClients: parseInt(tgCount.count), cardClients: parseInt(cardCount.count) }, period: { from, to }, levelDist: lvlDist, topServices: topSvc, dailyRevenue: daily, recentTxns: recentTx, syncStatus: lastSync, bonusEconomy: bonEconomy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Personal Staff Dashboard (для role=specialist) ─────────────────
// Спека: docs/superpowers/specs/2026-06-01-staff-dashboard-design.md

// Все числовые метрики специалиста за произвольный период. Вызывается до трёх
// раз за запрос: основной период + сравнительные (весь прошлый календарный
// месяц и эквивалентный отрезок прошлого месяца — для бейджей динамики).
async function computeSpecialistStats(sid, yc, from, to) {
  const sdSvc = require('../services/staff-dashboard');
  const p = [sid, from, to, yc];

  const [rev, byCat, noShow, first, staffMetrics] = await Promise.all([
    db.one(`SELECT COUNT(*) AS rc, COALESCE(SUM(amount),0) AS rv FROM records r
            WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
              AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
              AND COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) = $4`, p),
      // goods/abonement: считаем через связь с визитом (yclients_record_id).
      // Если товар/абонемент продана во время визита, то выручка идёт мастеру визита.
      // Если продажа не привязана к визиту — берём directly из operation данные:
      // если raw_payload.data.master[0].id указан явно, считаем по нему; иначе скипаем.
      // Услуги (`services`) считаем отдельно — через records.amount (см. ниже),
      // чтобы итог совпадал с total визитов и не уплывал из-за частичных оплат.
      db.any(`SELECT ro.category, COALESCE(SUM(ro.amount),0) AS total
              FROM revenue_operations ro
              LEFT JOIN records r ON r.salon_id=$1 AND r.yclients_record_id = ro.yclients_record_id
              WHERE ro.salon_id=$1 AND ro.operation_date BETWEEN $2::date AND $3::date
                AND ro.category IN ('goods','abonement')
                AND (
                  -- Если есть связь к визиту: кредитуем мастера визита
                  (r.id IS NOT NULL
                   AND COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) = $4)
                  OR
                  -- Если нет — считаем операцию, только если master явно указан
                  (r.id IS NULL
                   AND jsonb_typeof(ro.raw_payload->'data'->'master') = 'array'
                   AND jsonb_array_length(ro.raw_payload->'data'->'master') > 0
                   AND (ro.raw_payload->'data'->'master'->0->>'id')::int = $4)
                )
              GROUP BY ro.category`, p),
      // «Не пришли» — визиты со статусом no_show за период, где мастер = специалист.
      // Сюда специально НЕ фильтруем по completed/arrived (как остальные метрики),
      // потому что нужны как раз пропущенные визиты.
      db.one(`SELECT COUNT(*) AS n FROM records r
              WHERE r.salon_id=$1 AND r.status = 'no_show'
                AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                AND COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) = $4`, p),
      // «Мои первичные» = клиент, чей первый-в-салоне оплаченный визит был
      // в периоде, мастером был данный специалист, И мы знаем о всех его
      // визитах (YClients-clients.visits_count <= числа наших записей).
      // Последняя проверка — защита от случая, когда у клиента в YClients
      // 25 визитов, но наш sync принёс только 1: без неё мы бы ошибочно
      // считали такого клиента «первичным».
      db.one(`WITH client_record_count AS (
                -- Считаем ВСЕ записи (любые статусы) — clients.visits_count в YClients
                -- включает в т.ч. waiting/confirmed/no_show. Если YClients знает
                -- больше визитов чем мы — клиент НЕ первичный (мы потеряли историю).
                SELECT client_id, COUNT(*) AS n
                FROM records WHERE salon_id=$1
                GROUP BY client_id
              ),
              client_first AS (
                SELECT client_id,
                       MIN(COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)) AS d,
                       (ARRAY_AGG(COALESCE(raw_payload->'staff'->>'id', raw_payload->'staff'->0->>'id') ORDER BY visit_date))[1]::int AS first_staff
                FROM records WHERE salon_id=$1 AND status IN ('completed','arrived')
                  AND (raw_payload->>'paid_full')::int = 1
                GROUP BY client_id
              )
              SELECT COUNT(*) AS n FROM client_first cf
              JOIN clients cl ON cl.id = cf.client_id
              LEFT JOIN client_record_count crc ON crc.client_id = cf.client_id
              WHERE cf.d BETWEEN $2::date AND $3::date
                AND cf.first_staff = $4
                AND COALESCE(cl.visits_count, 0) <= COALESCE(crc.n, 0)`, p),
      // Метрики из «Сотрудники»-аналитики — возвращаемость, перезапись,
      // продажи товаров, загрузка. Считает существующий computeStaffMetrics
      // на той же таблице records и плюс goods_sales / staff_schedule.
      // Если упадёт (например, нет staff_schedule) — не валим весь запрос,
      // возвращаем null.
      computeStaffMetrics(sid, yc, from, to).catch(e => {
        logger.warn?.(`computeStaffMetrics failed for staff=${yc}: ${e.message}`);
        return null;
      }),
  ]);

  // Услуги = вся выручка визитов специалиста (records.amount).
  // Косметика/абонементы — из revenue_operations через связь операции с визитом
  // (см. byCat выше), кредитуются мастеру визита.
  const opSums = sdSvc.aggregateRevenueByCategory(byCat);  // goods + abonement
  const servicesSum = parseFloat(rev.rv) || 0;
  const revenueByCategory = {
    services: servicesSum,
    goods: opSums.goods,
    abonement: opSums.abonement,
    total: servicesSum + opSums.goods + opSums.abonement,
  };
  const periodRecords = parseInt(rev.rc);
  const periodRevenue = revenueByCategory.total;
  const avgCheck = sdSvc.computeAvgCheck(periodRecords, periodRevenue);

  // 4 метрики из «Сотрудники»-аналитики. computeStaffMetrics() может вернуть
  // null если не было данных — отдаём null, фронт покажет «—».
  const extra = staffMetrics ? {
    retentionRate:     staffMetrics.retentionRate,     // %; null если < 45д истории
    reappointmentRate: staffMetrics.reappointmentRate, // % визитов с перезаписью
    goodsCount:        staffMetrics.goodsCount,        // шт. проданных товаров
    goodsRevenue:      staffMetrics.goodsRevenue,      // ₽ выручка от товаров (этого мастера)
    utilizationRate:   staffMetrics.utilizationRate,   // % загрузки от расписания
  } : { retentionRate: null, reappointmentRate: null, goodsCount: 0, goodsRevenue: 0, utilizationRate: null };

  return {
    periodRecords, periodRevenue, revenueByCategory,
    noShowClients: parseInt(noShow.n),
    newClients: parseInt(first.n),
    avgCheck,
    ...extra,
  };
}

router.get('/analytics/staff-dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'specialist') return res.status(403).json({ error: 'forbidden' });
    const sid = req.user.salonId, uid = req.user.userId;
    const { from, to } = resolvePeriod(req);

    // Привязка → yclients_staff_id
    const link = await db.oneOrNone(`
      SELECT sm.yclients_staff_id, sm.name AS staff_name
      FROM users u JOIN staff_members sm ON sm.id = u.staff_member_id
      WHERE u.id = $1 AND sm.salon_id = $2
    `, [uid, sid]);
    if (!link) return res.json({ unlinked: true });

    const yc = link.yclients_staff_id;
    const p = [sid, from, to, yc];

    // Сравнительные периоды: весь прошлый календарный месяц (справка на
    // карточках) + эквивалентный отрезок прошлого месяца (с 1-го по то же
    // число) — для честной динамики, пока текущий месяц не закончился.
    const cmp = require('../services/staff-dashboard').prevMonthRanges(to);

    const [stats, top, daily, prevMonthStats, prevWindowOwn] = await Promise.all([
      computeSpecialistStats(sid, yc, from, to),
      db.any(`SELECT svc->>'title' AS service_name, COUNT(DISTINCT r.id) AS cnt,
                     SUM((svc->>'cost_to_pay')::numeric) AS total_amount
              FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
              WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                AND COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) = $4
                AND svc->>'title' IS NOT NULL
              GROUP BY 1 ORDER BY total_amount DESC NULLS LAST LIMIT 5`, p),
      db.any(`SELECT COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)::text AS d,
                     COUNT(*) AS records, COALESCE(SUM(amount),0) AS revenue
              FROM records r
              WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
                AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) BETWEEN $2::date AND $3::date
                AND COALESCE((r.raw_payload->'staff'->>'id')::int, (r.raw_payload->'staff'->0->>'id')::int) = $4
              GROUP BY 1 ORDER BY 1`, p),
      computeSpecialistStats(sid, yc, cmp.monthFrom, cmp.monthTo),
      // Если «то же число» — конец прошлого месяца, отрезок совпадает с целым
      // месяцем: не считаем дважды, переиспользуем prevMonthStats ниже.
      cmp.windowTo === cmp.monthTo ? null : computeSpecialistStats(sid, yc, cmp.windowFrom, cmp.windowTo),
    ]);

    res.json({
      stats: { staffName: link.staff_name, ...stats },
      topServices: top,
      dailyRevenue: daily,
      period: { from, to },
      comparison: {
        prevMonth:  { from: cmp.monthFrom,  to: cmp.monthTo,  stats: prevMonthStats },
        prevWindow: { from: cmp.windowFrom, to: cmp.windowTo, stats: prevWindowOwn || prevMonthStats },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics/bonuses', auth, async (req, res) => {
  try {
    const sid = req.user.salonId;
    const { from, to } = resolvePeriod(req);
    // db.any() — may be empty if no bonus transactions in period
    const rows = await db.any(
      `SELECT day::text, SUM(accrued) as accrued, SUM(redeemed) as redeemed FROM (
        SELECT (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date as day,
          CASE WHEN lct.amount>0 THEN lct.amount ELSE 0 END as accrued,
          CASE WHEN lct.amount<0 THEN ABS(lct.amount) ELSE 0 END as redeemed
        FROM loyalty_card_transactions lct JOIN clients c ON c.id=lct.client_id
        WHERE c.salon_id=$1 AND (COALESCE(lct.txn_date,lct.created_at) AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
        UNION ALL
        SELECT (bt.created_at AT TIME ZONE 'Europe/Moscow')::date as day,
          CASE WHEN bt.amount>0 THEN bt.amount ELSE 0 END as accrued,
          CASE WHEN bt.amount<0 THEN ABS(bt.amount) ELSE 0 END as redeemed
        FROM bonus_transactions bt WHERE bt.salon_id=$1
          AND (bt.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $2::date AND $3::date
          AND bt.description NOT LIKE '%импорт%'
      ) combined GROUP BY day ORDER BY day`, [sid, from, to]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/analytics/retention', auth, async (req, res) => {
  try {
    // db.any() — may be empty for new salons with insufficient history
    const rows = await db.any(
      `SELECT cohort_month,total,m1,m2,m3 FROM (
         SELECT DATE_TRUNC('month',first_visit) as cohort_month,COUNT(DISTINCT client_id) as total,
           COUNT(DISTINCT CASE WHEN months_since>=1 THEN client_id END) as m1,
           COUNT(DISTINCT CASE WHEN months_since>=2 THEN client_id END) as m2,
           COUNT(DISTINCT CASE WHEN months_since>=3 THEN client_id END) as m3
         FROM (
           SELECT client_id,MIN(visit_date) OVER (PARTITION BY client_id) as first_visit,
                  EXTRACT(YEAR FROM AGE(visit_date,MIN(visit_date) OVER (PARTITION BY client_id)))*12
                    + EXTRACT(MONTH FROM AGE(visit_date,MIN(visit_date) OVER (PARTITION BY client_id))) as months_since
           FROM records WHERE salon_id=$1 AND status IN ('completed','confirmed') AND client_id IS NOT NULL
         ) t GROUP BY cohort_month
       ) agg
       WHERE cohort_month <= DATE_TRUNC('month',NOW()) - INTERVAL '3 months'
       ORDER BY cohort_month ASC LIMIT 6`, [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sync API ─────────────────────────────────────────────────
router.post('/sync', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id || !salon.yclients_user_token)
      return res.status(400).json({ error: 'YClients не настроен. Укажите токены в Настройках.' });
    res.json({ ok: true, message: 'Синхронизация запущена' });
    runSync(salon, 'manual', req.user.userId).catch(e => logger.error(`Sync trigger: ${e.message}`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sync/logs', auth, async (req, res) => {
  try {
    // db.any() — may be empty if sync has never run
    res.json(await db.any(
      `SELECT sl.*,u.name as user_name FROM sync_logs sl
       LEFT JOIN users u ON u.id=sl.initiated_by
       WHERE sl.salon_id=$1 ORDER BY sl.started_at DESC LIMIT 20`,
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync/link-transactions', auth, async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE loyalty_card_transactions lct SET record_id = sub.record_id
      FROM (
        SELECT DISTINCT ON (lct2.id) lct2.id AS txn_id, r.id AS record_id
        FROM loyalty_card_transactions lct2 JOIN records r
          ON r.client_id=lct2.client_id AND r.salon_id=lct2.salon_id AND r.visit_date=lct2.txn_date::date
        WHERE lct2.salon_id=$1 AND lct2.record_id IS NULL AND lct2.txn_date IS NOT NULL
          AND r.visit_date IS NOT NULL AND r.status IN ('completed','confirmed')
        ORDER BY lct2.id, r.visit_datetime DESC
      ) sub WHERE lct.id=sub.txn_id
    `, [req.user.salonId]);
    res.json({ ok: true, linked: result.rowCount || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/webhook-logs', auth, async (req, res) => {
  try {
    // db.any() — may be empty if no webhooks received yet
    res.json(await db.any('SELECT * FROM webhook_logs WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.salonId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/yclients/services', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    res.json(await ycGet(salon, `/services/${salon.yclients_company_id}`));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/yclients/card-types', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    const { ycGetCardTypes } = require('../services/yclients');
    res.json(await ycGetCardTypes(salon));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Bulk Import ───────────────────────────────────────────────
const bulkImportStatus = {};

router.post('/bulk-import-card-history', auth, async (req, res) => {
  const salonId = req.user.salonId;
  if (bulkImportStatus[salonId]?.running)
    return res.json({ ok: false, message: 'Импорт уже запущен', status: bulkImportStatus[salonId] });

  let salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon.yclients_login) return res.status(400).json({ error: 'Логин YClients не сохранён.' });
  if (!salon.yclients_card_type_id) return res.status(400).json({ error: 'Карта лояльности не выбрана в Настройках.' });

  bulkImportStatus[salonId] = { running: true, started: new Date(), total: 0, done: 0, imported: 0, errors: 0, currentClient: '' };
  res.json({ ok: true, message: 'Импорт запущен' });

  (async () => {
    try {
      const clients = await db.many(
        `SELECT id,name,phone,yclients_client_id,yclients_card_id FROM clients
         WHERE salon_id=$1 AND yclients_card_id IS NOT NULL AND yclients_client_id IS NOT NULL ORDER BY id`,
        [salonId]
      );
      bulkImportStatus[salonId].total = clients.length;

      const { ycWebLogin } = require('../services/yclients');
      try { await ycWebLogin(salon); } catch (e) {
        bulkImportStatus[salonId].running = false;
        bulkImportStatus[salonId].error = `Ошибка входа: ${e.message}`; return;
      }

      for (let i = 0; i < clients.length; i++) {
        const c = clients[i];
        bulkImportStatus[salonId].done = i;
        bulkImportStatus[salonId].currentClient = c.name;

        try {
          if (i % 50 === 0) salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
          const txns = await ycGetCardTransactions(salon, c.yclients_client_id, c.phone, salon.yclients_chain_id);
          for (const t of txns) {
            try {
              const txnAmt = parseFloat(t.amount || 0);
              const txnDate = t.txn_date || null;
              let isDup = false;
              if (txnDate) {
                // db.oneOrNone() — 0 rows means not a duplicate; db.one() would throw
                const dup = await db.oneOrNone(`SELECT id FROM loyalty_card_transactions WHERE client_id=$1 AND amount=$2 AND txn_date::date=$3::date LIMIT 1`, [c.id, txnAmt, txnDate]);
                isDup = !!dup;
              }
              if (!isDup) {
                await db.query(
                  `INSERT INTO loyalty_card_transactions (salon_id,client_id,yclients_card_id,type,amount,title,txn_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                  [salonId, c.id, c.yclients_card_id, txnAmt >= 0 ? 'accrual' : 'redemption', txnAmt, t.title || (txnAmt >= 0 ? 'Начисление' : 'Списание'), txnDate]
                );
                bulkImportStatus[salonId].imported++;
              }
            } catch {}
          }
          const cards = await ycGetClientCards(salon, c.yclients_client_id);
          const card = cards.find(cd => String(cd.type?.id) === String(salon.yclients_card_type_id));
          if (card) {
            const paidAmount = parseFloat(card.paid_amount || card.sold_amount || 0);
            const lsData = await getLoyaltySettings(salonId);
            const level = lsData?.levels ? getLevel(paidAmount, lsData.levels) : null;
            await db.query(
              `UPDATE clients SET yclients_card_balance=$1,bonus_balance=$2,total_spent=GREATEST(total_spent,$3),visits_count=GREATEST(visits_count,$4),loyalty_level=COALESCE($5,loyalty_level),updated_at=NOW() WHERE id=$6`,
              [parseFloat(card.balance||0), parseFloat(card.balance||0), paidAmount, parseInt(card.visits_count||0), level?.key||null, c.id]
            );
          }
        } catch (e) {
          bulkImportStatus[salonId].errors++;
          if (e.message.includes('авторизац') || e.message.includes('login')) delete ycWebSessions[salonId];
        }
        await sleep(500);
      }
      bulkImportStatus[salonId].running = false;
      bulkImportStatus[salonId].done = clients.length;
      bulkImportStatus[salonId].finished = new Date();
    } catch (e) {
      bulkImportStatus[salonId].running = false;
      bulkImportStatus[salonId].error = e.message;
    }
  })();
});

router.get('/bulk-import-card-history/status', auth, async (req, res) => {
  const status = bulkImportStatus[req.user.salonId];
  res.json(status || { running: false, notStarted: true });
});

router.get('/finances-log', auth, async (req, res) => {
  try {
    // db.any() — may be empty if no finance log entries yet
    res.json(await db.any(
      `SELECT fl.*,c.name as client_name FROM finances_log fl
       LEFT JOIN clients c ON c.id=fl.client_id
       WHERE fl.salon_id=$1 ORDER BY fl.created_at DESC LIMIT 50`,
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Loyalty Settings ──────────────────────────────────────────
router.get('/loyalty-settings', auth, async (req, res) => {
  try { res.json(await getLoyaltySettings(req.user.salonId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/loyalty-settings', auth, async (req, res) => {
  try {
    const { levels, service_cashback, birthday_bonus, birthday_days_before, birthday_enabled,
            referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days,
            bonuses_enabled } = req.body;
    await db.query(
      `INSERT INTO loyalty_settings
         (salon_id,levels,service_cashback,birthday_bonus,birthday_days_before,birthday_enabled,
          referral_enabled,referral_bonus_sender,referral_bonus_receiver,bonus_expiry_days,
          bonuses_enabled,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (salon_id) DO UPDATE SET
         levels=$2,service_cashback=$3,birthday_bonus=$4,birthday_days_before=$5,
         birthday_enabled=$6,referral_enabled=$7,referral_bonus_sender=$8,
         referral_bonus_receiver=$9,bonus_expiry_days=$10,bonuses_enabled=$11,updated_at=NOW()`,
      [req.user.salonId, JSON.stringify(levels), JSON.stringify(service_cashback || {}),
       birthday_bonus, birthday_days_before, birthday_enabled,
       referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days || 0,
       bonuses_enabled !== false]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
