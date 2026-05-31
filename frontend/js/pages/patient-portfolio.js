// ── Patient Photo Cases (внутренний клинический модуль) ─────────
'use strict';

const _ppState = { level: 1, clientId: null, visitId: null };

const _ppEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// PG возвращает DATE как ISO timestamp вида "2026-05-30T21:00:00.000Z" (UTC-полночь от MSK-даты).
// Отрезаем до даты, но через локальное Date чтобы UTC-сдвиг не сместил день назад.
const _ppFmtDate = (v) => {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const _ppRoot = () => document.querySelector('#page-patient-portfolio .pp-root');

async function loadPatientPortfolio() {
  await _ppRender();
}

async function _ppRender() {
  if (_ppState.level === 3) return _ppRenderAlbum();
  if (_ppState.level === 2) return _ppRenderPatient();
  return _ppRenderSearch();
}

// ── Level 1: поиск пациента ─────────────────────────────────
async function _ppRenderSearch() {
  _ppRoot().innerHTML = `
    <div class="pp-search">
      <input class="pp-q" placeholder="Поиск пациента по имени или телефону" autocomplete="off">
    </div>
    <div class="pp-recent"><div class="pp-hint">Начните вводить имя или телефон</div></div>
  `;
  const inp = _ppRoot().querySelector('.pp-q');
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => _ppDoSearch(inp.value), 250);
  });
  inp.focus();
}

async function _ppDoSearch(q) {
  const out = _ppRoot().querySelector('.pp-recent');
  if (!q || q.trim().length < 2) {
    out.innerHTML = `<div class="pp-hint">Введите минимум 2 символа</div>`;
    return;
  }
  let list;
  try {
    list = await api('GET', `/api/patient-portfolio/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    out.innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка: ${_ppEsc(e.message)}</div>`;
    return;
  }
  if (!list.length) { out.innerHTML = `<div class="pp-hint">Ничего не найдено или у пациентов ещё нет кейсов</div>`; return; }
  out.innerHTML = list.map(c => `
    <div class="case-card" data-client-id="${c.id}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
      <div class="cc-meta">${_ppEsc(c.phone || '')} • ${c.cases_count} кейсов${c.last_visit ? ' • посл. ' + c.last_visit : ''}</div>
    </div>
  `).join('');
  out.querySelectorAll('.case-card').forEach(el => {
    el.addEventListener('click', () => {
      _ppState.level = 2; _ppState.clientId = parseInt(el.dataset.clientId);
      _ppRender();
    });
  });
}

// ── Level 2: карточка пациента — таймлайн альбомов + курсы ──
async function _ppRenderPatient() {
  let cases, courses;
  try {
    [cases, courses] = await Promise.all([
      api('GET', `/api/patient-portfolio/clients/${_ppState.clientId}/cases`),
      api('GET', `/api/patient-portfolio/clients/${_ppState.clientId}/courses`),
    ]);
  } catch (e) {
    _ppRoot().innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка: ${_ppEsc(e.message)}</div>`;
    return;
  }
  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(1)">← К поиску</button>
      <button class="btn btn-pri" onclick="_ppNewVisit()">+ Новый альбом</button>
      <button class="btn" onclick="_ppNewCourse()">+ Курс</button>
    </div>
    <div class="pp-grid">
      <aside class="pp-courses">
        <h3>Курсы лечения</h3>
        ${courses.length === 0 ? '<div class="pp-hint">Курсов нет</div>' :
          courses.map(c => `
            <div class="course-card" data-id="${c.id}">
              <div class="cc-name">${_ppEsc(c.title)}</div>
              <div class="cc-meta">${c.visits.length} визитов${c.description ? ' • ' + _ppEsc(c.description.slice(0,60)) : ''}</div>
            </div>
          `).join('')}
      </aside>
      <main class="pp-timeline">
        ${cases.length === 0 ? '<div class="pp-hint">Альбомов пока нет — нажмите «+ Новый альбом»</div>' :
          cases.map(v => `
            <div class="case-card pp-tile" data-visit-id="${v.id}">
              ${v.preview_url ? `<img class="cc-preview" src="${_ppEsc(v.preview_url)}" alt="">` : '<div class="cc-noimg">нет фото</div>'}
              <div class="cc-body">
                <div class="cc-name">${_ppEsc(_ppFmtDate(v.visit_date))}</div>
                <div class="cc-meta">${_ppEsc(v.specialist_name || '—')} • ${v.photos_count} фото • ${v.comments_count} комм.</div>
                ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
              </div>
            </div>
          `).join('')}
      </main>
    </div>
  `;
  _ppRoot().querySelectorAll('.case-card[data-visit-id]').forEach(el =>
    el.onclick = () => { _ppState.level = 3; _ppState.visitId = parseInt(el.dataset.visitId); _ppRender(); });
}

async function _ppNewCourse() {
  const title = prompt('Название курса:');
  if (!title || !title.trim()) return;
  const description = prompt('Описание (опционально):') || null;
  try {
    await api('POST', '/api/patient-portfolio/courses', { client_id: _ppState.clientId, title: title.trim(), description });
    _ppRender();
  } catch (e) {
    alert('Не удалось создать курс: ' + e.message);
  }
}

async function _ppNewVisit() {
  // MVP: создаём альбом без привязки к записи в YClients — даты сегодня.
  // Привязку к records делает Task 12 / отдельный UI выбора визита.
  try {
    await api('POST', '/api/patient-portfolio/visits', { client_id: _ppState.clientId });
    _ppRender();
  } catch (e) {
    alert('Не удалось создать альбом: ' + e.message);
  }
}

async function _ppRenderAlbum() {
  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(2)">← Назад</button>
    </div>
    <div class="pp-hint">TODO: альбом ${_ppState.visitId} (Task 12)</div>`;
}

function _ppBack(level) {
  _ppState.level = level;
  if (level === 1) { _ppState.clientId = null; _ppState.visitId = null; }
  if (level === 2) { _ppState.visitId = null; }
  _ppRender();
}
