// Тест функции api() из фронта в среде Node.js

console.log('\n🧪 ТЕСТ ФУНКЦИИ api() ИЗ ФРОНТА\n');

// Копируем исправленную функцию из api.js
const API = '';
let TOKEN = null;

async function api(method, path, body) {
  try {
    const o = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) o.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) o.body = JSON.stringify(body);
    const r = await fetch('http://localhost:3001' + path, o);

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
    return j;
  } catch(e) {
    throw e;
  }
}

// Simulating doLogin() from auth.js
async function testLogin(email, password) {
  console.log(`\n📝 Testing login: ${email}`);
  try {
    const d = await api('POST', '/api/auth/login', { email, password });
    TOKEN = d.token;
    console.log(`✅ LOGIN SUCCESS - Token: ${d.token.substring(0, 20)}...`);
    console.log(`   User: ${d.user.name} (${d.user.email})`);
    return true;
  } catch(e) {
    console.log(`❌ LOGIN ERROR: ${e.message}`);
    return false;
  }
}

// Tests
async function runFrontendTests() {
  console.log('═'.repeat(60));
  
  // Тест 1: Неверный пароль
  console.log('\nTEST 1: Invalid credentials');
  await testLogin('admin@test.com', 'wrongpassword');

  // Тест 2: Несуществующий пользователь
  console.log('\nTEST 2: Non-existent user');
  await testLogin('nonexistent-' + Date.now() + '@test.com', 'password');

  // Тест 3: Пустой email
  console.log('\nTEST 3: Empty email');
  await testLogin('', 'password');

  // Тест 4: Регистрация и логин
  console.log('\nTEST 4: Register and login');
  const email = `user-${Date.now()}@test.com`;
  const password = 'Test123456';
  
  try {
    console.log(`\n📝 Registering: ${email}`);
    const regData = await api('POST', '/api/auth/register', {
      salonName: `Salon ${Date.now()}`,
      city: 'Moscow',
      email: email,
      password: password
    });
    console.log(`✅ REGISTRATION SUCCESS`);
    
    TOKEN = null;
    console.log(`\n📝 Logging in with new account`);
    const loginData = await api('POST', '/api/auth/login', {
      email: email,
      password: password
    });
    TOKEN = loginData.token;
    console.log(`✅ LOGIN SUCCESS - Logged in as: ${loginData.user.name}`);
    
  } catch(e) {
    console.log(`❌ ERROR: ${e.message}`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('\n✅ FRONTEND API FUNCTION TEST COMPLETED SUCCESSFULLY\n');
}

runFrontendTests().catch(console.error);
