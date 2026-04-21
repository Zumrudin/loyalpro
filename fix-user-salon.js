require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function fix() {
  try {
    console.log('🔧 Переназначение профиля на правильный салон...\n');

    // Переназначить пользователя на правильный салон
    const result = await pool.query(
      'UPDATE users SET salon_id=1 WHERE email=$1 RETURNING id, email, salon_id',
      ['zizy05zizy@mail.ru']
    );

    if (result.rowCount === 0) {
      console.log('❌ Пользователь не найден');
      await pool.end();
      process.exit(1);
    }

    console.log('✅ Профиль переназначен!');
    const user = result.rows[0];
    console.log(`   Email: ${user.email}`);
    console.log(`   Новый Salon ID: ${user.salon_id}`);

    // Проверить что теперь видим
    console.log('\nПроверка:');
    const check = await pool.query(
      'SELECT u.email, s.id, s.name, s.yclients_company_id FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      ['zizy05zizy@mail.ru']
    );
    if (check.rows.length > 0) {
      const row = check.rows[0];
      console.log(`✅ Салон: ${row.name} (ID=${row.id})`);
      console.log(`✅ Company ID: ${row.yclients_company_id || 'пусто (нужно переподключить)'}`);
    }

    await pool.end();
    console.log('\n✨ Теперь вы можете переподключиться к YClients!');
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

fix();
