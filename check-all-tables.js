require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('🔍 ВСЕ ТАБЛИЦЫ В БД\n');

    // Все таблицы
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema='public'
      ORDER BY table_name
    `);

    console.log('Список таблиц:\n');
    for (const t of tables.rows) {
      const countRes = await pool.query(`SELECT COUNT(*) as count FROM ${t.table_name}`);
      const count = countRes.rows[0].count;
      console.log(`  📋 ${t.table_name}: ${count} записей`);
    }

    console.log('\n🎯 ТАБЛИЦЫ С ДАННЫМИ salon_id=1:\n');
    
    // Проверим какие таблицы имеют salon_id
    for (const t of tables.rows) {
      try {
        const hasColumn = await pool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name=$1 AND column_name='salon_id'
        `, [t.table_name]);

        if (hasColumn.rows.length > 0) {
          const countRes = await pool.query(
            `SELECT COUNT(*) as count FROM ${t.table_name} WHERE salon_id=1`
          );
          const count = countRes.rows[0].count;
          console.log(`  ✓ ${t.table_name}: ${count} записей`);
        }
      } catch(e) {
        // ignore
      }
    }

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
