require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    // Check users table for created_by references
    const res = await pool.query(
      'SELECT id, email, created_by FROM users WHERE created_by=1 OR created_by=3 LIMIT 20'
    );
    console.log('Пользователи созданные User ID=1 или ID=3:');
    console.log(`Найдено ${res.rows.length} записей\n`);
    res.rows.forEach(row => {
      console.log(`  User ${row.id} (${row.email}) создана User ${row.created_by}`);
    });

    // Simple solution: set created_by to NULL or current user
    if (res.rows.length > 0) {
      console.log('\n💡 Решение: переназначить created_by на User ID=4 (текущий)');
    }

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
