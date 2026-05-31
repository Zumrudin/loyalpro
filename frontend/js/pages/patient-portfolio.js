// ── Patient Photo Cases (внутренний клинический модуль) ─────────
'use strict';

const _ppState = { level: 1, clientId: null, visitId: null };

const _ppEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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

// ── Level 2 / 3 — заглушки, будут реализованы в Task 11/12 ─────
async function _ppRenderPatient() {
  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(1)">← Назад</button>
    </div>
    <div class="pp-hint">TODO: карточка пациента ${_ppState.clientId} (Task 11)</div>`;
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
