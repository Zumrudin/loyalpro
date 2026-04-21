/**
 * СКРИПТ ВОССТАНОВЛЕНИЯ ТОКЕНОВ YCLIENTS
 *
 * Используйте этот скрипт если:
 * - Токены не сохраняются через интерфейс
 * - Нужно прямо обновить данные в БД
 *
 * Использование:
 * node restore-yclients.js <email> <partnerToken> <userToken> <companyId>
 */

require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);

if (args.length < 4) {
  console.log(`
❌ Ошибка: Недостаточно аргументов

✅ Использование:
  node restore-yclients.js <email> <partnerToken> <userToken> <companyId>

📝 Примеры:
  node restore-yclients.js zizy05zizy@mail.ru "sk_live_..." "sU1234567890" 668791

🔍 Где получить эти данные:
  - email: ваш логин в loyalpro
  - partnerToken: из настроек API в Yclients
  - userToken: из профиля Yclients (обычно можно скопировать из браузера)
  - companyId: ID компании в Yclients
  `);
  process.exit(1);
}

const [email, partnerToken, userToken, companyId] = args;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function restoreYClients() {
  const client = await pool.connect();
  try {
    console.log('📊 Параметры восстановления:');
    console.log(`  Email: ${email}`);
    console.log(`  Partner Token: ${partnerToken.slice(0, 20)}...`);
    console.log(`  User Token: ${userToken.slice(0, 20)}...`);
    console.log(`  Company ID: ${companyId}\n`);

    // 1. Найти пользователя по email
    console.log('🔍 Шаг 1: Поиск профиля пользователя...');
    const userRes = await client.query(
      'SELECT u.id, u.salon_id, s.name FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.email=$1',
      [email.toLowerCase().trim()]
    );

    if (!userRes.rows[0]) {
      throw new Error(`❌ Пользователь с email ${email} не найден`);
    }

    const { salon_id, name } = userRes.rows[0];
    console.log(`✅ Найден пользователь: ${email}`);
    console.log(`   Салон: ${name} (ID: ${salon_id})\n`);

    // 2. Обновить токены в таблице salons
    console.log('🔐 Шаг 2: Сохранение токенов в БД...');
    const updateRes = await client.query(
      `UPDATE salons
       SET yclients_partner_token=$1,
           yclients_user_token=$2,
           yclients_company_id=$3,
           updated_at=NOW()
       WHERE id=$4
       RETURNING *`,
      [partnerToken, userToken, companyId, salon_id]
    );

    if (updateRes.rows.length === 0) {
      throw new Error('❌ Не удалось обновить данные салона');
    }

    const salon = updateRes.rows[0];
    console.log(`✅ Токены успешно сохранены!`);
    console.log(`   Partner Token: ${salon.yclients_partner_token?.slice(0, 20)}...`);
    console.log(`   User Token: ${salon.yclients_user_token?.slice(0, 20)}...`);
    console.log(`   Company ID: ${salon.yclients_company_id}\n`);

    // 3. Проверка
    console.log('✅ ВОССТАНОВЛЕНИЕ ЗАВЕРШЕНО!');
    console.log(`\n📌 Далее:
  1. Откройте приложение http://89.125.92.223:3001/
  2. Перейдите в Настройки → Интеграция → Синхронизация
  3. Нажмите кнопку "Синхронизировать"
  4. Данные должны загрузиться с Yclients
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n❌ ОШИБКА: ${e.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

restoreYClients().catch(console.error);
