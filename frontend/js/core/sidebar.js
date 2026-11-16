// Desktop Ivory sidebar: its markup is intentionally added at runtime so the
// legacy and mobile navigation keep their existing contracts.
(function () {
  'use strict';

  const STORAGE_KEY = 'loyalpro.ivorySidebarCollapsed';
  const DESKTOP = '(min-width: 1024px)';
  const ICONS = {
    workday: 'M4 5h16v14H4z M8 3v4 M16 3v4 M7 12h10 M12 9v6',
    dashboard: 'M4 19V9 M10 19V5 M16 19v-8 M3 20h18',
    'staff-dashboard': 'M5 20v-1a5 5 0 0 1 10 0v1 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    journal: 'M5 4h14v16H5z M8 2v4 M16 2v4 M5 9h14 M8 13h3 M8 16h6',
    records: 'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',
    clients: 'M4 20v-2a5 5 0 0 1 10 0v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M16 12a4 4 0 0 1 4 4v2',
    chat: 'M4 5h16v11H9l-5 4z M8 10h8',
    care: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.7A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
    'home-care': 'M4 11 12 4l8 7v9H4z M9 20v-5h6v5',
    default: 'M5 5h14v14H5z M8 9h8 M8 13h8'
  };
  const GROUP_ICONS = { growth: 'M4 19V9 M10 19V5 M16 19v-8 M3 20h18', materials: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5', manage: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 21v-1a7 7 0 0 1 14 0v1 M4 10h5 M15 10h5' };

  function isDesktop() { return window.matchMedia(DESKTOP).matches; }
  function icon(path) { return '<svg class="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>'; }
  function getStored() { try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; } }
  function store(value) { try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch (_) {} }

  function setPopoverPosition(group) {
    const title = group.querySelector('.nav-grp-t');
    const body = group.querySelector('.nav-grp-b');
    if (!title || !body) return;
    const rect = title.getBoundingClientRect();
    const maxHeight = Math.min(420, body.scrollHeight || 420);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - maxHeight - 8));
    body.style.top = top + 'px';
    body.style.left = (rect.right + 8) + 'px';
  }

  function closeRailPopovers(nav) {
    nav.querySelectorAll('.nav-grp.rail-open').forEach(group => {
      group.classList.remove('rail-open');
      const title = group.querySelector('.nav-grp-t');
      const body = group.querySelector('.nav-grp-b');
      if (title) title.setAttribute('aria-expanded', 'false');
      if (body) { body.style.top = ''; body.style.left = ''; }
    });
  }

  function toggleGroup(group, nav) {
    const opening = !group.classList.contains('rail-open');
    closeRailPopovers(nav);
    if (!opening) return;
    group.classList.add('rail-open');
    const title = group.querySelector('.nav-grp-t');
    if (title) title.setAttribute('aria-expanded', 'true');
    setPopoverPosition(group);
  }

  function decorateNav(nav) {
    nav.querySelectorAll('.tn').forEach(item => {
      if (item.querySelector('.sidebar-label')) return;
      const label = document.createElement('span');
      label.className = 'sidebar-label';
      while (item.firstChild) label.appendChild(item.firstChild);
      item.appendChild(label);
      item.insertAdjacentHTML('afterbegin', icon(ICONS[item.dataset.p] || ICONS.default));
      item.setAttribute('title', label.textContent.trim());
      item.setAttribute('aria-label', label.textContent.trim());
    });
    nav.querySelectorAll('.nav-grp').forEach(group => {
      const title = group.querySelector('.nav-grp-t');
      if (!title || title.querySelector('.sidebar-label')) return;
      const label = document.createElement('span');
      label.className = 'sidebar-label';
      label.textContent = title.textContent.trim();
      title.textContent = '';
      title.insertAdjacentHTML('afterbegin', icon(GROUP_ICONS[group.dataset.grp] || ICONS.default));
      title.appendChild(label);
      title.title = label.textContent;
      title.setAttribute('aria-label', label.textContent);
    });
  }

  function sidebarInit() {
    const app = document.getElementById('app');
    const logo = document.querySelector('.tb-logo');
    const nav = document.getElementById('mainNav');
    if (!app || !logo || !nav) return;
    decorateNav(nav);
    if (!logo.querySelector('.sidebar-brand-mark')) {
      const clinicMark = document.querySelector('.tb-clinic img');
      if (clinicMark) {
        const mark = clinicMark.cloneNode(false);
        mark.removeAttribute('id'); mark.className = 'sidebar-brand-mark';
        logo.prepend(mark);
      }
    }
    let toggle = logo.querySelector('.sidebar-toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'sidebar-toggle'; toggle.id = 'sidebarToggle';
      toggle.setAttribute('aria-label', 'Свернуть боковую панель');
      toggle.setAttribute('aria-controls', 'mainNav');
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4 16 12 8 20"/></svg>';
      logo.appendChild(toggle);
      toggle.addEventListener('click', () => {
        const next = !app.classList.contains('sidebar-collapsed');
        app.classList.toggle('sidebar-collapsed', next);
        toggle.setAttribute('aria-label', next ? 'Развернуть боковую панель' : 'Свернуть боковую панель');
        toggle.setAttribute('aria-expanded', String(!next));
        closeRailPopovers(nav);
        if (!next) {
          nav.querySelectorAll('.nav-grp').forEach(group => {
            group.querySelector('.nav-grp-t')?.setAttribute('aria-expanded', String(group.classList.contains('open')));
          });
          if (typeof _navAfterHighlight === 'function') _navAfterHighlight();
        }
        if (typeof sideCalendarClose === 'function') sideCalendarClose();
        store(next);
      });
    }
    const collapsed = getStored();
    app.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель');
    if (!nav.dataset.sidebarBound) {
      nav.dataset.sidebarBound = '1';
      nav.addEventListener('click', event => {
        if (!isDesktop() || !app.classList.contains('sidebar-collapsed')) return;
        const groupTitle = event.target.closest('.nav-grp-t');
        if (groupTitle && nav.contains(groupTitle)) {
          event.preventDefault(); event.stopImmediatePropagation();
          toggleGroup(groupTitle.closest('.nav-grp'), nav);
          return;
        }
        if (event.target.closest('.tn, .side-calendar')) closeRailPopovers(nav);
      }, true);
      document.addEventListener('click', event => {
        if (!app.classList.contains('sidebar-collapsed')) return;
        if (!nav.contains(event.target)) closeRailPopovers(nav);
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const openTitle = nav.querySelector('.nav-grp.rail-open .nav-grp-t');
        closeRailPopovers(nav);
        if (openTitle) openTitle.focus();
      });
      window.addEventListener('resize', () => {
        if (!isDesktop()) closeRailPopovers(nav);
        nav.querySelectorAll('.nav-grp.rail-open').forEach(setPopoverPosition);
      });
    }
  }

  window.sidebarInit = sidebarInit;
})();
