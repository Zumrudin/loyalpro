require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('🔍 АНАЛИЗ ЗАПИСЕЙ ПО ДАТАМ\n');

    // Все записи за апрель и их даты
    const records = await pool.query(`
      SELECT 
        id,
        visit_date,
        visit_datetime,
        (COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date))::text as computed_date,
        status,
        client_id
      FROM records 
      WHERE salon_id=1 AND visit_date >= '2026-04-01'::date AND visit_date <= '2026-04-12'::date
      ORDER BY visit_date, visit_datetime
      LIMIT 20
    `);

    console.log(`Записи за 1-12 апреля:\n`);
    console.log('ID | visit_date | visit_datetime | computed_date');
    console.log('-'.repeat(70));
    
    const dateMap = {};
    records.rows.forEach(r => {
      console.log(`${String(r.id).padEnd(3)} | ${String(r.visit_date).padEnd(10)} | ${String(r.visit_datetime || 'NULL').padEnd(14)} | ${r.computed_date}`);
      dateMap[r.visit_date] = (dateMap[r.visit_date] || 0) + 1;
    });

    console.log('\n📊 Распределение по датам:');
    Object.keys(dateMap).sort().forEach(date => {
      console.log(`  ${date}: ${dateMap[date]} записей`);
    });

    // Проверим сколько всего за апрель
    const total = await pool.query(`
      SELECT COUNT(*) as count FROM records 
      WHERE salon_id=1 AND visit_date >= '2026-04-01'::date AND visit_date <= '2026-04-12'::date
    `);
    console.log(`\n✅ Всего записей за 1-12 апреля в БД: ${total.rows[0].count}`);

    // А что возвращает фильтр по дате с временем
    const filtered = await pool.query(`
      SELECT COUNT(*) as count,
        MIN(COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)) as min_date,
        MAX(COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)) as max_date
      FROM records 
      WHERE salon_id=1 
        AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) >= '2026-04-01'::date
        AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) <= '2026-04-12'::date
    `);
    console.log(`\n🔍 С фильтром по computed_date:`);
    console.log(`   Найдено: ${filtered.rows[0].count}`);
    console.log(`   Диапазон: ${filtered.rows[0].min_date} - ${filtered.rows[0].max_date}`);

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
