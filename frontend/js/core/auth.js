// ── AUTH ───────────────────────────────────────────────────────

let ME = null;

// ── AUTH TAB SWITCH ──
function switchAuthTab(tab) {
  document.getElementById('formLogin').style.display    = tab === 'login'    ? 'block' : 'none';
  document.getElementById('formRegister').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('tabLoginBtn').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegBtn').classList.toggle('active',   tab === 'register');
}

// ── LOGIN ──
async function doLogin() {
  const email = document.getElementById('lEmail').value.trim();
  const password = document.getElementById('lPass').value;
  const errEl = document.getElementById('loginErr');
  const btn = document.getElementById('loginBtn');
  errEl.style.display = 'none';
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Входим...';
  try {
    const d = await api('POST', '/api/auth/login', { email, password });
    TOKEN = d.token; ME = d.user;
    localStorage.setItem('lp_tk', TOKEN);
    launchApp();
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'Войти в личный кабинет'; }
}

// ── REGISTER ──
async function doRegister() {
  const salonName = document.getElementById('rSalon').value.trim();
  const city      = document.getElementById('rCity').value.trim();
  const email     = document.getElementById('rEmail').value.trim();
  const password  = document.getElementById('rPass').value;
  const errEl = document.getElementById('regErr');
  const btn = document.getElementById('regBtn');
  errEl.style.display = 'none';
  if (!salonName || !email || !password) { errEl.textContent = 'Заполните все обязательные поля'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Пароль минимум 6 символов'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const d = await api('POST', '/api/auth/register', { salonName, city, email, password });
    TOKEN = d.token; ME = d.user;
    localStorage.setItem('lp_tk', TOKEN);
    launchApp();
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'Создать аккаунт'; }
}

// ── LOGOUT ──
async function doLogout() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  localStorage.removeItem('lp_tk');
  location.reload();
}

// ── CHANGE PASSWORD ──
async function doChangePw() {
  const np = document.getElementById('cpNew').value;
  const np2 = document.getElementById('cpNew2').value;
  const err = document.getElementById('cpErr');
  const btn = document.getElementById('cpBtn');
  err.style.display = 'none';
  if (np !== np2) { err.textContent = 'Пароли не совпадают'; err.style.display = 'block'; return; }
  if (np.length < 6) { err.textContent = 'Пароль минимум 6 символов'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('POST', '/api/auth/change-password', { new_password: np });
    document.getElementById('changePwScreen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    applyRoleNav(ME.role);
    loadDashboard(); loadLs();
  } catch(e) {
    err.textContent = e.message; err.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'Сохранить пароль и войти'; }
}
