/**
 * СКРИПТ ДИАГНОСТИКИ БАГИ СИНХРОНИЗАЦИИ
 * Проверяет какие токены сохранены в БД
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function diagnose() {
  try {
    console.log('🔍 ДИАГНОСТИКА ПРОБЛЕМЫ СИНХРОНИЗАЦИИ\n');
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ установлена' : '❌ не установлена');

    // Найти профиль пользователя
    console.log('\n📋 Поиск пользователя zizy05zizy@mail.ru...');
    const userRes = await pool.query(
      'SELECT u.id, u.email, u.salon_id, s.name FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      ['zizy05zizy@mail.ru']
    );

    if (userRes.rows.length === 0) {
      console.log('❌ Пользователь не найден');
      await pool.end();
      process.exit(1);
    }

    const { salon_id, name, email } = userRes.rows[0];
    console.log(`✅ Найден: ${email}`);
    console.log(`   Салон: ${name} (ID: ${salon_id})\n`);

    // Получить полные данные салона
    console.log('📊 Проверка данных салона в БД...\n');
    const salonRes = await pool.query(
      `SELECT
        id, name,
        yclients_company_id,
        yclients_partner_token,
        yclients_user_token,
        yclients_chain_id,
        is_active,
        updated_at
      FROM salons WHERE id=$1`,
      [salon_id]
    );

    if (salonRes.rows.length === 0) {
      console.log('❌ Салон не найден в БД');
      await pool.end();
      process.exit(1);
    }

    const salon = salonRes.rows[0];

    console.log(`📌 ID салона: ${salon.id}`);
    console.log(`📌 Название: ${salon.name}`);
    console.log(`📌 Активен: ${salon.is_active ? '✅ да' : '❌ нет'}`);
    console.log(`📌 Обновлён: ${salon.updated_at}`);

    console.log('\n🔑 ТОКЕНЫ:');
    console.log(`1️⃣  Company ID: ${salon.yclients_company_id ? '✅ ' + salon.yclients_company_id : '❌ NULL'}`);
    console.log(`2️⃣  Partner Token: ${salon.yclients_partner_token ? '✅ ' + salon.yclients_partner_token.slice(0, 20) + '...' : '❌ NULL'}`);
    console.log(`3️⃣  User Token: ${salon.yclients_user_token ? '✅ ' + salon.yclients_user_token.slice(0, 20) + '...' : '❌ NULL'}`);
    console.log(`4️⃣  Chain ID: ${salon.yclients_chain_id ? '✅ ' + salon.yclients_chain_id : '⚠️  не установлен'}`);

    console.log('\n🔍 АНАЛИЗ ПРОБЛЕМЫ:');

    const hasCompanyId = !!salon.yclients_company_id;
    const hasPartnerToken = !!salon.yclients_partner_token;
    const hasUserToken = !!salon.yclients_user_token;

    // Проверка требований синхронизации
    const isSyncReady = hasCompanyId && hasUserToken;

    console.log(`\nТребование синхронизации (Company ID + User Token):`);
    console.log(`  Company ID: ${hasCompanyId ? '✅' : '❌'}`);
    console.log(`  User Token: ${hasUserToken ? '✅' : '❌'}`);
    console.log(`  Статус: ${isSyncReady ? '✅ ГОТОВО К СИНХРОНИЗАЦИИ' : '❌ НЕ ГОТОВО'}`);

    // Проверка для API вызовов
    console.log(`\nТребование для API вызовов (Partner + User Token):`);
    console.log(`  Partner Token: ${hasPartnerToken ? '✅' : '❌'}`);
    console.log(`  User Token: ${hasUserToken ? '✅' : '❌'}`);
    console.log(`  Статус: ${hasPartnerToken && hasUserToken ? '✅ ГОТОВО К API ЗАПРОСАМ' : '❌ НЕ ГОТОВО'}`);

    // Рекомендации
    console.log('\n💡 РЕКОМЕНДАЦИИ:');
    if (!hasCompanyId) {
      console.log('❌ Company ID не сохранился - нужно переподключиться');
    }
    if (!hasUserToken) {
      console.log('❌ User Token не сохранился - это главная проблема!');
      console.log('   Возможные причины:');
      console.log('   - Ошибка при аутентификации в Yclients');
      console.log('   - Ошибка при сохранении в БД');
      console.log('   - Перезагрузка сервера вернула старые данные');
    }
    if (!hasPartnerToken) {
      console.log('⚠️  Partner Token не сохранился - потребуется для API запросов');
    }

    if (isSyncReady) {
      console.log('✅ Все данные сохранены - попробуйте:');
      console.log('   1. Перезагрузить страницу (F5)');
      console.log('   2. Нажать "Синхронизировать" снова');
      console.log('   3. Если не помогает - перезагрузить сервер');
    }

    console.log('\n');

  } catch (e) {
    console.error('❌ ОШИБКА:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

diagnose();
