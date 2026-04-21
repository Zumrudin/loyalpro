require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function check() {
  try {
    console.log('📊 СТАТУС СИНХРОНИЗАЦИИ\n');

    // Последняя синхронизация
    const sync = await pool.query(`
      SELECT 
        id, salon_id, status, started_at, finished_at,
        EXTRACT(EPOCH FROM (finished_at - started_at))::int as duration_sec,
        records_processed, error_message
      FROM sync_logs 
      WHERE salon_id=1 
      ORDER BY started_at DESC 
      LIMIT 5
    `);

    console.log('Последние попытки синхронизации:\n');
    sync.rows.forEach((row, i) => {
      const status = row.status === 'success' ? '✅' : row.status === 'running' ? '🔄' : '❌';
      console.log(`${i+1}. ${status} Статус: ${row.status}`);
      console.log(`   Начало: ${row.started_at}`);
      if (row.finished_at) {
        console.log(`   Окончание: ${row.finished_at}`);
        console.log(`   Длительность: ${row.duration_sec}s`);
      }
      console.log(`   Обработано записей: ${row.records_processed || 0}`);
      if (row.error_message) {
        console.log(`   ❌ Ошибка: ${row.error_message}`);
      }
      console.log('');
    });

    // Что загружено
    console.log('📈 Загруженные данные для salon_id=1:\n');
    
    const tables = [
      'loyalty_cards',
      'loyalty_transactions',
      'loyalty_card_statuses',
      'services',
      'staff'
    ];

    for (const table of tables) {
      try {
        const result = await pool.query(
          `SELECT COUNT(*) as count FROM ${table} WHERE salon_id=1`
        );
        console.log(`  ${table}: ${result.rows[0].count} записей`);
      } catch(e) {
        console.log(`  ${table}: ❌ таблица не существует или ошибка`);
      }
    }

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
