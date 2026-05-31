// ── NAV ────────────────────────────────────────────────────────

function nav(el) {
  document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  const p = el.dataset.p;
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
  if (p === 'home-care')       loadHomeCare();
  if (p === 'patient-portfolio') loadPatientPortfolio();
  if (p === 'settings')        loadSettings();
  if (p === 'users')           loadUsers();
}

// ── ROLE-BASED NAV ──
function applyRoleNav(role) {
  const navItems = document.querySelectorAll('#mainNav .tn');
  let firstVisible = null;
  navItems.forEach(item => {
    const roles = (item.dataset.roles || '').split(',').map(r => r.trim());
    if (roles.includes(role)) {
      item.style.display = '';
      if (!firstVisible) firstVisible = item;
    } else {
      item.style.display = 'none';
    }
  });
  navItems.forEach(n => n.classList.remove('active'));
  if (firstVisible) firstVisible.classList.add('active');
  return firstVisible?.dataset?.p || 'home-care';
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
