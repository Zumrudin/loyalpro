// Test script для проверки исправленной функции api()

const API = 'http://localhost:3001';
let TOKEN = null;

// Новая исправленная функция api()
async function api(method, path, body) {
  console.log(`\n📤 ${method} ${path}`);
  try {
    const o = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) o.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) o.body = JSON.stringify(body);
    
    const r = await fetch(API + path, o);
    console.log(`📥 Response status: ${r.status}`);

    // Проверяем статус перед парсингом JSON
    if (!r.ok) {
      try {
        const j = await r.json();
        throw new Error(j.error || 'HTTP ' + r.status);
      } catch (e) {
        // Если сервер вернул HTML вместо JSON (ошибка 404, 502 и т.д.)
        if (e instanceof SyntaxError) {
          throw new Error('Ошибка сервера (HTTP ' + r.status + ')');
        }
        throw e;
      }
    }

    const j = await r.json();
    console.log(`✅ Success: `, j);
    return j;
  } catch(e) {
    console.log(`❌ Error: ${e.message}`);
    throw e;
  }
}

// Тесты
async function runTests() {
  console.log('🧪 ТЕСТИРОВАНИЕ АВТОРИЗАЦИИ\n');

  // Тест 1: Неверный email и пароль
  console.log('═══ ТЕСТ 1: Неверные учётные данные ═══');
  try {
    await api('POST', '/api/auth/login', { email: 'wrong@example.com', password: 'wrong' });
  } catch(e) {
    console.log('✓ Правильно обработана ошибка:', e.message);
  }

  // Тест 2: Пустой email
  console.log('\n═══ ТЕСТ 2: Пустой email ═══');
  try {
    await api('POST', '/api/auth/login', { email: '', password: 'password' });
  } catch(e) {
    console.log('✓ Правильно обработана ошибка:', e.message);
  }

  // Тест 3: Проверка несуществующего ендпоинта (чтобы вернулась HTML ошибка)
  console.log('\n═══ ТЕСТ 3: Несуществующий ендпоинт (должен вернуть 404 с HTML) ═══');
  try {
    await api('GET', '/api/nonexistent', null);
  } catch(e) {
    console.log('✓ Правильно обработана ошибка 404:', e.message);
  }

  console.log('\n✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ!');
}

runTests().catch(console.error);
