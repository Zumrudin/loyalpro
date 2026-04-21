require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function cleanup() {
  try {
    console.log('🧹 Очистка дубликатов...\n');

    // 1. Удалить старый аккаунт в Salon 1
    console.log('Шаг 1: Удаление User ID=1 из Salon 1...');
    const del1 = await pool.query('DELETE FROM users WHERE id=1');
    console.log(`✅ Удалено ${del1.rowCount} строк`);

    // 2. Удалить дубликат в Salon 2
    console.log('\nШаг 2: Удаление User ID=3 из Salon 2...');
    const del2 = await pool.query('DELETE FROM users WHERE id=3');
    console.log(`✅ Удалено ${del2.rowCount} строк`);

    // 3. Очистить Company ID в Salon 1
    console.log('\nШаг 3: Очистка Company ID в Salon 1...');
    const clear = await pool.query(
      "UPDATE salons SET yclients_company_id=NULL WHERE id=1"
    );
    console.log(`✅ Обновлено ${clear.rowCount} строк`);

    // Проверка
    console.log('\n✨ ИТОГОВОЕ СОСТОЯНИЕ:\n');
    const check1 = await pool.query(
      'SELECT id, email, salon_id FROM users WHERE email=$1',
      ['zizy05zizy@mail.ru']
    );
    console.log('Пользователи с email zizy05zizy@mail.ru:');
    check1.rows.forEach(row => {
      console.log(`  ✅ User ID=${row.id}, Salon ID=${row.salon_id}`);
    });

    const check2 = await pool.query(
      "SELECT id, name, yclients_company_id FROM salons WHERE id IN (1,2,3)"
    );
    console.log('\nСалоны:');
    check2.rows.forEach(row => {
      console.log(`  Salon ${row.id}: ${row.name}, CompanyID=${row.yclients_company_id || 'NULL'}`);
    });

    console.log('\n✅ Готово! Теперь можете переподключиться.');

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

cleanup();
