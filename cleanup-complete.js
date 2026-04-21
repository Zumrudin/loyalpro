require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function cleanup() {
  try {
    console.log('🧹 Полная очистка дубликатов...\n');

    // 1. Clear sync_logs referencing old users
    console.log('Шаг 1: Очистка зависимых sync_logs...');
    const logs = await pool.query('DELETE FROM sync_logs WHERE initiated_by IN (1,3)');
    console.log(`✅ Удалено ${logs.rowCount} записей логов`);

    // 2. Fix created_by references
    console.log('Шаг 2: Переназначение creator...');
    const fix = await pool.query('UPDATE users SET created_by=4 WHERE created_by IN (1,3)');
    console.log(`✅ Обновлено ${fix.rowCount} записей`);

    // 3. Delete old users
    console.log('Шаг 3: Удаление старых дубликатов...');
    const del = await pool.query('DELETE FROM users WHERE id IN (1,3)');
    console.log(`✅ Удалено ${del.rowCount} дубликатов`);

    // 4. Clear stale Company ID
    console.log('Шаг 4: Очистка Salon 1...');
    await pool.query("UPDATE salons SET yclients_company_id=NULL WHERE id=1");
    console.log(`✅ Company ID очищен`);

    // Verification
    console.log('\n✨ ГОТОВО!\n');
    const users = await pool.query(
      'SELECT id, email, salon_id FROM users WHERE email=$1',
      ['zizy05zizy@mail.ru']
    );
    console.log('Ваш профиль:');
    if (users.rows.length > 0) {
      const u = users.rows[0];
      console.log(`  ✅ User ID=${u.id}, Email=${u.email}, Salon ID=${u.salon_id}`);
    }

    const s = await pool.query("SELECT name, yclients_company_id FROM salons WHERE id=1");
    if (s.rows.length > 0) {
      console.log(`\nSalon 1 (${s.rows[0].name}):`);
      console.log(`  Company ID: ${s.rows[0].yclients_company_id || 'NULL ✅'}`);
    }

    console.log('\n🔗 Теперь можно переподключиться в приложении!');

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

cleanup();
