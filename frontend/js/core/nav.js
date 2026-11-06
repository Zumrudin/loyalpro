// ── NAV ────────────────────────────────────────────────────────

// Текущая страница. Держим её ЗДЕСЬ, а не читаем из DOM: обработчик hashchange
// сравнивает с ней и по равенству понимает, что hash изменили мы сами (тогда
// повторный переход не нужен — иначе страница грузилась бы дважды на каждый клик).
let _navPage = null;

// Клик по пункту меню — всегда «в начало раздела»: hash перезаписывается РОВНО
// ключом страницы, без хвоста (открытый диалог чата закрывается).
function nav(el) {
  navTo(el.dataset.p, { reset: true });
  // Пункт-ярлык на раздел другой страницы («Лояльность» → Настройки › Уровни и
  // кэшбэк). Подсветку navTo ставит пункту БЕЗ data-stg — переносим её на ярлык.
  const stg = el.dataset.stg;
  if (stg) {
    if (typeof navStg === 'function') navStg(stg, document.querySelector('.stg-item[data-sec="' + stg + '"]'));
    document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tn[data-p="' + el.dataset.p + '"][data-stg="' + stg + '"]').forEach(n => n.classList.add('active'));
    _navAfterHighlight();
  }
}

// Крупный заголовок страницы (оформление Ivory & Brass). Где название пункта
// меню слишком короткое для заголовка — своя формулировка, как в макетах.
const NAV_PAGE_TITLES = {
  dashboard: 'Обзор клиники', 'staff-dashboard': 'Мои результаты', clients: 'Пациенты клиники',
  records: 'Записи', chat: 'Диалоги с пациентами', care: 'Продолжение заботы',
  economics: 'Экономика процедур', 'agent-services': 'Мила · услуги агента',
  'staff-analytics': 'Сотрудники', settings: 'Управление клиникой', edocs: 'Документы',
};
const NAV_ROLE_LBL = { owner: 'Владелец', admin: 'Администратор', specialist: 'Специалист', admin_cashier: 'Администратор-кассир' };
function _navPageTitle() {
  const t = document.getElementById('pgTitle');
  if (!t) return;
  const act = document.querySelector('#mainNav .tn.active');
  t.textContent = act?.dataset.stg ? act.textContent.trim()
    : (NAV_PAGE_TITLES[_navPage] || act?.textContent.trim() || '');
  const e = document.getElementById('pgEyebrow');
  const role = (typeof ME !== 'undefined' && ME) ? (NAV_ROLE_LBL[ME.role] || '') : '';
  if (e) e.textContent = [role, 'PERI CLINIC'].filter(Boolean).join(' · ');
}

// Группа меню (Развитие / Материалы / Управление) раскрывается кликом по заголовку.
function navGrpToggle(btn) {
  const grp = btn.closest('.nav-grp');
  if (!grp) return;
  const open = !grp.classList.contains('open');
  grp.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// После смены активного пункта: раскрыть его группу (в обоих меню) и обновить
// «хлебные крошки» в шапке. Свёрнутая группа с активным пунктом прятала бы,
// где человек находится.
function _navAfterHighlight() {
  document.querySelectorAll('.tn.active').forEach(n => {
    const grp = n.closest('.nav-grp');
    if (grp && !grp.classList.contains('open')) {
      grp.classList.add('open');
      grp.querySelector('.nav-grp-t')?.setAttribute('aria-expanded', 'true');
    }
  });
  _navPageTitle();
  const crumb = document.getElementById('tbCrumb');
  if (!crumb) return;
  const act = document.querySelector('#mainNav .tn.active');
  const grp = act?.closest('.nav-grp')?.querySelector('.nav-grp-t')?.textContent || '';
  const parts = ['PERI'];
  if (grp) parts.push(grp);
  if (act) parts.push(act.textContent.trim());
  if (_navPage === 'medical-cert') parts.push('Генератор справки');
  crumb.textContent = parts.join(' / ');
}

// Адрес страницы держим в location.hash. Без этого F5 (и «обновить» в мобильном
// браузере) выбрасывал на стартовую страницу роли — у владельца на Дашборд,
// сколько бы разделов человек ни прошёл.
// opts.reset    — перезаписать hash ключом страницы, стерев хвост (#chat/<ключ> → #chat)
// opts.keepHash — hash уже актуален (переход пришёл ИЗ hashchange), не трогать его
function _navSyncHash(p, opts) {
  if (opts.keepHash) return;
  const cur = (location.hash || '').slice(1);
  // Тот же раздел с хвостом (#chat/<ключ диалога>) — хвост сохраняем,
  // иначе careOpenChat() и deep-link теряли бы диалог сразу после перехода.
  if (!opts.reset && cur.split('/')[0] === p) return;
  if (cur === p) return;
  location.hash = p;                   // намеренно с записью в историю: работает «Назад»
}

// Доступна ли страница текущей роли. Нужно ИМЕННО для адреса: hash теперь
// переживает выход из аккаунта, и оставшийся от администратора «#users» открыл бы
// специалисту на том же телефоне чужой раздел (пустой — API отдаёт 403, но
// выглядит как сбой). Источник правды — уже отфильтрованное applyRoleNav меню.
function _navAllowed(p) {
  const key = (p === 'medical-cert') ? 'cert-requests' : p;   // под-страница «Справок»
  const item = document.querySelector('#mainNav .tn[data-p="' + key + '"]:not([data-stg])');
  return !!item && item.style.display !== 'none';
}

// Переход на страницу по ключу (без привязки к пункту меню) — позволяет открывать
// под-страницы, у которых нет своего .tn (напр. генератор справки внутри «Справок»).
function navTo(p, opts) {
  opts = opts || {};
  if (typeof vdStop === 'function') vdStop();
  if (typeof bcStopMonitor === 'function') bcStopMonitor();   // монитор рассылки живёт только на своей странице
  closeMenu();                         // закрыть drawer, если переход был из него
  // Живой опрос чата жив только на своей странице — гасим при любом переходе
  // (страница «Чат» перезапустит его через loadChat).
  if (typeof stopChatPolling === 'function') stopChatPolling();
  // Опрос статусов «Документов» жив только на своей странице.
  if (typeof edStopPolling === 'function') edStopPolling();
  document.querySelectorAll('.tn').forEach(n => n.classList.remove('active'));
  // Генератор справки — под-страница раздела «Справки»: держим его пункт активным.
  const highlight = (p === 'medical-cert') ? 'cert-requests' : p;
  // подсветить пункт в ОБОИХ меню (верхнее + drawer)
  document.querySelectorAll('.tn[data-p="' + highlight + '"]:not([data-stg])').forEach(n => n.classList.add('active'));
  document.querySelectorAll('.page').forEach(x => {
    x.classList.remove('active', 'page-enter');
  });
  const page = document.getElementById('page-' + p);
  if (page) {
    page.classList.add('active');
    void page.offsetWidth; // force reflow
    page.classList.add('page-enter');
  }
  // Ключ страницы на <body> — мобильная вёрстка чата растягивает .content
  // на весь экран только на своей странице (body[data-page="chat"]).
  _navPage = p;
  document.body.dataset.page = p;
  _navSyncHash(p, opts);
  _navAfterHighlight();
  if (p === 'dashboard')       { loadDashboard(); loadLs(); }
  if (p === 'clients')         loadClients();
  if (p === 'records')         { setDefDates(); loadRecords(1); }
  if (p === 'staff-analytics') loadStaffAnalytics();
  if (p === 'segments')        loadSegments();
  if (p === 'broadcasts')      loadBroadcasts();
  if (p === 'care')            loadCarePage();
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
  if (p === 'economics')      loadEconomics();
  if (p === 'edocs')          loadEdocs();
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
  // Группа без доступных роли пунктов прячется целиком; заголовок секции —
  // если до следующего заголовка не осталось ни одного видимого пункта/группы.
  document.querySelectorAll('#mainNav .nav-grp, #mnavList .nav-grp').forEach(g => {
    const any = Array.from(g.querySelectorAll('.tn')).some(n => n.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
  document.querySelectorAll('#mainNav .nav-sec-t, #mnavList .nav-sec-t').forEach(t => {
    let el = t.nextElementSibling, any = false;
    while (el && !el.classList.contains('nav-sec-t')) {
      if (el.style.display !== 'none') { any = true; break; }
      el = el.nextElementSibling;
    }
    t.style.display = any ? '' : 'none';
  });
  // стартовая страница — первый видимый пункт десктопного меню (#mainNav всегда в DOM)
  const firstMain = Array.from(document.querySelectorAll('#mainNav .tn:not([data-stg])'))
    .find(n => n.style.display !== 'none');
  // подсветить стартовую страницу в обоих меню
  if (firstMain) document.querySelectorAll('.tn[data-p="' + firstMain.dataset.p + '"]:not([data-stg])').forEach(n => n.classList.add('active'));
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
  if (id === 'agent-model') loadAgentModel();
  if (id === 'messengers') loadMessagingAccounts();
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
  const ROLE_LBL = { owner: 'Владелец', admin: 'Администратор', specialist: 'Специалист', admin_cashier: 'Администратор-кассир' };
  document.getElementById('mnavAv').textContent   = (ME.name || ME.email || '?').slice(0, 2).toUpperCase();
  document.getElementById('mnavName').textContent = ME.name || ME.email;
  document.getElementById('mnavRole').textContent = ROLE_LBL[ME.role] || ME.role || '';

  if (ME.must_change_password) {
    document.getElementById('changePwScreen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return;
  }

  document.getElementById('app').style.display = 'flex';
  // Полная синхронизация с YClients — только владельцу (≈8 800 запросов в общую
  // с продом квоту YClients; сервер тоже отвечает 403 остальным ролям).
  ['syncBtn', 'syncSt', 'mnavSyncBtn', 'mnavSyncSt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = ME.role === 'owner' ? '' : 'none';
  });
  checkAgentModelNotice();

  const startPage = applyRoleNav(ME.role);

  // Deep-link: /#chat, /#clients, /#chat/<ключ-диалога> и т.п. — открыть
  // страницу из hash, если она существует в DOM (доступность по роли уже
  // отфильтрована applyRoleNav). Хвост после «/» страница читает сама
  // из window._deepLinkArg (например, чат открывает диалог по ключу).
  const rawHash = (location.hash || '').slice(1);
  const [hashPage, ...hashRest] = rawHash.split('/');
  window._deepLinkArg = hashRest.length ? decodeURIComponent(hashRest.join('/')) : null;
  if (hashPage && document.getElementById('page-' + hashPage) && _navAllowed(hashPage)) {
    navTo(hashPage, { keepHash: true });   // hash уже верный (в нём может быть хвост)
    return;
  }
  window._deepLinkArg = null;              // hash не подошёл — хвост от него тоже не нужен

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + startPage)?.classList.add('active');
  _navPage = startPage;
  document.body.dataset.page = startPage;
  // replaceState, а не location.hash: стартовая страница не должна оставлять
  // лишнюю запись в истории (иначе первое «Назад» просто перезагружало бы её).
  history.replaceState(null, '', '#' + startPage);
  _navAfterHighlight();

  if (startPage === 'dashboard') { loadDashboard(); loadLs(); }
  else if (startPage === 'staff-dashboard') { loadStaffDashboard(); }
  else if (startPage === 'home-care') { loadHomeCare(); }
  else if (startPage === 'chat') { loadChat(); }
  else { loadDashboard(); loadLs(); }
}

// Кнопки «Назад»/«Вперёд» браузера и переходы, сделанные страницей (чат пишет в
// hash открытый диалог). Свой же hash узнаём по совпадению с _navPage — тогда
// перерисовывать страницу не нужно, изменился только хвост.
window.addEventListener('hashchange', () => {
  if (typeof ME === 'undefined' || !ME || !_navPage) return;   // ещё не залогинены
  const raw = (location.hash || '').slice(1);
  const [page, ...rest] = raw.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  if (!page) return;
  if (page === _navPage) {
    // Тот же раздел — сменился только хвост. Хвост есть у чата, дашборда и «Документов».
    if (page === 'dashboard' && typeof dashboardOnHashArg === 'function') dashboardOnHashArg(arg);
    if (page === 'chat' && typeof chatOnHashArg === 'function') chatOnHashArg(arg);
    if (page === 'edocs' && typeof edocsOnHashArg === 'function') edocsOnHashArg(arg);
    return;
  }
  if (!document.getElementById('page-' + page) || !_navAllowed(page)) {
    // Несуществующий или чужой раздел в адресе (правка руками, ссылка от коллеги
    // с другой ролью) — остаёмся где были, но и адрес возвращаем: разошедшийся
    // с экраном hash сломал бы следующее «Назад» и F5. replaceState не заводит
    // запись в истории и не поднимает hashchange повторно.
    history.replaceState(null, '', '#' + _navPage);
    return;
  }
  window._deepLinkArg = arg;
  navTo(page, { keepHash: true });
});

function showLogin() {
  if (typeof vdStop === 'function') vdStop();
  if (typeof bcStopMonitor === 'function') bcStopMonitor();
  if (typeof edStopPolling === 'function') edStopPolling();
  document.getElementById('agent-model-notice')?.remove();
  localStorage.removeItem('lp_tk');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ── MOBILE DRAWER ──
// Фокус уходит внутрь drawer и не выходит из него Tab'ом; при закрытии
// возвращается на кнопку меню. Фон на время открытого меню — inert.
function openMenu() {
  const dr = document.getElementById('mnavDrawer');
  document.getElementById('mnavOv')?.classList.add('open');
  if (!dr) return;
  dr.classList.add('open');
  document.querySelector('#app > .content')?.setAttribute('inert', '');
  const first = dr.querySelector('.tn.active') || dr.querySelector('.mnav-close');
  setTimeout(() => first?.focus(), 30);
}
function closeMenu() {
  const dr = document.getElementById('mnavDrawer');
  const wasOpen = !!dr?.classList.contains('open');
  document.getElementById('mnavOv')?.classList.remove('open');
  dr?.classList.remove('open');
  document.querySelector('#app > .content')?.removeAttribute('inert');
  if (wasOpen && dr.contains(document.activeElement)) document.getElementById('tbBurger')?.focus();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenu(); return; }
  const dr = document.getElementById('mnavDrawer');
  if (e.key === 'Tab' && dr?.classList.contains('open')) {
    const f = Array.from(dr.querySelectorAll('button, [tabindex="0"]')).filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // Пункты меню — div с role="link": Enter/пробел открывают раздел, как клик.
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t?.classList?.contains('tn')) { e.preventDefault(); nav(t); }
});
