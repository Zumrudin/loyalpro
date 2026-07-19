// ── NAV ────────────────────────────────────────────────────────

function nav(el) { navTo(el.dataset.p); }

// Переход на страницу по ключу (без привязки к пункту меню) — позволяет открывать
// под-страницы, у которых нет своего .tn (напр. генератор справки внутри «Справок»).
function navTo(p) {
  closeMenu();                         // закрыть drawer, если переход был из него
  document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
  // Генератор справки — под-страница раздела «Справки»: держим его пункт активным.
  const highlight = (p === 'medical-cert') ? 'cert-requests' : p;
  // подсветить пункт в ОБОИХ меню (верхнее + drawer)
  document.querySelectorAll('.tn[data-p="' + highlight + '"]').forEach(n => n.classList.add('active'));
  document.querySelectorAll('.page').forEach(x => {
    x.classList.remove('active', 'page-enter');
  });
  const page = document.getElementById('page-' + p);
  if (page) {
    page.classList.add('active');
    void page.offsetWidth; // force reflow
    page.classList.add('page-enter');
  }
  if (p === 'clients')         loadClients();
  if (p === 'records')         { setDefDates(); loadRecords(1); }
  if (p === 'staff-analytics') loadStaffAnalytics();
  if (p === 'segments')        loadSegments();
  if (p === 'broadcasts')      loadBroadcasts();
  if (p === 'chat')            loadChat();
  if (p === 'home-care')       loadHomeCare();
  if (p === 'patient-portfolio') loadPatientPortfolio();
  if (p === 'staff-dashboard') loadStaffDashboard();
  if (p === 'settings')        loadSettings();
  if (p === 'users')           loadUsers();
  if (p === 'medical-cert')    loadMedicalCert();
  if (p === 'cert-requests')  loadCertRequests();
  if (p === 'knowledge-base') loadKnowledgeBase();
  if (p === 'agent-services') loadAgentServices();
}

// ── ROLE-BASED NAV ──
function applyRoleNav(role) {
  // покрываем оба набора пунктов: десктопное меню (#mainNav) и мобильный drawer (#mnavList)
  const navItems = document.querySelectorAll('#mainNav .tn, #mnavList .tn');
  navItems.forEach(item => {
    const roles = (item.dataset.roles || '').split(',').map(r => r.trim());
    item.style.display = roles.includes(role) ? '' : 'none';
    item.classList.remove('active');
  });
  // стартовая страница — первый видимый пункт десктопного меню (#mainNav всегда в DOM)
  const firstMain = Array.from(document.querySelectorAll('#mainNav .tn'))
    .find(n => n.style.display !== 'none');
  // подсветить стартовую страницу в обоих меню
  if (firstMain) document.querySelectorAll('.tn[data-p="' + firstMain.dataset.p + '"]').forEach(n => n.classList.add('active'));
  return firstMain?.dataset?.p || 'home-care';
}

// ── SETTINGS SIDEBAR NAV ──
function navStg(id, el) {
  document.querySelectorAll('.stg-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.stg-section').forEach(e => e.classList.remove('active'));
  const sec = document.getElementById('stg-' + id);
  if (sec) sec.classList.add('active');
  if (id === 'loyalty-services') loadSvcCb();
  if (id === 'loyalty-birthday') loadBdList();
  if (id === 'sync-logs') loadSyncLogs();
  if (id === 'app-settings') loadAppSettings();
  if (id === 'staff-profiles') loadStaffProfiles();
}

// ── LAUNCH APP ──
async function launchApp() {
  if (!ME) {
    try { ME = await api('GET', '/api/auth/me'); } catch { showLogin(); return; }
  }
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('topAv').textContent  = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('topName').textContent = ME.name || ME.email;

  // шапка мобильного drawer
  const ROLE_LBL = { owner: 'Владелец', admin: 'Администратор', specialist: 'Специалист' };
  document.getElementById('mnavAv').textContent   = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('mnavName').textContent = ME.name || ME.email;
  document.getElementById('mnavRole').textContent = ROLE_LBL[ME.role] || ME.role || '';

  if (ME.must_change_password) {
    document.getElementById('changePwScreen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return;
  }

  document.getElementById('app').style.display = 'flex';

  const startPage = applyRoleNav(ME.role);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + startPage)?.classList.add('active');

  if (startPage === 'dashboard') { loadDashboard(); loadLs(); }
  else if (startPage === 'staff-dashboard') { loadStaffDashboard(); }
  else if (startPage === 'home-care') { loadHomeCare(); }
  else { loadDashboard(); loadLs(); }
}

function showLogin() {
  localStorage.removeItem('lp_tk');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ── MOBILE DRAWER ──
function openMenu() {
  document.getElementById('mnavOv')?.classList.add('open');
  document.getElementById('mnavDrawer')?.classList.add('open');
}
function closeMenu() {
  document.getElementById('mnavOv')?.classList.remove('open');
  document.getElementById('mnavDrawer')?.classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
