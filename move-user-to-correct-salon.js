require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function move() {
  try {
    console.log('🔄 Привязка учётки к филиалу PERI CLINIC...\n');

    // Проверка текущего состояния
    console.log('Текущее состояние:');
    const before = await pool.query(
      'SELECT u.id, u.email, u.salon_id, s.name, s.yclients_company_id FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      ['zizy05zizy@mail.ru']
    );
    if (before.rows.length > 0) {
      const row = before.rows[0];
      console.log(`  User ID: ${row.id}`);
      console.log(`  Email: ${row.email}`);
      console.log(`  Текущий филиал: "${row.name}" (ID=${row.salon_id})`);
      console.log(`  Company ID: ${row.yclients_company_id || 'NULL'}`);
    }

    // Перемещение пользователя в Salon 1
    console.log('\n🔗 Привязка к PERI CLINIC (Salon ID=1)...');
    const moveResult = await pool.query(
      'UPDATE users SET salon_id=1 WHERE email=$1 RETURNING id, email, salon_id',
      ['zizy05zizy@mail.ru']
    );

    if (moveResult.rowCount === 0) {
      console.log('❌ Пользователь не найден');
      await pool.end();
      process.exit(1);
    }

    console.log('✅ Учётка переместана!');

    // Проверка нового состояния
    console.log('\nНовое состояние:');
    const after = await pool.query(
      'SELECT u.id, u.email, u.salon_id, s.name, s.yclients_company_id FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      ['zizy05zizy@mail.ru']
    );
    if (after.rows.length > 0) {
      const row = after.rows[0];
      console.log(`  ✅ User ID: ${row.id}`);
      console.log(`  ✅ Email: ${row.email}`);
      console.log(`  ✅ Филиал: "${row.name}" (ID=${row.salon_id})`);
      console.log(`  ✅ Company ID: ${row.yclients_company_id}`);
    }

    console.log('\n✨ Готово! Ваша учётка теперь привязана к филиалу с историей!');
    console.log('💾 Все данные и история PERI CLINIC теперь доступны.');

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

move();
