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
  if (!list.length) {
    out.innerHTML = `<div class="pp-hint">Пациент с таким именем/телефоном не найден в этом салоне. Пациенты подтягиваются из YClients автоматически.</div>`;
    return;
  }
  out.innerHTML = list.map(c => `
    <div class="case-card" data-client-id="${c.id}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
      <div class="cc-meta">${_ppEsc(c.phone || '')} • ${c.cases_count > 0 ? c.cases_count + ' альбом(ов)' : 'нет альбомов — кликните, чтобы создать первый'}${c.last_visit ? ' • посл. ' + _ppFmtDate(c.last_visit) : ''}</div>
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
  // После создания сразу проваливаемся в L3 — там кнопки «+ Добавить фото».
  try {
    const v = await api('POST', '/api/patient-portfolio/visits', { client_id: _ppState.clientId });
    if (v && v.id) {
      _ppState.level = 3;
      _ppState.visitId = v.id;
    }
    _ppRender();
  } catch (e) {
    alert('Не удалось создать альбом: ' + e.message);
  }
}

// ── Level 3: альбом визита — 3 стадии + загрузка + лайтбокс + комментарии ──
const _PP_STAGE_LABELS = { before: 'До', in_progress: 'В процессе', after: 'После' };

async function _ppRenderAlbum() {
  let v;
  try {
    v = await api('GET', `/api/patient-portfolio/visits/${_ppState.visitId}`);
  } catch (e) {
    _ppRoot().innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка загрузки: ${_ppEsc(e.message)}</div>`;
    return;
  }
  const byStage = { before: [], in_progress: [], after: [] };
  v.photos.forEach(p => { if (byStage[p.stage]) byStage[p.stage].push(p); });

  const stageBlock = (key) => `
    <section class="pp-stage">
      <header class="pp-stage-head">
        <h3>${_PP_STAGE_LABELS[key]} <span class="pp-stage-count">${byStage[key].length}</span></h3>
        <label class="pp-add-btn">
          + Добавить фото
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple data-stage="${key}" hidden>
        </label>
      </header>
      <div class="pp-stage-grid">
        ${byStage[key].length === 0 ? '<div class="pp-stage-empty">Нет фото</div>' :
          byStage[key].map(p => `<img class="pp-thumb" src="${_ppEsc(p.url_thumb)}" data-photo-id="${p.id}" data-medium="${_ppEsc(p.url_medium)}" alt="">`).join('')}
      </div>
    </section>
  `;

  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(2)">← К пациенту</button>
      <div class="pp-album-meta">Альбом от ${_ppEsc(_ppFmtDate(v.visit_date))}</div>
      <button class="btn pp-del-visit">Удалить альбом</button>
    </div>
    ${stageBlock('before')}
    ${stageBlock('in_progress')}
    ${stageBlock('after')}
    <section class="pp-notes">
      <h3>Заметки</h3>
      <textarea class="pp-notes-ta" placeholder="Клинические заметки по альбому">${_ppEsc(v.notes || '')}</textarea>
      <div class="pp-notes-hint">Сохраняется при потере фокуса</div>
    </section>
    <section class="pp-comments">
      <h3>Комментарии</h3>
      <div class="pp-comments-list">
        ${v.comments.length === 0 ? '<div class="pp-stage-empty">Комментариев пока нет</div>' :
          v.comments.map(c => `
            <div class="pp-comment">
              <div class="pp-c-head">${_ppEsc(c.author_name || '—')} • ${new Date(c.created_at).toLocaleString('ru')}</div>
              <div class="pp-c-text">${_ppEsc(c.text)}</div>
            </div>`).join('')}
      </div>
      <div class="pp-comment-form">
        <textarea class="pp-new-comment" placeholder="Написать комментарий…"></textarea>
        <button class="btn btn-pri pp-add-comment">Отправить</button>
      </div>
    </section>
    <div class="pp-lightbox" hidden>
      <img class="pp-lb-img" alt="">
      <button class="pp-lb-close" type="button">×</button>
      <button class="pp-lb-dl btn btn-pri" type="button">Скачать оригинал</button>
    </div>
  `;

  // ── Delete album
  _ppRoot().querySelector('.pp-del-visit').onclick = async () => {
    if (!confirm('Удалить альбом со всеми фото безвозвратно?')) return;
    try {
      await api('DELETE', `/api/patient-portfolio/visits/${v.id}`);
      _ppState.level = 2; _ppState.visitId = null; _ppRender();
    } catch (e) { alert('Не удалось удалить: ' + e.message); }
  };

  // ── Notes autosave
  _ppRoot().querySelector('.pp-notes-ta').addEventListener('blur', async (e) => {
    if (e.target.value === (v.notes || '')) return;
    try { await api('PUT', `/api/patient-portfolio/visits/${v.id}`, { notes: e.target.value }); }
    catch (err) { alert('Не удалось сохранить заметки: ' + err.message); }
  });

  // ── Upload (batched по 5, multipart, без api() — у него только JSON)
  _ppRoot().querySelectorAll('input[type=file][data-stage]').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      const stage = inp.dataset.stage;
      try {
        for (let i = 0; i < files.length; i += 5) {
          const chunk = files.slice(i, i + 5);
          const fd = new FormData();
          fd.append('stage', stage);
          chunk.forEach(f => fd.append('files', f));
          const r = await fetch(`/api/patient-portfolio/visits/${v.id}/photos`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + (TOKEN || localStorage.getItem('lp_tk')) },
            body: fd,
          });
          if (!r.ok) {
            const t = await r.text();
            throw new Error(`HTTP ${r.status}: ${t}`);
          }
        }
        _ppRender();
      } catch (err) {
        alert('Ошибка загрузки: ' + err.message);
      }
    });
  });

  // ── Lightbox
  const lb = _ppRoot().querySelector('.pp-lightbox');
  _ppRoot().querySelectorAll('.pp-thumb').forEach(img => {
    img.onclick = () => {
      lb.hidden = false;
      lb.querySelector('.pp-lb-img').src = img.dataset.medium;
      lb.dataset.photoId = img.dataset.photoId;
    };
  });
  const closeLightbox = () => { lb.hidden = true; };
  lb.querySelector('.pp-lb-close').onclick = closeLightbox;
  // Клик по фону (но не по картинке/кнопкам) — тоже закрывает
  lb.addEventListener('click', (ev) => { if (ev.target === lb) closeLightbox(); });
  // Esc
  document.addEventListener('keydown', function escClose(ev) {
    if (ev.key === 'Escape' && !lb.hidden) closeLightbox();
  });
  lb.querySelector('.pp-lb-dl').onclick = async () => {
    try {
      const r = await api('GET', `/api/patient-portfolio/photos/${lb.dataset.photoId}/url?variant=original`);
      window.open(r.url, '_blank');
    } catch (e) { alert('Не удалось получить ссылку: ' + e.message); }
  };

  // ── Comment add
  _ppRoot().querySelector('.pp-add-comment').onclick = async () => {
    const ta = _ppRoot().querySelector('.pp-new-comment');
    const text = ta.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/patient-portfolio/visits/${v.id}/comments`, { text });
      ta.value = '';
      _ppRender();
    } catch (e) { alert('Не удалось отправить: ' + e.message); }
  };
}

function _ppBack(level) {
  _ppState.level = level;
  if (level === 1) { _ppState.clientId = null; _ppState.visitId = null; }
  if (level === 2) { _ppState.visitId = null; }
  _ppRender();
}
