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
    const salonId = 1;
    const dateFrom = '2026-04-01';
    const dateTo = '2026-04-12';
    const limit = 50;

    let where = ['r.salon_id=$1'], params = [salonId], i = 2;
    where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) >= $${i}::date`); 
    params.push(dateFrom); i++;
    where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) <= $${i}::date`); 
    params.push(dateTo); i++;

    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) FROM records r WHERE ${w}`, params)).count;
    const totalPages = Math.ceil(total / limit);

    console.log(`📋 Записи 1-12 апреля: ${total} всего, ${totalPages} страниц по ${limit} записей\n`);

    // Последняя страница
    const lastPage = totalPages;
    const offset = (lastPage - 1) * limit;

    const lastRecords = await db.many(
      `SELECT r.id, to_char(CASE WHEN r.visit_datetime IS NOT NULL THEN (r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date ELSE r.visit_date END,'YYYY-MM-DD') as visit_date_msk
       FROM records r
       WHERE ${w} 
       ORDER BY r.visit_datetime DESC NULLS LAST, r.visit_date DESC, r.id DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );

    console.log(`Страница ${lastPage} (последняя):\n`);
    const dateCount = {};
    lastRecords.forEach(r => {
      dateCount[r.visit_date_msk] = (dateCount[r.visit_date_msk] || 0) + 1;
    });

    Object.keys(dateCount).sort().forEach(date => {
      console.log(`  ${date}: ${dateCount[date]} записей`);
    });

    console.log(`\n💡 Записи за 1-9 апреля находятся на страницах 2, 3, 4...`);
    console.log(`Нужно прокрутить вниз или перейти на следующую страницу!`);

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

test();
