// Интеграционный тест для проверки исправления ошибки авторизации

const http = require('http');

// Исправленная функция api() из фронта
let TOKEN = null;
const API = 'http://localhost:3001';

async function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (TOKEN) {
      options.headers['Authorization'] = 'Bearer ' + TOKEN;
    }

    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`   Response status: ${res.statusCode}`);
        
        // Проверяем статус перед парсингом JSON
        if (res.statusCode >= 400) {
          try {
            const j = JSON.parse(data);
            reject(new Error(j.error || `HTTP ${res.statusCode}`));
          } catch (e) {
            // Если сервер вернул HTML вместо JSON
            if (e instanceof SyntaxError) {
              reject(new Error(`Server error (HTTP ${res.statusCode}): Response is not JSON`));
            }
            reject(e);
          }
        } else {
          try {
            const j = JSON.parse(data);
            resolve(j);
          } catch (e) {
            reject(new Error(`Failed to parse response as JSON: ${e.message}`));
          }
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Тесты
async function runTests() {
  console.log('\n🧪 ИНТЕГРАЦИОННЫЙ ТЕСТ АВТОРИЗАЦИИ\n');
  console.log('═'.repeat(60));

  let passed = 0;
  let failed = 0;

  // Тест 1: Попытка логина с неверными учётными данными
  console.log('\n✓ ТЕСТ 1: Неверные учётные данные');
  console.log('  Ожидаемый результат: Ошибка 401 с сообщением об ошибке');
  try {
    await api('POST', '/api/auth/login', { 
      email: 'nonexistent@test.com', 
      password: 'wrongpassword' 
    });
    console.log('  ❌ FAILED: Ошибка не была выброшена');
    failed++;
  } catch (e) {
    if (e.message.includes('Неверный')) {
      console.log(`  ✅ PASSED: ${e.message}`);
      passed++;
    } else {
      console.log(`  ❌ FAILED: ${e.message}`);
      failed++;
    }
  }

  // Тест 2: Пустые поля
  console.log('\n✓ ТЕСТ 2: Пустые email и пароль');
  console.log('  Ожидаемый результат: Ошибка валидации');
  try {
    await api('POST', '/api/auth/login', { 
      email: '', 
      password: '' 
    });
    console.log('  ❌ FAILED: Ошибка не была выброшена');
    failed++;
  } catch (e) {
    if (e.message.includes('Укажите')) {
      console.log(`  ✅ PASSED: ${e.message}`);
      passed++;
    } else {
      console.log(`  ❌ FAILED: ${e.message}`);
      failed++;
    }
  }

  // Тест 3: Зарегистрируемся, а потом логинимся
  console.log('\n✓ ТЕСТ 3: Регистрация и логин новго пользователя');
  const timestamp = Date.now();
  const testEmail = `test-${timestamp}@loyalpro.test`;
  const testPassword = 'TestPassword123';
  
  try {
    // Регистрируемся
    console.log('  - Регистрируемся...');
    const regData = await api('POST', '/api/auth/register', {
      salonName: `Test Salon ${timestamp}`,
      city: 'TestCity',
      email: testEmail,
      password: testPassword
    });
    
    if (regData.token && regData.user) {
      console.log(`  ✅ Регистрация успешна`);
      TOKEN = regData.token;
      
      // Логинимся с новыми учётными данными
      console.log('  - Логинимся с новыми учётными данными...');
      TOKEN = null; // Очищаем токен для свежего логина
      const loginData = await api('POST', '/api/auth/login', {
        email: testEmail,
        password: testPassword
      });
      
      if (loginData.token && loginData.user) {
        console.log(`  ✅ PASSED: Логин успешен. User: ${loginData.user.name}`);
        passed++;
      }
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}`);
    failed++;
  }

  // Резюме
  console.log('\n' + '═'.repeat(60));
  console.log(`\n📊 РЕЗУЛЬТАТЫ: ${passed} passed, ${failed} failed из ${passed + failed} тестов\n`);
  
  if (failed === 0) {
    console.log('🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ! Исправление ошибки успешно.');
  } else {
    console.log(`⚠️  ${failed} тест(ов) не пройдены.`);
  }
}

runTests().catch(console.error);
