require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function cleanup() {
  try {
    console.log('🧹 Безопасная очистка дубликатов...\n');

    // 1. Fix foreign key: reassign User 2's creator from User 1 to User 4
    console.log('Шаг 1: Переназначение creator для зависимых записей...');
    const fix = await pool.query(
      'UPDATE users SET created_by=4 WHERE created_by IN (1,3)'
    );
    console.log(`✅ Обновлено ${fix.rowCount} записей`);

    // 2. Delete old users
    console.log('\nШаг 2: Удаление старых дубликатов...');
    const del = await pool.query('DELETE FROM users WHERE id IN (1,3)');
    console.log(`✅ Удалено ${del.rowCount} старых записей`);

    // 3. Clear stale Company ID
    console.log('\nШаг 3: Очистка Salon 1...');
    const clear = await pool.query(
      "UPDATE salons SET yclients_company_id=NULL WHERE id=1"
    );
    console.log(`✅ Company ID очищен`);

    // Verification
    console.log('\n✨ ИТОГОВОЕ СОСТОЯНИЕ:\n');
    const users = await pool.query(
      'SELECT id, email, salon_id FROM users WHERE email=$1',
      ['zizy05zizy@mail.ru']
    );
    console.log('Ваш профиль:');
    if (users.rows.length > 0) {
      const u = users.rows[0];
      console.log(`  ✅ User ID=${u.id}, Email=${u.email}, Salon ID=${u.salon_id}`);
    }

    const salons = await pool.query(
      "SELECT id, name, yclients_company_id FROM salons WHERE id=1"
    );
    console.log('\nSalon 1 (PERI CLINIC):');
    if (salons.rows.length > 0) {
      const s = salons.rows[0];
      console.log(`  Name: ${s.name}`);
      console.log(`  Company ID: ${s.yclients_company_id || '❌ NULL (готово для переподключения)'}`);
    }

    console.log('\n✅ Очистка завершена! Теперь вы можете переподключиться.\n');

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

cleanup();
