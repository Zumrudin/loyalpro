// ── Patient Photo Cases (внутренний клинический модуль) ─────────
'use strict';

const _ppState = { level: 1, clientId: null, visitId: null, clientName: null };

// Инициалы для аватара пациента: «Иванова Ася» → «ИА».
const _ppInitials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '—';

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

// ── Level 1: лента альбомов (entry-view) + поиск пациента ───
async function _ppRenderSearch() {
  _ppRoot().innerHTML = `
    <div class="pp-search">
      <input class="pp-q" placeholder="Поиск пациента по имени или телефону" autocomplete="off">
      <button class="btn btn-pri pp-create-btn">+ Создать альбом</button>
    </div>
    <div id="pp-recent" class="pp-recent"></div>
    <div class="pp-modal-bg" hidden>
      <div class="pp-modal" role="dialog" aria-label="Создать альбом">
        <header class="pp-modal-head">
          <h3>Создать альбом</h3>
          <button class="pp-modal-close" type="button" aria-label="Закрыть">×</button>
        </header>
        <div class="pp-modal-body">
          <input class="pp-create-q" placeholder="Найдите пациента по имени или телефону" autocomplete="off">
          <div class="pp-create-results"><div class="pp-hint">Введите минимум 2 символа</div></div>
        </div>
      </div>
    </div>
  `;
  const inp = _ppRoot().querySelector('.pp-q');
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => _ppDoSearch(inp.value), 250);
  });
  _ppRoot().querySelector('.pp-create-btn').addEventListener('click', _ppOpenCreateModal);
  await _ppRenderFeed();
}

function _ppOpenCreateModal() {
  const bg = _ppRoot().querySelector('.pp-modal-bg');
  bg.hidden = false;
  const q = bg.querySelector('.pp-create-q');
  q.value = '';
  bg.querySelector('.pp-create-results').innerHTML = `<div class="pp-hint">Введите минимум 2 символа</div>`;
  q.focus();
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => _ppCreateModalSearch(q.value), 250); };
  bg.querySelector('.pp-modal-close').onclick = _ppCloseCreateModal;
  bg.onclick = (ev) => { if (ev.target === bg) _ppCloseCreateModal(); };
  document.addEventListener('keydown', _ppCreateModalEsc);
}

function _ppCloseCreateModal() {
  const bg = _ppRoot()?.querySelector('.pp-modal-bg');
  if (bg) bg.hidden = true;
  document.removeEventListener('keydown', _ppCreateModalEsc);
}

function _ppCreateModalEsc(ev) {
  if (ev.key === 'Escape') _ppCloseCreateModal();
}

async function _ppCreateModalSearch(q) {
  const out = _ppRoot().querySelector('.pp-create-results');
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
    out.innerHTML = `<div class="pp-hint">Пациент не найден. Они подтягиваются из YClients автоматически.</div>`;
    return;
  }
  out.innerHTML = list.map(c => `
    <div class="case-card pp-pick" data-client-id="${c.id}" data-client-name="${_ppEsc(c.name)}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
      <div class="cc-meta">${_ppEsc(c.phone || '')}${c.cases_count > 0 ? ' • ' + c.cases_count + ' альбом(ов)' : ''}${c.last_visit ? ' • посл. ' + _ppFmtDate(c.last_visit) : ''}</div>
    </div>
  `).join('');
  out.querySelectorAll('.pp-pick').forEach(el => {
    el.addEventListener('click', () => _ppCreateFromPick(parseInt(el.dataset.clientId), el.dataset.clientName));
  });
}

async function _ppCreateFromPick(clientId, clientName) {
  // Защита от двойного клика
  const bg = _ppRoot().querySelector('.pp-modal-bg');
  if (bg.dataset.busy === '1') return;
  bg.dataset.busy = '1';
  try {
    const v = await api('POST', '/api/patient-portfolio/visits', { client_id: clientId });
    _ppCloseCreateModal();
    _ppState.level = 3;
    _ppState.clientId = clientId;
    _ppState.visitId = v.id;
    _ppRender();
  } catch (e) {
    alert('Не удалось создать альбом для «' + clientName + '»: ' + e.message);
  } finally {
    bg.dataset.busy = '0';
  }
}

async function _ppRenderFeed() {
  const out = _ppRoot().querySelector('#pp-recent');
  if (!out) return;
  out.innerHTML = `<div class="pp-hint">Загрузка ленты…</div>`;
  let visits;
  try {
    visits = await api('GET', `/api/patient-portfolio/visits/recent?limit=60`);
  } catch (e) {
    out.innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка: ${_ppEsc(e.message)}</div>`;
    return;
  }
  if (!visits.length) {
    out.innerHTML = `<div class="pp-hint">Пока нет ни одного альбома. Найдите пациента через поиск выше и создайте первый альбом.</div>`;
    return;
  }
  out.className = 'pp-feed';
  out.innerHTML = visits.map(v => {
    // Бэкенд отдаёт preview_urls (массив до 3) + preview_url (для бэквард-совместимости).
    const urls = Array.isArray(v.preview_urls) ? v.preview_urls
               : (v.preview_url ? [v.preview_url] : []);
    const media = urls.length === 0
      ? '<div class="cc-noimg">нет фото</div>'
      : `<div class="cc-preview-strip" data-n="${urls.length}">
           ${urls.map(u => `<img src="${_ppEsc(u)}" loading="lazy" decoding="async" alt="">`).join('')}
         </div>`;
    return `
      <div class="case-card pp-tile" data-visit-id="${v.id}" data-client-id="${v.client_id}">
        <div class="pp-tile-media">
          ${media}
          ${(v.has_before && v.has_after) ? '<span class="pp-ba-badge">До·После</span>' : ''}
        </div>
        <div class="cc-body">
          <div class="cc-name">${_ppEsc(v.client_name || '—')}</div>
          <div class="cc-staff">${_ppEsc(v.specialist_name || '—')}</div>
          <div class="cc-meta">${_ppEsc(_ppFmtDate(v.visit_date))} • ${v.photos_count} фото${v.comments_count ? ' • ' + v.comments_count + ' комм.' : ''}</div>
          ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
  out.querySelectorAll('.case-card[data-visit-id]').forEach(el => {
    el.addEventListener('click', () => {
      _ppState.level = 3;
      _ppState.clientId = parseInt(el.dataset.clientId);
      _ppState.visitId = parseInt(el.dataset.visitId);
      _ppRender();
    });
  });
}

async function _ppDoSearch(q) {
  const out = _ppRoot().querySelector('#pp-recent');
  if (!q || q.trim().length < 2) {
    out.className = '';
    await _ppRenderFeed();
    return;
  }
  let list;
  try {
    list = await api('GET', `/api/patient-portfolio/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    out.className = '';
    out.innerHTML = `<div class="pp-hint" style="color:#c00">Ошибка: ${_ppEsc(e.message)}</div>`;
    return;
  }
  out.className = '';
  if (!list.length) {
    out.innerHTML = `<div class="pp-hint">Пациент с таким именем/телефоном не найден в этом салоне. Пациенты подтягиваются из YClients автоматически.</div>`;
    return;
  }
  out.innerHTML = `<div class="pp-search-results">` + list.map(c => `
    <div class="case-card" data-client-id="${c.id}" data-client-name="${_ppEsc(c.name)}">
      <div class="cc-name">${_ppEsc(c.name)}</div>
      <div class="cc-meta">${_ppEsc(c.phone || '')} • ${c.cases_count > 0 ? c.cases_count + ' альбом(ов)' : 'нет альбомов — кликните, чтобы создать первый'}${c.last_visit ? ' • посл. ' + _ppFmtDate(c.last_visit) : ''}</div>
    </div>
  `).join('') + `</div>`;
  out.querySelectorAll('.case-card').forEach(el => {
    el.addEventListener('click', () => {
      _ppState.level = 2;
      _ppState.clientId = parseInt(el.dataset.clientId);
      _ppState.clientName = el.dataset.clientName || null;
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
  const pname = (cases[0] && cases[0].client_name) || _ppState.clientName || '—';
  const pphone = (cases[0] && cases[0].client_phone) || '';
  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(1)">‹ К поиску</button>
      <button class="btn btn-pri" onclick="_ppNewVisit()">+ Новый альбом</button>
    </div>
    <div class="pp-patient-head">
      <div class="pp-avatar">${_ppEsc(_ppInitials(pname))}</div>
      <div class="pp-patient-id">
        <div class="pp-patient-name">${_ppEsc(pname)}</div>
        <div class="pp-patient-sub">${_ppEsc(pphone)}${cases.length ? ' · ' + cases.length + ' альбом(ов)' : ''}</div>
      </div>
    </div>
    <div class="pp-courses-row">
      ${courses.map(c => `<span class="pp-chip pp-chip-course" data-id="${c.id}">${_ppEsc(c.title)} · ${c.visits.length}</span>`).join('')}
      <span class="pp-chip pp-chip-add" onclick="_ppNewCourse()">+ Курс</span>
    </div>
    <div class="pp-timeline">
      ${cases.length === 0 ? '<div class="pp-empty">Альбомов пока нет — нажмите «+ Новый альбом»</div>' :
        cases.map(v => `
          <div class="case-card pp-row" data-visit-id="${v.id}">
            ${v.preview_url ? `<img class="pp-row-img" src="${_ppEsc(v.preview_url)}" loading="lazy" decoding="async" alt="">` : '<div class="pp-row-noimg">нет фото</div>'}
            <div class="pp-row-body">
              <div class="cc-name">${_ppEsc(_ppFmtDate(v.visit_date))}</div>
              <div class="cc-meta">${_ppEsc(v.specialist_name || '—')} • ${v.photos_count} фото • ${v.comments_count} комм.</div>
              ${v.course_title ? `<div class="cc-course">↳ ${_ppEsc(v.course_title)}</div>` : ''}
            </div>
          </div>
        `).join('')}
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

// Загрузка одного батча через XHR (fetch не даёт upload-progress).
// onProgress(frac) — доля переданных байтов батча (0..1). Резолвит JSON-ответ.
function _ppUploadChunk(visitId, stage, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('stage', stage);
    chunk.forEach(f => fd.append('files', f));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/patient-portfolio/visits/${visitId}/photos`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + (TOKEN || localStorage.getItem('lp_tk')));
    xhr.timeout = 120000; // 2 мин на батч — крупные фото на медленной мобильной сети
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (_) { /* пустой/невалидный ответ — считаем успехом батча */ }
        resolve(body);
      } else {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || 'ошибка сервера'}`));
      }
    };
    xhr.onerror = () => reject(new Error('сеть недоступна, проверьте соединение'));
    xhr.ontimeout = () => reject(new Error('превышено время ожидания'));
    xhr.send(fd);
  });
}

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

  // Карточка-сравнение: по одному фото из каждой существующей стадии.
  // photos с сервера упорядочены stage, sort_order, id — берём первое в before/in_progress,
  // последнее (новейшее) в after.
  const cmpPicks = [
    { stage: 'before',      label: 'ДО',         photo: byStage.before[0] },
    { stage: 'in_progress', label: 'В ПРОЦЕССЕ', photo: byStage.in_progress[0] },
    { stage: 'after',       label: 'ПОСЛЕ',      photo: byStage.after[byStage.after.length - 1] },
  ].filter(p => p.photo);
  const compareBlock = cmpPicks.length >= 2 ? `
    <section class="pp-compare">
      <div class="pp-cmp-pair" data-n="${cmpPicks.length}">
        ${cmpPicks.map(p => `
          <figure class="pp-cmp-half">
            <img class="pp-thumb" src="${_ppEsc(p.photo.url_thumb)}" data-photo-id="${p.photo.id}" data-medium="${_ppEsc(p.photo.url_medium)}" alt="">
            <figcaption class="pp-cmp-lbl pp-cmp-${p.stage}">${p.label}</figcaption>
          </figure>
        `).join('')}
      </div>
      <div class="pp-cmp-foot">Результат</div>
    </section>
  ` : '';

  const fileInput = (key) => `<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-stage="${key}" hidden>`;

  const stageBlock = (key) => {
    const photos = byStage[key];
    const body = photos.length === 0
      ? `<label class="pp-dropzone">
           <span class="pp-dz-plus">＋</span>
           <span>${_PP_STAGE_LABELS[key]} — добавить фото</span>
           ${fileInput(key)}
         </label>`
      : `<div class="pp-stage-grid">
           ${photos.map(p => `<img class="pp-thumb" src="${_ppEsc(p.url_thumb)}" loading="lazy" decoding="async" data-photo-id="${p.id}" data-medium="${_ppEsc(p.url_medium)}" alt="">`).join('')}
         </div>`;
    return `
      <section class="pp-stage pp-stage--${key}">
        <header class="pp-stage-head">
          <h3>${_PP_STAGE_LABELS[key]} <span class="pp-stage-count">${photos.length}</span></h3>
          ${photos.length ? `<label class="pp-add-btn">+ Добавить фото${fileInput(key)}</label>` : ''}
        </header>
        <div class="pp-upload-bar" hidden>
          <div class="pp-upload-track"><div class="pp-upload-fill"></div></div>
          <span class="pp-upload-label"></span>
        </div>
        ${body}
      </section>
    `;
  };

  _ppRoot().innerHTML = `
    <div class="pp-toolbar">
      <button class="btn-back" onclick="_ppBack(2)">‹ Пациент</button>
      <div class="pp-album-meta">Альбом · ${_ppEsc(_ppFmtDate(v.visit_date))}</div>
      <div class="pp-menu">
        <button class="pp-menu-btn" type="button" aria-label="Меню альбома">⋯</button>
        <div class="pp-menu-pop" hidden>
          <button class="pp-del-visit" type="button">Удалить альбом</button>
        </div>
      </div>
    </div>
    ${compareBlock}
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
      <div class="pp-lb-actions">
        <button class="pp-lb-dl btn btn-pri" type="button">Скачать оригинал</button>
        <button class="pp-lb-del btn" type="button">Удалить</button>
      </div>
    </div>
  `;

  // ── Меню ⋯ (открыть/закрыть; клик вне — закрыть)
  const menuBtn = _ppRoot().querySelector('.pp-menu-btn');
  const menuPop = _ppRoot().querySelector('.pp-menu-pop');
  menuBtn.onclick = (ev) => { ev.stopPropagation(); menuPop.hidden = !menuPop.hidden; };
  document.addEventListener('click', function closeMenu(ev) {
    if (!_ppRoot() || !_ppRoot().contains(menuPop)) { document.removeEventListener('click', closeMenu); return; }
    if (!menuPop.hidden && ev.target !== menuBtn && !menuPop.contains(ev.target)) menuPop.hidden = true;
  });

  // ── Удаление альбома (пункт меню)
  _ppRoot().querySelector('.pp-del-visit').onclick = async () => {
    if (!confirm('Удалить альбом со всеми фото безвозвратно?')) return;
    try {
      await api('DELETE', `/api/patient-portfolio/visits/${v.id}`);
      _ppState.level = 2; _ppState.visitId = null; _ppRender();
    } catch (e) { alert('Не удалось удалить: ' + e.message); }
  };

  // ── Автосохранение заметок
  _ppRoot().querySelector('.pp-notes-ta').addEventListener('blur', async (e) => {
    if (e.target.value === (v.notes || '')) return;
    try { await api('PUT', `/api/patient-portfolio/visits/${v.id}`, { notes: e.target.value }); }
    catch (err) { alert('Не удалось сохранить заметки: ' + err.message); }
  });

  // ── Загрузка (батчи по 5, multipart, XHR — реальный прогресс + устойчивость к обрыву)
  _ppRoot().querySelectorAll('input[type=file][data-stage]').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      const stage = inp.dataset.stage;
      const section = inp.closest('.pp-stage');
      const bar = section.querySelector('.pp-upload-bar');
      const fill = bar.querySelector('.pp-upload-fill');
      const label = bar.querySelector('.pp-upload-label');
      const addBtn = section.querySelector('.pp-add-btn');

      const total = files.length;
      let done = 0;
      let failed = 0;
      const setBar = (frac, pct) => {
        fill.style.width = Math.min(100, Math.round(pct)) + '%';
        label.textContent = `Загрузка ${Math.min(done + frac, total)} из ${total}…`;
      };
      bar.hidden = false;
      if (addBtn) addBtn.classList.add('pp-add-disabled');
      inp.disabled = true;
      setBar(0, 0);

      try {
        for (let i = 0; i < files.length; i += 5) {
          const chunk = files.slice(i, i + 5);
          const body = await _ppUploadChunk(v.id, stage, chunk, (chunkFrac) => {
            setBar(Math.round(chunkFrac * chunk.length), ((done + chunkFrac * chunk.length) / total) * 100);
          });
          const ups = Array.isArray(body.uploaded) ? body.uploaded : [];
          failed += chunk.length - ups.filter(u => u && u.ok).length;
          done += chunk.length;
          setBar(0, (done / total) * 100);
        }
        fill.style.width = '100%';
        label.textContent = failed ? `Готово · ${failed} не удалось` : 'Готово';
        if (failed) {
          alert(`Загружено ${total - failed} из ${total}. ${failed} фото не удалось обработать — попробуйте добавить их ещё раз.`);
          _ppRender();
        } else {
          setTimeout(() => _ppRender(), 450);
        }
      } catch (err) {
        alert('Ошибка загрузки: ' + err.message + (done ? `\nЗагружено ${done} из ${total} до обрыва.` : ''));
        _ppRender();
      }
    });
  });

  // ── Лайтбокс (покрывает и миниатюры стадий, и половинки сравнения — класс .pp-thumb)
  // Переносим в <body>, иначе он наследует transform-контекст от .page-enter
  // и position:fixed перестаёт быть относительно вьюпорта → на мобильном растёт по высоте.
  document.querySelectorAll('body > .pp-lightbox').forEach(el => el.remove());
  const lb = _ppRoot().querySelector('.pp-lightbox');
  document.body.appendChild(lb);
  _ppRoot().querySelectorAll('.pp-thumb').forEach(img => {
    img.onclick = () => {
      lb.hidden = false;
      lb.querySelector('.pp-lb-img').src = img.dataset.medium;
      lb.dataset.photoId = img.dataset.photoId;
      document.body.style.overflow = 'hidden';   // блокируем скролл страницы пока открыт
    };
  });
  const closeLightbox = () => { lb.hidden = true; document.body.style.overflow = ''; };
  lb.querySelector('.pp-lb-close').onclick = closeLightbox;
  lb.addEventListener('click', (ev) => { if (ev.target === lb) closeLightbox(); });
  document.addEventListener('keydown', function escClose(ev) {
    if (ev.key === 'Escape' && !lb.hidden) closeLightbox();
  });
  lb.querySelector('.pp-lb-dl').onclick = async () => {
    try {
      const r = await api('GET', `/api/patient-portfolio/photos/${lb.dataset.photoId}/url?variant=original`);
      window.open(r.url, '_blank');
    } catch (e) { alert('Не удалось получить ссылку: ' + e.message); }
  };
  lb.querySelector('.pp-lb-del').onclick = async () => {
    if (!confirm('Удалить это фото безвозвратно?')) return;
    try {
      await api('DELETE', `/api/patient-portfolio/photos/${lb.dataset.photoId}`);
      closeLightbox();
      _ppRender();
    } catch (e) { alert('Не удалось удалить: ' + e.message); }
  };

  // ── Добавление комментария
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
