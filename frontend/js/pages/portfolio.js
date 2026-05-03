// ── Portfolio (До/После) admin page ───────────────────────────
'use strict';

let _portfolioCats = [];
let _portfolioCurrentCat = null;     // { id, title, ... } when at Level 2
let _portfolioCatModalMode = null;   // 'create' | 'edit'
let _portfolioCatWasDragging = false;

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── Top-level loader ──────────────────────────────────────────
async function loadPortfolioCategories() {
  _portfolioCurrentCat = null;
  document.getElementById('portfolio-loading').style.display = 'block';
  document.getElementById('portfolio-cats-view').style.display = 'none';
  document.getElementById('portfolio-items-view').style.display = 'none';
  document.getElementById('portfolio-loading').textContent = 'Загрузка...';
  try {
    const data = await api('GET', '/api/portfolio/categories');
    _portfolioCats = data.categories || [];
    document.getElementById('portfolio-loading').style.display = 'none';
    document.getElementById('portfolio-cats-view').style.display = 'block';
    renderPortfolioCategories();
  } catch (e) {
    document.getElementById('portfolio-loading').textContent = 'Ошибка загрузки: ' + e.message;
  }
}

function renderPortfolioCategories() {
  const grid = document.getElementById('portfolio-cats-grid');
  if (!_portfolioCats.length) {
    grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Нет категорий. Нажмите «+ Новая категория».</div>';
    return;
  }
  grid.innerHTML = _portfolioCats.map(c => portfolioCatTile(c)).join('');
  initPortfolioCatDragDrop();
}

function portfolioCatTile(c) {
  const cover = c.coverPhotoUrl
    ? `<div style="width:100%;aspect-ratio:1;background:#f3f4f6 url('${_esc(c.coverPhotoUrl)}') center/cover;border-radius:10px"></div>`
    : `<div style="width:100%;aspect-ratio:1;background:#f3f4f6;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#d1d5db;font-size:32px">🖼️</div>`;
  const hiddenBadge = !c.isPublished ? '<div style="font-size:10px;color:#f59e0b;margin-top:4px">Скрыто</div>' : '';
  return `
    <div draggable="true" data-portfolio-cat-id="${c.id}" style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;cursor:pointer;transition:box-shadow .15s,opacity .15s;position:relative;background:#fff" onclick="openPortfolioCategory(${c.id})" onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.10)'" onmouseout="this.style.boxShadow=''">
      <div style="position:absolute;top:8px;left:8px;cursor:grab;color:#d1d5db;font-size:14px;line-height:1;user-select:none">⠿</div>
      ${cover}
      <div style="font-weight:600;font-size:13px;margin-top:8px">${_esc(c.title || '—')}</div>
      <div style="font-size:11px;color:#9ca3af">${c.itemsCount || 0} работ</div>
      ${hiddenBadge}
    </div>`;
}

// ── Drag-drop reorder for categories ──────────────────────────
function initPortfolioCatDragDrop() {
  const grid = document.getElementById('portfolio-cats-grid');
  if (!grid) return;
  let dragSrc = null;
  grid.querySelectorAll('[data-portfolio-cat-id]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragSrc = card; _portfolioCatWasDragging = true;
      card.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      grid.querySelectorAll('[data-portfolio-cat-id]').forEach(c => c.style.outline = '');
      setTimeout(() => { _portfolioCatWasDragging = false; }, 50);
    });
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    card.addEventListener('dragenter', e => {
      e.preventDefault();
      if (card !== dragSrc) card.style.outline = '2px dashed #6366f1';
    });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); card.style.outline = '';
      if (!dragSrc || dragSrc === card) return;
      const cards = [...grid.querySelectorAll('[data-portfolio-cat-id]')];
      const srcIdx = cards.indexOf(dragSrc);
      const dstIdx = cards.indexOf(card);
      if (srcIdx < dstIdx) grid.insertBefore(dragSrc, card.nextSibling);
      else grid.insertBefore(dragSrc, card);
      const order = [...grid.querySelectorAll('[data-portfolio-cat-id]')].map((el, i) => ({
        id: parseInt(el.dataset.portfolioCatId), display_order: i,
      }));
      try {
        await api('PUT', '/api/portfolio/categories/reorder', { order });
        notify('Порядок сохранён', 'ok');
      } catch (err) { notify('Ошибка: ' + err.message, 'err'); }
    });
  });
}

// ── Create / edit category modal ──────────────────────────────
function openPortfolioCategoryCreate() {
  _portfolioCatModalMode = 'create';
  document.getElementById('portfolio-cat-modal-title').textContent = 'Новая категория';
  document.getElementById('portfolio-cat-title-input').value = '';
  document.getElementById('portfolio-cat-cover-input').value = '';
  document.getElementById('portfolio-cat-cover-preview').innerHTML = 'Нет фото';
  document.getElementById('portfolio-cat-publish-wrap').style.display = 'none';
  document.getElementById('portfolio-cat-status').textContent = '';
  document.getElementById('portfolio-cat-modal').style.display = 'flex';
}

function openPortfolioCategoryEdit() {
  if (!_portfolioCurrentCat) return;
  _portfolioCatModalMode = 'edit';
  const c = _portfolioCurrentCat;
  document.getElementById('portfolio-cat-modal-title').textContent = 'Редактировать категорию';
  document.getElementById('portfolio-cat-title-input').value = c.title || '';
  document.getElementById('portfolio-cat-cover-input').value = '';
  const preview = document.getElementById('portfolio-cat-cover-preview');
  preview.innerHTML = c.coverPhotoUrl
    ? `<img src="${_esc(c.coverPhotoUrl)}" style="width:100%;height:100%;object-fit:cover">`
    : 'Нет фото';
  const pubWrap = document.getElementById('portfolio-cat-publish-wrap');
  pubWrap.style.display = 'block';
  document.getElementById('portfolio-cat-published').checked = !!c.isPublished;
  document.getElementById('portfolio-cat-status').textContent = '';
  document.getElementById('portfolio-cat-modal').style.display = 'flex';
}

function closePortfolioCategoryModal() {
  document.getElementById('portfolio-cat-modal').style.display = 'none';
}

async function savePortfolioCategory() {
  const status = document.getElementById('portfolio-cat-status');
  const title = document.getElementById('portfolio-cat-title-input').value.trim();
  if (!title) { status.style.color = '#ef4444'; status.textContent = 'Введите название'; return; }
  const file = document.getElementById('portfolio-cat-cover-input').files[0];

  try {
    let id;
    if (_portfolioCatModalMode === 'create') {
      if (!file) { status.style.color = '#ef4444'; status.textContent = 'Загрузите обложку'; return; }
      status.style.color = '#6b7280'; status.textContent = 'Создание...';
      const r = await api('POST', '/api/portfolio/categories', { title });
      id = r.id;
      await uploadPortfolioCover(id, file);
    } else {
      id = _portfolioCurrentCat.id;
      const isPublished = document.getElementById('portfolio-cat-published').checked;
      status.style.color = '#6b7280'; status.textContent = 'Сохранение...';
      await api('PUT', `/api/portfolio/categories/${id}`, { title, isPublished });
      if (file) await uploadPortfolioCover(id, file);
    }
    closePortfolioCategoryModal();
    notify('Сохранено', 'ok');
    await loadPortfolioCategories();
  } catch (e) {
    status.style.color = '#ef4444'; status.textContent = e.message;
  }
}

async function uploadPortfolioCover(categoryId, file) {
  const fd = new FormData();
  fd.append('photo', file);
  const tok = localStorage.getItem('lp_tk');
  const r = await fetch(`/api/portfolio/categories/${categoryId}/cover`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Ошибка загрузки обложки');
  return d.url;
}

// ── Drill-in to Level 2 ───────────────────────────────────────
function openPortfolioCategory(catId) {
  if (_portfolioCatWasDragging) return;
  const c = _portfolioCats.find(x => x.id === catId);
  if (!c) return;
  _portfolioCurrentCat = c;
  document.getElementById('portfolio-cats-view').style.display = 'none';
  document.getElementById('portfolio-items-view').style.display = 'block';
  document.getElementById('portfolio-cat-title').textContent = c.title;
  loadPortfolioItems(); // implemented in Task 12
}

let _portfolioItems = [];
let _portfolioItemModalMode = null;     // 'create' | 'edit'
let _portfolioEditingItemId = null;
let _portfolioStaffOptions = [];
let _portfolioItemWasDragging = false;
let _portfolioPendingBeforeDeletion = false;

async function loadPortfolioItems() {
  if (!_portfolioCurrentCat) return;
  const grid = document.getElementById('portfolio-items-grid');
  grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Загрузка...</div>';
  try {
    const data = await api('GET', `/api/portfolio/categories/${_portfolioCurrentCat.id}/items`);
    _portfolioItems = data.items || [];
    renderPortfolioItems();
  } catch (e) {
    grid.innerHTML = `<div style="color:#ef4444">Ошибка: ${_esc(e.message)}</div>`;
  }
}

function renderPortfolioItems() {
  const grid = document.getElementById('portfolio-items-grid');
  if (!_portfolioItems.length) {
    grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Работ пока нет. Нажмите «+ Добавить работу».</div>';
    return;
  }
  grid.innerHTML = _portfolioItems.map(it => portfolioItemTile(it)).join('');
  initPortfolioItemDragDrop();
}

function portfolioItemTile(it) {
  const cover = it.photoAfterUrl
    ? `<div style="width:100%;aspect-ratio:3/4;background:#f3f4f6 url('${_esc(it.photoAfterUrl)}') center/cover;border-radius:10px"></div>`
    : `<div style="width:100%;aspect-ratio:3/4;background:#f3f4f6;border-radius:10px"></div>`;
  const staffBadge = it.staffName ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">👤 ${_esc(it.staffName)}</div>` : '';
  const beforeBadge = it.photoBeforeUrl ? '<span style="display:inline-block;padding:2px 6px;background:#eef2ff;color:#4f46e5;border-radius:4px;font-size:10px;margin-left:4px">До+После</span>' : '';
  return `
    <div draggable="true" data-portfolio-item-id="${it.id}" style="border:1px solid #e5e7eb;border-radius:12px;padding:10px;cursor:pointer;transition:box-shadow .15s,opacity .15s;position:relative;background:#fff" onclick="openPortfolioItemEdit(${it.id})" onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.10)'" onmouseout="this.style.boxShadow=''">
      <div style="position:absolute;top:6px;left:6px;cursor:grab;color:#d1d5db;font-size:14px;user-select:none">⠿</div>
      ${cover}
      <div style="font-weight:600;font-size:13px;margin-top:8px">${_esc(it.title)}${beforeBadge}</div>
      ${staffBadge}
    </div>`;
}

function initPortfolioItemDragDrop() {
  const grid = document.getElementById('portfolio-items-grid');
  if (!grid) return;
  let dragSrc = null;
  grid.querySelectorAll('[data-portfolio-item-id]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragSrc = card; _portfolioItemWasDragging = true;
      card.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      grid.querySelectorAll('[data-portfolio-item-id]').forEach(c => c.style.outline = '');
      setTimeout(() => { _portfolioItemWasDragging = false; }, 50);
    });
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    card.addEventListener('dragenter', e => {
      e.preventDefault();
      if (card !== dragSrc) card.style.outline = '2px dashed #6366f1';
    });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); card.style.outline = '';
      if (!dragSrc || dragSrc === card) return;
      const cards = [...grid.querySelectorAll('[data-portfolio-item-id]')];
      const srcIdx = cards.indexOf(dragSrc);
      const dstIdx = cards.indexOf(card);
      if (srcIdx < dstIdx) grid.insertBefore(dragSrc, card.nextSibling);
      else grid.insertBefore(dragSrc, card);
      const order = [...grid.querySelectorAll('[data-portfolio-item-id]')].map((el, i) => ({
        id: parseInt(el.dataset.portfolioItemId), display_order: i,
      }));
      try {
        await api('PUT', '/api/portfolio/items/reorder', { order });
        notify('Порядок сохранён', 'ok');
      } catch (err) { notify('Ошибка: ' + err.message, 'err'); }
    });
  });
}

// ── Item modal ────────────────────────────────────────────────
async function ensurePortfolioStaffOptions() {
  if (_portfolioStaffOptions.length) return;
  try {
    const data = await api('GET', '/api/staff-profiles');
    _portfolioStaffOptions = (data.staff || []).filter(s => s.is_active);
  } catch (e) { _portfolioStaffOptions = []; }
}

function fillPortfolioStaffSelect(selectedId) {
  const sel = document.getElementById('portfolio-item-staff-select');
  sel.innerHTML = '<option value="">— Не указан —</option>' +
    _portfolioStaffOptions.map(s =>
      `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${_esc(s.name)}</option>`
    ).join('');
}

async function openPortfolioItemCreate() {
  _portfolioItemModalMode = 'create';
  _portfolioEditingItemId = null;
  _portfolioPendingBeforeDeletion = false;
  document.getElementById('portfolio-item-modal-title').textContent = 'Новая работа';
  document.getElementById('portfolio-item-title-input').value = '';
  document.getElementById('portfolio-item-desc-input').value = '';
  document.getElementById('portfolio-item-after-input').value = '';
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-after-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-clear').style.display = 'none';
  document.getElementById('portfolio-item-delete-btn').style.display = 'none';
  document.getElementById('portfolio-item-status').textContent = '';
  await ensurePortfolioStaffOptions();
  fillPortfolioStaffSelect(null);
  document.getElementById('portfolio-item-modal').style.display = 'flex';
}

async function openPortfolioItemEdit(itemId) {
  if (_portfolioItemWasDragging) return;
  const it = _portfolioItems.find(x => x.id === itemId);
  if (!it) return;
  _portfolioItemModalMode = 'edit';
  _portfolioEditingItemId = itemId;
  _portfolioPendingBeforeDeletion = false;
  document.getElementById('portfolio-item-modal-title').textContent = 'Редактировать работу';
  document.getElementById('portfolio-item-title-input').value = it.title || '';
  document.getElementById('portfolio-item-desc-input').value = it.description || '';
  document.getElementById('portfolio-item-after-input').value = '';
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-after-preview').style.backgroundImage =
    it.photoAfterUrl ? `url('${it.photoAfterUrl}')` : '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage =
    it.photoBeforeUrl ? `url('${it.photoBeforeUrl}')` : '';
  document.getElementById('portfolio-item-before-clear').style.display = it.photoBeforeUrl ? 'inline-block' : 'none';
  document.getElementById('portfolio-item-delete-btn').style.display = 'inline-block';
  document.getElementById('portfolio-item-status').textContent = '';
  await ensurePortfolioStaffOptions();
  fillPortfolioStaffSelect(it.staffId);
  document.getElementById('portfolio-item-modal').style.display = 'flex';
}

function closePortfolioItemModal() {
  document.getElementById('portfolio-item-modal').style.display = 'none';
  _portfolioEditingItemId = null;
}

function clearPortfolioItemBefore() {
  // mark for backend deletion at save time, and clear preview now
  _portfolioPendingBeforeDeletion = true;
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-clear').style.display = 'none';
}

async function savePortfolioItem() {
  const status = document.getElementById('portfolio-item-status');
  const title = document.getElementById('portfolio-item-title-input').value.trim();
  if (!title) { status.style.color = '#ef4444'; status.textContent = 'Введите заголовок'; return; }
  const description = document.getElementById('portfolio-item-desc-input').value;
  const staffId = document.getElementById('portfolio-item-staff-select').value || null;
  const fAfter  = document.getElementById('portfolio-item-after-input').files[0];
  const fBefore = document.getElementById('portfolio-item-before-input').files[0];

  try {
    if (_portfolioItemModalMode === 'create') {
      if (!fAfter) { status.style.color = '#ef4444'; status.textContent = 'Загрузите фото «после»'; return; }
      status.style.color = '#6b7280'; status.textContent = 'Создание...';
      const fd = new FormData();
      fd.append('category_id', _portfolioCurrentCat.id);
      fd.append('title', title);
      fd.append('description', description);
      if (staffId) fd.append('staff_id', staffId);
      fd.append('after', fAfter);
      if (fBefore) fd.append('before', fBefore);
      const tok = localStorage.getItem('lp_tk');
      const r = await fetch('/api/portfolio/items', {
        method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Ошибка');
    } else {
      // edit: text fields + (optional) replace photos + (optional) delete before
      status.style.color = '#6b7280'; status.textContent = 'Сохранение...';
      await api('PUT', `/api/portfolio/items/${_portfolioEditingItemId}`, {
        title, description, staffId,
      });
      if (_portfolioPendingBeforeDeletion) {
        await api('DELETE', `/api/portfolio/items/${_portfolioEditingItemId}/before`);
      }
      if (fAfter || fBefore) {
        const fd = new FormData();
        if (fAfter)  fd.append('after',  fAfter);
        if (fBefore) fd.append('before', fBefore);
        const tok = localStorage.getItem('lp_tk');
        const r = await fetch(`/api/portfolio/items/${_portfolioEditingItemId}/photos`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Ошибка загрузки фото');
      }
    }
    closePortfolioItemModal();
    notify('Сохранено', 'ok');
    await loadPortfolioItems();
  } catch (e) {
    status.style.color = '#ef4444'; status.textContent = e.message;
  }
}

async function deletePortfolioItemConfirm() {
  if (!_portfolioEditingItemId) return;
  if (!confirm('Удалить работу безвозвратно?')) return;
  try {
    await api('DELETE', `/api/portfolio/items/${_portfolioEditingItemId}`);
    closePortfolioItemModal();
    notify('Удалено', 'ok');
    await loadPortfolioItems();
  } catch (e) { notify(e.message, 'err'); }
}
async function deletePortfolioCategoryConfirm() {
  if (!_portfolioCurrentCat) return;
  if (!confirm(`Удалить категорию «${_portfolioCurrentCat.title}» и все работы?`)) return;
  try {
    await api('DELETE', `/api/portfolio/categories/${_portfolioCurrentCat.id}`);
    notify('Удалено', 'ok');
    await loadPortfolioCategories();
  } catch (e) { notify(e.message, 'err'); }
}

// expose to inline onclick handlers
window.loadPortfolioCategories = loadPortfolioCategories;
window.openPortfolioCategoryCreate = openPortfolioCategoryCreate;
window.openPortfolioCategoryEdit = openPortfolioCategoryEdit;
window.openPortfolioCategory = openPortfolioCategory;
window.closePortfolioCategoryModal = closePortfolioCategoryModal;
window.savePortfolioCategory = savePortfolioCategory;
window.deletePortfolioCategoryConfirm = deletePortfolioCategoryConfirm;
window.openPortfolioItemCreate = openPortfolioItemCreate;
window.openPortfolioItemEdit = openPortfolioItemEdit;
window.closePortfolioItemModal = closePortfolioItemModal;
window.savePortfolioItem = savePortfolioItem;
window.clearPortfolioItemBefore = clearPortfolioItemBefore;
window.deletePortfolioItemConfirm = deletePortfolioItemConfirm;

// Auto-load when the user navigates to the Портфолио menu entry. We use a
// click listener instead of patching navStg because navStg only toggles
// visibility — it doesn't have a per-section loader hook.
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-sec="portfolio"]');
  if (target) loadPortfolioCategories();
});
