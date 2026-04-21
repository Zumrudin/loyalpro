require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('🔍 Проверка дубликатов пользователя...\n');

    const res = await pool.query(
      'SELECT id, email, salon_id, created_at FROM users WHERE email=$1 ORDER BY salon_id',
      ['zizy05zizy@mail.ru']
    );

    console.log(`Найдено ${res.rows.length} пользователь(ей) с email zizy05zizy@mail.ru:\n`);
    res.rows.forEach((row, i) => {
      console.log(`${i+1}. User ID=${row.id}, Salon ID=${row.salon_id}, Created=${row.created_at}`);
    });

    console.log('\n📌 Салон 1 (PERI CLINIC) содержит старый/новый аккаунт');
    console.log('📌 Салон 3 (My Clinic) содержит текущий профиль');
    console.log('\n💡 Решение: Удалить старый дубликат в Salon 1, оставить в Salon 3');

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
