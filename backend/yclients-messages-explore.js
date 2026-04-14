/**
 * YClients API Messages/Chat Exploration Script
 *
 * Цель: протестировать, какие данные о сообщениях доступны в YClients API
 *
 * Использование:
 * 1. Установите переменные окружения для YClients (см. ниже)
 * 2. node yclients-messages-explore.js
 */

const axios = require('axios');
require('dotenv').config(); // если используете .env файл

// ────────────────────────────────────────────────────────────────────────────
// КОНФИГУРАЦИЯ
// ────────────────────────────────────────────────────────────────────────────

const YC_API = 'https://api.yclients.com/api/v1';

// Получите токены из переменных окружения или напрямую
const CONFIG = {
  partner_token: process.env.YCLIENTS_PARTNER_TOKEN || 'YOUR_PARTNER_TOKEN_HERE',
  user_token: process.env.YCLIENTS_USER_TOKEN || 'YOUR_USER_TOKEN_HERE',
  company_id: process.env.YCLIENTS_COMPANY_ID || 'YOUR_COMPANY_ID_HERE',
};

// ────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ────────────────────────────────────────────────────────────────────────────

function ycHeaders() {
  return {
    'Accept': 'application/vnd.yclients.v2+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${CONFIG.partner_token}, User ${CONFIG.user_token}`,
  };
}

async function ycGet(endpoint, params = {}) {
  const url = new URL(`${YC_API}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log(`\n📡 GET ${endpoint}`, Object.keys(params).length ? `(params: ${JSON.stringify(params)})` : '');

  try {
    const { data } = await axios.get(url.toString(), {
      headers: ycHeaders(),
      timeout: 15000
    });

    if (!data.success) {
      console.error(`❌ API Error: ${data.meta?.message || 'Unknown error'}`);
      return null;
    }

    console.log(`✅ Success! Data type: ${Array.isArray(data.data) ? 'Array' : typeof data.data}`);
    if (Array.isArray(data.data)) {
      console.log(`   Items: ${data.data.length}`);
      if (data.data.length > 0) {
        console.log('   Sample keys:', Object.keys(data.data[0]).slice(0, 10).join(', '));
        console.log('   Full sample:', JSON.stringify(data.data[0], null, 2).slice(0, 500));
      }
    }

    return data.data;
  } catch (e) {
    console.error(`❌ Request Error: ${e.message}`);
    if (e.response?.status === 401) {
      console.error('   → Проблема с аутентификацией. Проверьте токены.');
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ОСНОВНЫЕ ТЕСТЫ
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 YClients Messages API Exploration\n');
  console.log('Config:', {
    company_id: CONFIG.company_id,
    partner_token: CONFIG.partner_token.slice(0, 10) + '***',
    user_token: CONFIG.user_token.slice(0, 10) + '***',
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. КЛИЕНТ И ЕГО ИНФОРМАЦИЯ
  // ──────────────────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('🔹 ПОЛУЧЕНИЕ ИНФОРМАЦИИ О КЛИЕНТАХ (для дальнейших тестов)');
  console.log('═══════════════════════════════════════════════════════════════');

  const clients = await ycGet(`/company/${CONFIG.company_id}/clients/search`, {
    count: 5,
    page: 1,
  });

  let testClientYcId = null;
  if (clients && clients.length > 0) {
    testClientYcId = clients[0].id;
    console.log(`\n→ Тестовый клиент (для дальнейших тестов): ${testClientYcId}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. ИНФОРМАЦИЯ О КЛИЕНТЕ (детали)
  // ──────────────────────────────────────────────────────────────────────────

  if (testClientYcId) {
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('🔹 ДЕТАЛИ КЛИЕНТА (может содержать контакты мессенджеров)');
    console.log('═══════════════════════════════════════════════════════════════');

    await ycGet(`/client/${CONFIG.company_id}/${testClientYcId}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. ВОЗМОЖНЫЕ ENDPOINTS ДЛЯ СООБЩЕНИЙ
  // ──────────────────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('🔹 ТЕСТИРОВАНИЕ ПРЕДПОЛАГАЕМЫХ ENDPOINTS ДЛЯ СООБЩЕНИЙ');
  console.log('═══════════════════════════════════════════════════════════════');

  const possibleEndpoints = [
    // Сообщения на уровне компании
    `/company/${CONFIG.company_id}/messages`,
    `/messages`,
    `/company/${CONFIG.company_id}/chats`,
    `/chats`,

    // Сообщения для конкретного клиента
    testClientYcId ? `/client/${CONFIG.company_id}/${testClientYcId}/messages` : null,
    testClientYcId ? `/client/${CONFIG.company_id}/${testClientYcId}/chats` : null,
    testClientYcId ? `/messages/client/${testClientYcId}` : null,
    testClientYcId ? `/conversations/${testClientYcId}` : null,

    // Мессенджеры
    `/messengers`,
    `/company/${CONFIG.company_id}/messengers`,

    // Телеграм специально
    `/telegram`,
    `/integrations/telegram`,
  ];

  const results = [];
  for (const endpoint of possibleEndpoints) {
    if (!endpoint) continue;
    const result = await ycGet(endpoint);
    results.push({
      endpoint,
      hasData: !!result,
      type: Array.isArray(result) ? 'array' : typeof result,
    });
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. СВОДКА РЕЗУЛЬТАТОВ
  // ──────────────────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('📊 СВОДКА РЕЗУЛЬТАТОВ');
  console.log('═══════════════════════════════════════════════════════════════');

  const working = results.filter(r => r.hasData);
  const broken = results.filter(r => !r.hasData);

  if (working.length > 0) {
    console.log('\n✅ Работающие endpoints:');
    working.forEach(r => console.log(`   • ${r.endpoint} (${r.type})`));
  }

  if (broken.length > 0) {
    console.log('\n❌ Неработающие endpoints:');
    broken.forEach(r => console.log(`   • ${r.endpoint}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. ИНФОРМАЦИЯ ЗАПИСЕЙ (могут содержать сообщения)
  // ──────────────────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('🔹 ПРОВЕРКА ЗАПИСЕЙ (могут содержать поля с сообщениями)');
  console.log('═══════════════════════════════════════════════════════════════');

  const records = await ycGet(`/records/${CONFIG.company_id}`, {
    page: 1,
    count: 5,
  });

  if (records && records.length > 0) {
    console.log('\n📋 Поля записи (запись содержит эти данные):');
    const allKeys = new Set();
    records.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
    Array.from(allKeys).sort().forEach(k => console.log(`   • ${k}`));

    const sampleRecord = records[0];
    console.log('\n📝 Пример записи:');
    console.log(JSON.stringify(sampleRecord, null, 2).slice(0, 1000));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. ЗАКЛЮЧЕНИЕ И РЕКОМЕНДАЦИИ
  // ──────────────────────────────────────────────────────────────────────────

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('📝 ЗАКЛЮЧЕНИЕ И РЕКОМЕНДАЦИИ');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log(`
Что мы узнали:
1. Работающие endpoints для сообщений: ${working.length > 0 ? '✅ Есть!' : '❌ Нет стандартных'}
2. Информация в клиентах может содержать контакты мессенджеров
3. Записи могут содержать связанные данные

Следующие шаги:
1. Проверить документацию YClients для деталей о структуре сообщений
2. Если API сообщений отсутствует, рассмотреть:
   - Webhook интеграцию для получения сообщений
   - Парсинг веб-интерфейса (как для транзакций)
   - Интеграцию с мессенджерами напрямую (Telegram Bot API, WhatsApp API и т.д.)
  `);
}

// ────────────────────────────────────────────────────────────────────────────

main().catch(e => {
  console.error('\n💥 Критическая ошибка:', e.message);
  process.exit(1);
});
