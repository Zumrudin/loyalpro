require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('📅 ДАННЫЕ ЗА ТЕКУЩИЙ МЕСЯЦ (апрель 2026)\n');

    const salonId = 1; // PERI CLINIC
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
    
    console.log(`Период: ${startOfMonth} - конец месяца\n`);

    // 1. Приёмы/визиты за месяц
    const records = await pool.query(
      `SELECT COUNT(*) as count, MIN(visit_date) as first_date, MAX(visit_date) as last_date
       FROM records WHERE salon_id=$1 AND visit_date >= $2::date`,
      [salonId, startOfMonth]
    );
    console.log(`📝 Приёмы (records): ${records.rows[0].count}`);
    if (records.rows[0].count > 0) {
      console.log(`   Первый: ${records.rows[0].first_date}, Последний: ${records.rows[0].last_date}`);
    }

    // 2. Операции карт за месяц
    const txns = await pool.query(
      `SELECT COUNT(*) as count, MIN(txn_date) as first_date, MAX(txn_date) as last_date
       FROM loyalty_card_transactions WHERE salon_id=$1 AND txn_date >= $2::date`,
      [salonId, startOfMonth]
    );
    console.log(`\n💳 Операции карт (loyalty_card_transactions): ${txns.rows[0].count}`);
    if (txns.rows[0].count > 0) {
      console.log(`   Первый: ${txns.rows[0].first_date}, Последний: ${txns.rows[0].last_date}`);
    }

    // 3. Клиенты с картой лояльности
    const cardsCount = await pool.query(
      `SELECT COUNT(*) as count FROM clients WHERE salon_id=$1 AND yclients_card_id IS NOT NULL`,
      [salonId]
    );
    console.log(`\n💰 Клиенты с картой: ${cardsCount.rows[0].count}`);

    // 4. Начислено/списано бонусов за месяц
    const bonuses = await pool.query(
      `SELECT 
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as accrued,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as redeemed,
        COUNT(*) as total_txns
       FROM loyalty_card_transactions lct 
       JOIN clients c ON c.id=lct.client_id
       WHERE c.salon_id=$1 AND lct.txn_date >= $2::date`,
      [salonId, startOfMonth]
    );
    console.log(`\n🎁 Бонусы за месяц:`);
    console.log(`   Начислено: ${parseFloat(bonuses.rows[0].accrued || 0).toFixed(2)}`);
    console.log(`   Списано: ${parseFloat(bonuses.rows[0].redeemed || 0).toFixed(2)}`);
    console.log(`   Всего операций: ${bonuses.rows[0].total_txns}`);

    // 5. Выручка по дням за месяц
    const revenue = await pool.query(
      `SELECT COUNT(DISTINCT visit_date) as days_with_revenue
       FROM records WHERE salon_id=$1 AND visit_date >= $2::date AND status IN ('completed','confirmed')`,
      [salonId, startOfMonth]
    );
    console.log(`\n💵 Дней с выручкой: ${revenue.rows[0].days_with_revenue}`);

    // 6. Топ услуг за месяц
    const topServices = await pool.query(
      `SELECT COUNT(DISTINCT svc->>'title') as unique_services
       FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
       WHERE r.salon_id=$1 AND r.visit_date >= $2::date AND svc->>'title' IS NOT NULL`,
      [salonId, startOfMonth]
    );
    console.log(`\n⭐ Уникальных услуг: ${topServices.rows[0].unique_services}`);

    // Проверка синхронизации логов
    console.log(`\n🔄 История синхронизации:`);
    const syncLogs = await pool.query(
      `SELECT status, started_at, finished_at FROM sync_logs WHERE salon_id=$1 ORDER BY started_at DESC LIMIT 3`,
      [salonId]
    );
    syncLogs.rows.forEach((log, i) => {
      console.log(`   ${i+1}. ${log.status} - ${new Date(log.started_at).toLocaleString('ru')}`);
    });

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
