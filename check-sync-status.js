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
        id, salon_id, status, started_at, finished_at, error_message
      FROM sync_logs 
      WHERE salon_id=1 
      ORDER BY started_at DESC 
      LIMIT 5
    `);

    console.log('Последние попытки синхронизации:\n');
    if (sync.rows.length === 0) {
      console.log('  ❌ Синхронизация не запускалась');
    } else {
      sync.rows.forEach((row, i) => {
        const status = row.status === 'success' ? '✅' : row.status === 'running' ? '🔄' : '❌';
        console.log(`${i+1}. ${status} Статус: ${row.status}`);
        console.log(`   Начало: ${row.started_at}`);
        if (row.finished_at) {
          const duration = new Date(row.finished_at) - new Date(row.started_at);
          console.log(`   Длительность: ${(duration/1000).toFixed(1)}s`);
        }
        if (row.error_message) {
          console.log(`   ❌ Ошибка: ${row.error_message}`);
        }
        console.log('');
      });
    }

    // Что загружено
    console.log('📈 Загруженные данные для salon_id=1:\n');
    
    const tables = [
      { name: 'loyalty_cards', label: 'Карты лояльности' },
      { name: 'loyalty_transactions', label: 'Операции карт' },
      { name: 'loyalty_card_statuses', label: 'Статусы карт' },
      { name: 'services', label: 'Услуги' },
      { name: 'staff', label: 'Сотрудники' }
    ];

    for (const table of tables) {
      try {
        const result = await pool.query(
          `SELECT COUNT(*) as count FROM ${table} WHERE salon_id=1`
        );
        console.log(`  ${table.label}: ${result.rows[0].count} 📝`);
      } catch(e) {
        console.log(`  ${table.label}: ❌ (нет данных)`);
      }
    }

    await pool.end();
  } catch(e) {
    console.error('❌ Ошибка:', e.message);
    process.exit(1);
  }
}

check();
