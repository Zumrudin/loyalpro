require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const db = {
  one: async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many: async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

async function test() {
  try {
    console.log('🧪 ТЕСТИРОВАНИЕ API /api/records с фильтром 1-12 апреля\n');

    const salonId = 1;
    const dateFrom = '2026-04-01';
    const dateTo = '2026-04-12';
    const page = 1;
    const limit = 50;

    let where = ['r.salon_id=$1'], params = [salonId], i = 2;
    where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) >= $${i}::date`); 
    params.push(dateFrom); 
    i++;
    where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) <= $${i}::date`); 
    params.push(dateTo); 
    i++;

    const w = where.join(' AND ');
    const offset = (page - 1) * limit;

    const total = (await db.one(`SELECT COUNT(*) FROM records r WHERE ${w}`, params)).count;
    
    const records = await db.many(
      `SELECT r.id, r.visit_date, r.visit_datetime, r.status, r.client_id,
              to_char(CASE WHEN r.visit_datetime IS NOT NULL THEN (r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date ELSE r.visit_date END,'YYYY-MM-DD') as visit_date_msk
       FROM records r
       WHERE ${w} 
       ORDER BY r.visit_datetime DESC NULLS LAST, r.visit_date DESC, r.id DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );

    console.log(`Фильтр: ${dateFrom} - ${dateTo}`);
    console.log(`Всего найдено: ${total} записей`);
    console.log(`Показано (страница ${page}, лимит ${limit}): ${records.length} записей\n`);
    
    console.log('ID | visit_date_msk | visit_datetime');
    console.log('-'.repeat(50));
    
    const dateCount = {};
    records.forEach(r => {
      console.log(`${String(r.id).padEnd(5)} | ${String(r.visit_date_msk).padEnd(14)} | ${String(r.visit_datetime || 'NULL').substring(0, 19)}`);
      dateCount[r.visit_date_msk] = (dateCount[r.visit_date_msk] || 0) + 1;
    });

    console.log('\n📊 Показанные на странице:');
    Object.keys(dateCount).sort().forEach(date => {
      console.log(`  ${date}: ${dateCount[date]}`);
    });

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

test();
