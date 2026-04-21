require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('🔍 Проверка дублей Company ID 668791...\n');

    // Какие салоны имеют этот Company ID
    const res1 = await pool.query(
      "SELECT id, name, yclients_company_id FROM salons WHERE yclients_company_id = '668791'"
    );
    console.log('Салоны с Company ID 668791:');
    console.log(res1.rows.length === 0 ? '  ❌ Нет' : '');
    res1.rows.forEach((row, i) => {
      console.log(`  ${i+1}. ID=${row.id}, Название="${row.name}"`);
    });

    // Кто владелец профиля zizy05zizy@mail.ru
    console.log('\nПрофиль zizy05zizy@mail.ru:');
    const res2 = await pool.query(
      'SELECT u.id, u.email, u.salon_id, s.id as s_id, s.name, s.yclients_company_id FROM users u LEFT JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      ['zizy05zizy@mail.ru']
    );
    if (res2.rows.length === 0) {
      console.log('  ❌ Пользователь не найден');
    } else {
      const user = res2.rows[0];
      console.log(`  Email: ${user.email}`);
      console.log(`  Salon ID: ${user.salon_id}`);
      console.log(`  Salon Name: ${user.name}`);
      console.log(`  Current Company ID: ${user.yclients_company_id || 'NULL'}`);
    }

    console.log('\nВСЕ салоны в БД:');
    const res3 = await pool.query('SELECT id, name, yclients_company_id FROM salons LIMIT 20');
    res3.rows.forEach((row, i) => {
      console.log(`  ${i+1}. ID=${row.id}, Name="${row.name}", CompanyID=${row.yclients_company_id || 'NULL'}`);
    });

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
