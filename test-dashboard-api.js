require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const db = {
  query: (sql, p) => pool.query(sql, p),
  one: async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many: async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

async function testDashboard() {
  try {
    console.log('🧪 ТЕСТИРОВАНИЕ API /analytics/dashboard\n');

    const sid = 1; // PERI CLINIC
    const days = 30;

    console.log(`Salon ID: ${sid}, Period: ${days} дней\n`);

    const bonusStatsSql = `
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as accrued,
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as redeemed
      FROM (
        SELECT amount FROM loyalty_card_transactions lct JOIN clients c ON c.id=lct.client_id
        WHERE c.salon_id=$1 AND COALESCE(lct.txn_date,lct.created_at) >= NOW()-INTERVAL '${days} days'
        UNION ALL
        SELECT amount FROM bonus_transactions bt WHERE bt.salon_id=$1
          AND bt.created_at >= NOW()-INTERVAL '${days} days' AND bt.description NOT LIKE '%импорт%'
      ) combined`;

    // Эти же запросы что в API
    const [tc, ac, bonusStat, topSvc, cardCount] = await Promise.all([
      db.one('SELECT COUNT(*) FROM clients WHERE salon_id=$1', [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at>NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(bonusStatsSql, [sid]),
      db.many(`SELECT svc->>'title' as service_name, COUNT(DISTINCT r.id) as cnt, SUM((svc->>'cost_to_pay')::numeric) as total_amount FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc WHERE r.salon_id=$1 AND r.status IN ('completed','confirmed') AND r.visit_date>=NOW()-INTERVAL '${days} days' AND svc->>'title' IS NOT NULL GROUP BY svc->>'title' ORDER BY svc->>'title' ASC LIMIT 100000`, [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND yclients_card_id IS NOT NULL`, [sid]),
    ]);

    console.log('📊 РЕЗУЛЬТАТЫ API:\n');
    console.log(`Всего клиентов: ${tc.count}`);
    console.log(`Активных (за ${days} дней): ${ac.count}`);
    console.log(`Клиентов с картой: ${cardCount.count}`);
    console.log(`\n🎁 Бонусы:`);
    console.log(`   Начислено: ${parseFloat(bonusStat.accrued).toFixed(2)}`);
    console.log(`   Списано: ${parseFloat(bonusStat.redeemed).toFixed(2)}`);
    console.log(`\n⭐ Топ услуг (${topSvc.length} уникальных):`);
    topSvc.slice(0, 5).forEach((svc, i) => {
      console.log(`   ${i+1}. ${svc.service_name}: ${svc.cnt} услуг`);
    });

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

testDashboard();
