// ── HOME CARE PAGE ─────────────────────────────────────────────
// Зависимости: api(), notify(), esc(), escAttr(), TOKEN

let hcPage = 1, hcSearchTimer = null, hcEditId = null;

const HC_SECTIONS = {
  morning:    { label: '🌅 Утро',    cats: ['Очищение','Демакияж','Тонизация','Сыворотка','Крем для лица','Крем для век','SPF'] },
  evening:    { label: '🌙 Вечер',   cats: ['Очищение','Тонизация','Сыворотка','Крем для лица','Крем для век'] },
  additional: { label: '✨ Дополнительный уход', cats: ['Маски','Пилинги'] },
  sheet_face: { label: '👤 Лицо',    cats: ['Процедуры'] },
  sheet_body: { label: '💪 Тело',    cats: ['Процедуры'] },
  sheet_hair: { label: '💇 Волосы',  cats: ['Процедуры'] },
  vitamins:   { label: '💊 Витамины', cats: ['Препарат'] },
};

let HC_TEMPLATE = null;
async function loadHcTemplate() {
  try { HC_TEMPLATE = await api('GET', '/api/template-settings'); } catch(_) {}
}
async function loadHomeCare() { hcPage = 1; await Promise.all([hcFetch(), loadHcTemplate()]); }

async function hcFetch() {
  const search = document.getElementById('hcSearch')?.value || '';
  try {
    const d = await api('GET', `/api/home-care?search=${encodeURIComponent(search)}&page=${hcPage}&limit=20`);
    const tbody = document.getElementById('hcTbody');
    if (!d.rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Назначений не найдено</td></tr>';
    } else {
      tbody.innerHTML = d.rows.map(r => {
        const adh = r.adherence_pct;
        const adhText  = (adh === null || adh === undefined) ? '—' : `${adh}%`;
        const adhColor = (adh === null || adh === undefined) ? 'var(--t3)'
                      : adh >= 80 ? '#2e8b57'
                      : adh >= 50 ? '#c89c1e'
                      : '#c33';
        const fmtDateRu = (d) => d ? new Date(d).toLocaleDateString('ru') : '';
        const periodText = r.start_date
          ? `${fmtDateRu(r.start_date)} → ${r.end_date ? fmtDateRu(r.end_date) : 'бессрочно'}`
          : '—';
        const adhDisabled = (adh === null || adh === undefined) ? 'disabled' : '';
        return `
        <tr onclick="hcOpenEdit(${r.id})">
          <td>${new Date(r.created_at).toLocaleDateString('ru')}</td>
          <td><b>${esc(r.client_name || '—')}</b></td>
          <td style="color:var(--t3)">${esc(r.client_phone || '—')}</td>
          <td style="color:var(--t2)">${esc(r.specialist_name || '—')}${r.specialist_position ? `<br><span style="font-size:11px;color:var(--t3)">${esc(r.specialist_position)}</span>` : ''}</td>
          <td style="color:var(--t3);font-size:12px;white-space:nowrap">${esc(periodText)}</td>
          <td style="color:var(--t3);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.notes || '')}</td>
          <td style="color:${adhColor};font-weight:600;text-align:right;white-space:nowrap">${adhText}</td>
          <td onclick="event.stopPropagation()" style="text-align:right;white-space:nowrap">
            <button class="btn btn-sec btn-sm" onclick="openAdherenceModal(${r.id})" title="Heatmap выполнения" ${adhDisabled}>Подробно</button>
            <button class="btn btn-sec btn-sm" style="margin-left:4px" onclick="hcPrintById(${r.id})" title="Открыть превью">👁</button>
            <button class="btn btn-sec btn-sm" style="margin-left:4px" onclick="hcDownloadPdf(${r.id})" title="Скачать PDF">PDF</button>
            <button class="btn btn-sec btn-sm" style="margin-left:4px" onclick="hcOpenEdit(${r.id})">Изм.</button>
            <button class="btn btn-sec btn-sm btn-dng" style="margin-left:4px" onclick="hcDelete(${r.id})">Удалить</button>
          </td>
        </tr>`;
      }).join('');
    }
    const pager = document.getElementById('hcPager');
    const pages = Math.ceil(d.total / 20);
    pager.innerHTML = pages > 1
      ? `<span>Страница ${hcPage} из ${pages}</span>
         <button class="btn btn-sec btn-sm" ${hcPage <= 1 ? 'disabled' : ''} onclick="hcPage--;hcFetch()">←</button>
         <button class="btn btn-sec btn-sm" ${hcPage >= pages ? 'disabled' : ''} onclick="hcPage++;hcFetch()">→</button>
         <span style="margin-left:auto">Всего: ${d.total}</span>`
      : `<span style="margin-left:auto">Всего: ${d.total}</span>`;
  } catch(e) { notify('Ошибка: ' + e.message, 'err'); }
}

function hcSearchDebounce() {
  clearTimeout(hcSearchTimer);
  hcSearchTimer = setTimeout(() => { hcPage = 1; hcFetch(); }, 350);
}

function hcSwitchTab(tab, el) {
  document.querySelectorAll('.hc-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.hc-tab-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('hcPanel-' + tab)?.classList.add('active');
}

function hcOpenNew() {
  hcEditId = null;
  hcFillFormHeader(null);
  hcResetForm();
  document.querySelectorAll('.hc-tab')[0]?.click();
  document.getElementById('hcFormOv').classList.add('open');
}

function hcFillFormHeader(d) {
  const T = HC_TEMPLATE || {};
  const name  = (d?.salon_name || ME?.salonName || '');
  const parts = name.trim().split(/\s+/);

  const logoImg  = document.getElementById('hcFormLogoImg');
  const logoText = document.getElementById('hcFormLogoText');
  if (T.template_logo_url && logoImg && logoText) {
    logoImg.src = T.template_logo_url;
    logoImg.style.display  = 'inline-block';
    logoText.style.display = 'none';
  } else {
    if (logoImg)  logoImg.style.display  = 'none';
    if (logoText) logoText.style.display = '';
    const line1 = T.template_logo_line1 || parts[0] || 'PERI';
    const line2 = T.template_logo_line2 !== undefined ? T.template_logo_line2 : (parts.slice(1).join(' ') || 'CLINIC');
    document.getElementById('hcFormLogoLeft').textContent  = line1;
    document.getElementById('hcFormLogoRight').textContent = line2;
  }

  const sub = document.getElementById('hcFormSub');
  if (sub) sub.textContent = T.template_subtitle || d?.salon_name || 'Клиника Эстетической медицины';

  const box = document.getElementById('hcFormBox');
  if (box) {
    const accent = T.template_accent_color || '#c9a96e';
    const bg     = T.template_bg_color     || '#faf4ec';
    box.style.setProperty('--hc-gold',  accent);
    box.style.setProperty('--hc-cream', bg);
    box.style.background = bg;
    const divider = document.getElementById('hcFormDivider');
    if (divider) divider.style.background = accent;
    const header = document.getElementById('hcFormHeader');
    if (header) header.style.borderBottomColor = accent;
  }
}

async function hcOpenEdit(id) {
  try {
    const d = await api('GET', `/api/home-care/${id}`);
    hcEditId = id;
    document.getElementById('hcFormTitle').textContent = 'Редактировать назначение';
    hcResetForm();
    hcFillFormHeader(d);
    document.getElementById('hcClientSearch').value = d.client_name || '';
    document.getElementById('hcClientId').value     = d.client_id   || '';
    (d.items || []).forEach(it => {
      const isService = it.time_of_day.startsWith('sheet_');
      hcAddItem(it.time_of_day, it.category, it.product_name, it.instructions, isService, it.days_of_week || null);
    });
    document.getElementById('hcNotes').value = d.notes || '';
    // Populate course period fields
    const startEl = document.getElementById('hcStartDate');
    const endEl   = document.getElementById('hcEndDate');
    const openEl  = document.getElementById('hcOpenEnded');
    if (startEl) startEl.value = d.start_date ? String(d.start_date).slice(0, 10) : hcTodayIso();
    if (d.end_date) {
      if (endEl)  { endEl.value = String(d.end_date).slice(0, 10); endEl.disabled = false; }
      if (openEl) openEl.checked = false;
    } else {
      if (endEl)  { endEl.value = ''; endEl.disabled = true; }
      if (openEl) openEl.checked = true;
    }
    document.getElementById('hcFormOv').classList.add('open');
  } catch(e) { notify('Ошибка загрузки: ' + e.message, 'err'); }
}

function hcCloseForm() {
  document.getElementById('hcFormOv').classList.remove('open');
  const d = document.getElementById('hcClientDrop');
  if (d) d.style.display = 'none';
}

let _hcOpenEndedBound = false;
function hcInitPeriodHandlers() {
  if (_hcOpenEndedBound) return;
  const cb = document.getElementById('hcOpenEnded');
  const endEl = document.getElementById('hcEndDate');
  if (!cb || !endEl) return;
  cb.addEventListener('change', () => {
    if (cb.checked) {
      endEl.value = '';
      endEl.disabled = true;
    } else {
      endEl.disabled = false;
    }
  });
  _hcOpenEndedBound = true;
}

function hcTodayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function hcResetForm() {
  document.getElementById('hcClientSearch').value = '';
  document.getElementById('hcClientId').value     = '';
  document.getElementById('hcNotes').value        = '';
  document.querySelectorAll('#hcFormBox .hc-items').forEach(c => c.innerHTML = '');
  hcInitPeriodHandlers();
  const startEl = document.getElementById('hcStartDate');
  const endEl   = document.getElementById('hcEndDate');
  const openEl  = document.getElementById('hcOpenEnded');
  const errEl   = document.getElementById('hcPeriodError');
  if (startEl) startEl.value = hcTodayIso();
  if (endEl)   { endEl.value = ''; endEl.disabled = false; }
  if (openEl)  openEl.checked = false;
  if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
}

function hcAddItem(timeOfDay, category, product = '', instructions = '', isService = false, daysOfWeek = null) {
  const catId = `hcCat-${timeOfDay}-${category}`;
  const catEl = document.getElementById(catId);
  if (!catEl) return;
  const container = catEl.querySelector('.hc-items');
  const uid = 'hcac_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const row = document.createElement('div');
  row.className = 'hc-item';
  row.innerHTML = `
    <div class="hc-ac-wrap">
      <div style="display:flex;gap:4px">
        <input type="text" class="hc-ac-inp" placeholder="${isService ? 'Услуга / процедура...' : 'Название продукта...'}" value="${esc(product)}"
               autocomplete="off" data-field="product" data-uid="${uid}" data-service="${isService ? '1' : '0'}"
               oninput="hcAcSearch(this)" onfocus="hcAcSearch(this)" style="flex:1">
        <button type="button" class="hc-pick-btn" onclick="hcOpenPicker('${uid}',${isService})" title="Выбрать из каталога">☰</button>
      </div>
      <div class="hc-ac-drop" id="drop_${uid}"></div>
    </div>
    <input type="text" placeholder="Как применять, частота..." value="${esc(instructions)}" data-field="instructions">
    <button class="hc-item-del" onclick="this.closest('.hc-item').remove()" title="Удалить">✕</button>`;
  container.appendChild(row);

  const isHomecare = ['morning', 'evening', 'additional'].includes(timeOfDay);
  if (isHomecare) {
    const days = Array.isArray(daysOfWeek) ? daysOfWeek : null;
    const stripWrap = document.createElement('div');
    stripWrap.className = 'hc-days';
    stripWrap.dataset.field = 'days_of_week';
    const labels = [['Пн', 0], ['Вт', 1], ['Ср', 2], ['Чт', 3], ['Пт', 4], ['Сб', 5], ['Вс', 6]];
    stripWrap.innerHTML =
      labels.map(([label, idx]) => {
        const active = days === null || days.includes(idx);
        return `<button type="button" class="hc-day ${active ? 'active' : ''}" data-day="${idx}" aria-pressed="${active}">${label}</button>`;
      }).join('') +
      `<button type="button" class="hc-day-all" aria-label="Переключить все дни">Каждый день</button>`;
    stripWrap.querySelectorAll('.hc-day').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        btn.setAttribute('aria-pressed', btn.classList.contains('active'));
      });
    });
    stripWrap.querySelector('.hc-day-all').addEventListener('click', () => {
      const all = stripWrap.querySelectorAll('.hc-day');
      const allActive = [...all].every(b => b.classList.contains('active'));
      all.forEach(b => {
        b.classList.toggle('active', !allActive);
        b.setAttribute('aria-pressed', !allActive);
      });
    });
    row.appendChild(stripWrap);
  }

  row.querySelector('[data-field="product"]').focus();
}

async function hcAcSearch(inp) {
  const uid       = inp.dataset.uid;
  const isService = inp.dataset.service === '1';
  const q         = inp.value.trim();
  const drop      = document.getElementById('drop_' + uid);
  if (!drop) return;
  try {
    const endpoint = isService
      ? `/api/home-care/services?search=${encodeURIComponent(q)}&limit=10`
      : `/api/home-care/products?search=${encodeURIComponent(q)}&limit=10`;
    const rows = await fetch(endpoint, {headers: {'Authorization': 'Bearer ' + TOKEN}}).then(r => r.json());
    if (!Array.isArray(rows) || !rows.length) { drop.style.display = 'none'; return; }
    const rect = inp.getBoundingClientRect();
    drop.style.top   = (rect.bottom + 2) + 'px';
    drop.style.left  = rect.left + 'px';
    drop.style.width = rect.width + 'px';
    drop.innerHTML   = rows.map(r =>
      `<div class="hc-ac-opt" onmousedown="hcAcSelect(event,'${uid}','${escAttr(r.title)}')">${esc(r.title)}</div>`
    ).join('');
    drop.style.display = 'block';
  } catch { drop.style.display = 'none'; }
}

function hcAcSelect(e, uid, title) {
  e.preventDefault();
  const inp = document.querySelector(`[data-uid="${uid}"]`);
  if (inp) inp.value = title;
  const drop = document.getElementById('drop_' + uid);
  if (drop) drop.style.display = 'none';
}

// ── Catalog Picker ─────────────────────────────────────────────
let hcPickerUid = null, hcPickerIsService = false, hcPickerData = [];

async function hcOpenPicker(uid, isService) {
  hcPickerUid       = uid;
  hcPickerIsService = isService;
  document.getElementById('hcPickerTitle').textContent            = isService ? 'Выберите услугу' : 'Выберите продукт';
  document.getElementById('hcPickerSearch').value                 = '';
  document.getElementById('hcPickerSyncBtn').style.display        = isService ? 'none' : '';
  const body = document.getElementById('hcPickerBody');
  body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--t3)">Загрузка...</div>';
  document.getElementById('hcPickerOv').classList.add('open');
  try {
    const ep  = isService ? '/api/home-care/service-tree' : '/api/home-care/product-tree';
    hcPickerData = await api('GET', ep);
    hcPickerRender(hcPickerData);
  } catch(e) {
    body.innerHTML = `<div style="padding:20px;color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

async function hcSyncGoodsCategories() {
  const btn = document.getElementById('hcPickerSyncBtn');
  btn.disabled    = true;
  btn.textContent = '↻ Синхронизация...';
  try {
    const r  = await api('POST', '/api/home-care/sync-goods-categories');
    btn.textContent = `✓ ${r.updated} обновлено`;
    hcPickerData = await api('GET', '/api/home-care/product-tree');
    hcPickerRender(hcPickerData);
  } catch(e) {
    btn.textContent = 'Ошибка';
    alert('Ошибка синхронизации: ' + e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = '↻ Категории'; }, 3000);
  }
}

function hcPickerClose() {
  document.getElementById('hcPickerOv').classList.remove('open');
  hcPickerUid = null;
}

function hcPickerSearchFn(q) {
  if (!q) { hcPickerRender(hcPickerData); return; }
  const lq       = q.toLowerCase();
  const filtered = hcPickerData
    .map(g => ({cat: g.cat, items: g.items.filter(t => t.toLowerCase().includes(lq)), open: true}))
    .filter(g => g.items.length > 0);
  hcPickerRender(filtered);
}

function hcPickerRender(groups) {
  const body = document.getElementById('hcPickerBody');
  if (!groups || !groups.length) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--t3)">Ничего не найдено</div>';
    return;
  }
  body.innerHTML = groups.map((g, gi) => `
    <div>
      <div class="hc-picker-cat-hdr" onclick="hcPickerToggle(${gi})">
        <span style="font-size:12px;font-weight:700;color:var(--t2);letter-spacing:.4px">${esc(g.cat)}</span>
        <span id="hcPickChev-${gi}" style="font-size:11px;color:var(--t3)">${g.open === true ? '▼' : '▶'}</span>
      </div>
      <div id="hcPickGrp-${gi}" style="display:${g.open === true ? '' : 'none'}">
        ${g.items.map(t => `<div class="hc-picker-item" onclick="event.stopPropagation();hcPickerSelect('${escAttr(t)}')">${esc(t)}</div>`).join('')}
      </div>
    </div>`).join('');
}

function hcPickerToggle(gi) {
  const grp  = document.getElementById('hcPickGrp-' + gi);
  const chev = document.getElementById('hcPickChev-' + gi);
  if (!grp) return;
  const collapsed = grp.style.display === 'none';
  grp.style.display  = collapsed ? '' : 'none';
  chev.textContent   = collapsed ? '▼' : '▶';
}

function hcPickerSelect(title) {
  if (hcPickerUid) {
    const inp = document.querySelector(`[data-uid="${hcPickerUid}"]`);
    if (inp) inp.value = title;
  }
  hcPickerClose();
}

document.addEventListener('click', e => {
  if (!e.target.closest('.hc-ac-wrap')) {
    document.querySelectorAll('.hc-ac-drop').forEach(d => d.style.display = 'none');
  }
  if (!e.target.closest('.hc-client-wrap')) {
    const d = document.getElementById('hcClientDrop');
    if (d) d.style.display = 'none';
  }
});

function hcToggleSection(hd) {
  const body    = hd.nextElementSibling;
  const chevron = hd.querySelector('.hc-chevron');
  const collapsed = body.style.display === 'none';
  body.style.display       = collapsed ? '' : 'none';
  chevron.style.transform  = collapsed ? '' : 'rotate(-90deg)';
}

async function hcSearchClient(q) {
  const drop = document.getElementById('hcClientDrop');
  if (!q || q.length < 2) { drop.style.display = 'none'; return; }
  try {
    const d = await api('GET', `/api/clients?search=${encodeURIComponent(q)}&limit=6`);
    if (!d.clients?.length) { drop.style.display = 'none'; return; }
    drop.innerHTML = d.clients.map(c =>
      `<div class="hc-client-opt" onclick="hcSelectClient(${c.id},'${escAttr(c.name)}')">
        <b>${esc(c.name)}</b> <span style="color:var(--t3);font-size:12px">${esc(c.phone || '')}</span>
      </div>`).join('');
    drop.style.display = 'block';
  } catch { drop.style.display = 'none'; }
}

function hcSelectClient(id, name) {
  document.getElementById('hcClientId').value     = id;
  document.getElementById('hcClientSearch').value = name;
  document.getElementById('hcClientDrop').style.display = 'none';
}

function hcCollectItems() {
  const items = [];
  const collectDays = (rowEl) => {
    const stripWrap = rowEl.querySelector('[data-field="days_of_week"]');
    if (!stripWrap) return null;
    const active = [...stripWrap.querySelectorAll('.hc-day.active')]
      .map(b => parseInt(b.dataset.day, 10))
      .sort((a, b) => a - b);
    if (active.length === 0 || active.length === 7) return null;
    return active;
  };
  document.querySelectorAll('#hcFormBox .hc-cat').forEach(catEl => {
    const raw      = catEl.id.replace('hcCat-', '');
    const dashIdx  = raw.indexOf('-');
    const timeOfDay = raw.slice(0, dashIdx);
    const category  = raw.slice(dashIdx + 1);
    catEl.querySelectorAll('.hc-item').forEach(row => {
      const product = row.querySelector('[data-field="product"]').value.trim();
      if (!product) return;
      items.push({
        time_of_day: timeOfDay,
        category,
        product_name: product,
        instructions: row.querySelector('[data-field="instructions"]').value.trim(),
        days_of_week: collectDays(row),
      });
    });
  });
  return items;
}

async function hcSave() {
  const clientId = document.getElementById('hcClientId').value;
  const startDateEl = document.getElementById('hcStartDate');
  const endDateEl   = document.getElementById('hcEndDate');
  const openEndedEl = document.getElementById('hcOpenEnded');
  const startDate = startDateEl ? startDateEl.value : '';
  const endDate   = openEndedEl && openEndedEl.checked ? null : ((endDateEl && endDateEl.value) || null);
  const errEl = document.getElementById('hcPeriodError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (!startDate) {
    if (errEl) { errEl.textContent = 'Укажите дату начала курса'; errEl.style.display = 'block'; }
    return false;
  }
  if (endDate && endDate < startDate) {
    if (errEl) { errEl.textContent = 'Дата окончания не может быть раньше начала'; errEl.style.display = 'block'; }
    return false;
  }
  const body = {
    client_id: clientId ? parseInt(clientId) : null,
    notes:     document.getElementById('hcNotes').value.trim() || null,
    items:     hcCollectItems(),
    start_date: startDate,
    end_date:   endDate,
  };
  try {
    if (hcEditId) {
      await api('PUT', `/api/home-care/${hcEditId}`, body);
    } else {
      const r = await api('POST', '/api/home-care', body);
      hcEditId = r.id;
    }
    notify(hcEditId ? 'Назначение сохранено' : 'Назначение создано', 'ok');
    hcFetch();
    return true;
  } catch(e) { notify('Ошибка сохранения: ' + e.message, 'err'); return false; }
}

async function hcDelete(id) {
  if (!confirm('Удалить назначение?')) return;
  try {
    await api('DELETE', `/api/home-care/${id}`);
    notify('Удалено', 'ok');
    hcFetch();
  } catch(e) { notify('Ошибка: ' + e.message, 'err'); }
}

async function hcPrint() {
  const ok = await hcSave();
  if (!ok || !hcEditId) return;
  await hcPrintById(hcEditId);
}

async function hcPrintById(id) {
  const w = window.open(`/api/home-care/${id}/preview`, '_blank');
  if (!w) {
    try {
      const resp = await fetch(`/api/home-care/${id}/preview`, {headers: {'Authorization': 'Bearer ' + TOKEN}});
      const html = await resp.text();
      window.open(URL.createObjectURL(new Blob([html], {type: 'text/html'})), '_blank');
    } catch(e) { notify('Ошибка превью: ' + e.message, 'err'); }
    return;
  }
  w.close();
  try {
    const resp = await fetch(`/api/home-care/${id}/preview`, {headers: {'Authorization': 'Bearer ' + TOKEN}});
    const html = await resp.text();
    window.open(URL.createObjectURL(new Blob([html], {type: 'text/html; charset=utf-8'})), '_blank');
  } catch(e) { notify('Ошибка превью: ' + e.message, 'err'); }
}

async function hcDownloadPdf(id) {
  try {
    notify('Генерируем PDF…', 'ok');
    const resp = await fetch(`/api/home-care/${id}/pdf`, {headers: {'Authorization': 'Bearer ' + TOKEN}});
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({error: 'Ошибка сервера'}));
      throw new Error(err.error || 'HTTP ' + resp.status);
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'Домашний уход.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch(e) { notify('Ошибка PDF: ' + e.message, 'err'); }
}

function hcOpenPrintWindow(d) {
  const grouped = {};
  (d.items || []).forEach(it => {
    const k = it.time_of_day;
    if (!grouped[k]) grouped[k] = {};
    if (!grouped[k][it.category]) grouped[k][it.category] = [];
    grouped[k][it.category].push(it);
  });

  const catBlock = (catName, items) => {
    const rows = (items || []).map(it => `
      <div class="item-row">
        <div class="item-name">${esc(it.product_name)}</div>
        ${it.instructions ? `<div class="item-instr">${esc(it.instructions)}</div>` : ''}
      </div>`).join('') || '<div class="empty-slot"></div>';
    return `<div class="cat-block">
      <div class="cat-name"><span class="check">✓</span>${esc(catName)}</div>
      ${rows}
    </div>`;
  };

  const colSection = (timeOfDay, cats) =>
    cats.map(cat => catBlock(cat, (grouped[timeOfDay] || {})[cat] || [])).join('');

  const vitBlock = () => {
    const items = Object.values(grouped['vitamins'] || {}).flat();
    if (!items.length) return '';
    return `<div class="vit-section">
      <div class="section-title">Витамины и добавки</div>
      ${items.map(it => `<div class="item-row"><div class="item-name">${esc(it.product_name)}</div>${it.instructions ? `<div class="item-instr">${esc(it.instructions)}</div>` : ''}</div>`).join('')}
    </div>`;
  };

  const sheetBlock = () => {
    const areas  = [{key:'sheet_face',label:'Лицо'},{key:'sheet_body',label:'Тело'},{key:'sheet_hair',label:'Волосы'}];
    const filled = areas.filter(a => Object.keys(grouped[a.key] || {}).length > 0);
    if (!filled.length) return '';
    return `<div class="sheet-section">
      <div class="section-title">Лист назначения</div>
      <div class="sheet-grid">
        ${filled.map(a => {
          const items = Object.values(grouped[a.key]).flat();
          return `<div class="sheet-col">
            <div class="sheet-col-title">${esc(a.label)}</div>
            ${items.map(it => `<div class="item-row"><div class="item-name">${esc(it.product_name)}</div>${it.instructions ? `<div class="item-instr">${esc(it.instructions)}</div>` : ''}</div>`).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  };

  const addBlock = () => {
    const cats    = ['Маски','Пилинги'];
    const hasSome = cats.some(c => (grouped['additional'] || {})[c]?.length);
    if (!hasSome) return '';
    return `<div class="add-section">
      <div class="add-title">Дополнительный уход</div>
      <div class="add-grid">
        ${cats.map(cat => {
          const items = (grouped['additional'] || {})[cat] || [];
          return `<div>
            <div class="add-col-title">${esc(cat)}</div>
            ${items.map(it => `<div class="item-row"><div class="item-name">${esc(it.product_name)}</div>${it.instructions ? `<div class="item-instr">${esc(it.instructions)}</div>` : ''}</div>`).join('') || '<div class="empty-slot"></div>'}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  };

  const salonName  = esc(d.salon_name  || 'PERI CLINIC');
  const clientName = esc(d.client_name || '—');
  const date       = new Date(d.created_at).toLocaleDateString('ru', {day:'2-digit',month:'long',year:'numeric'});

  const morningCats = ['Очищение','Демакияж','Тонизация','Сыворотка','Крем для лица','Крем для век','SPF'];
  const eveningCats = ['Демакияж','Очищение','Тонизация','Сыворотка','Крем для лица','Крем для век'];
  const hasMorning  = morningCats.some(c => (grouped['morning'] || {})[c]?.length);
  const hasEvening  = eveningCats.some(c => (grouped['evening'] || {})[c]?.length);

  const lotusSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" style="width:100%;height:100%;opacity:1">
    <g fill="#c9a96e" fill-opacity="0.18">
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(-30 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(0 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(30 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(60 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(-60 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(90 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(-90 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(120 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(-120 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(150 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(-150 100 100)"/>
      <ellipse cx="100" cy="120" rx="15" ry="50" transform="rotate(180 100 100)"/>
      <circle cx="100" cy="100" r="12"/>
    </g>
  </svg>`;

  const html = `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Домашний уход — ${clientName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lora:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@page{size:A4;margin:10mm 12mm}
body{font-family:'Lora',Georgia,serif;background:#faf4ec;color:#2c2416;font-size:9.5pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{background:#faf4ec;min-height:100vh;padding:22px 26px;position:relative;overflow:hidden}
.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:420px;height:420px;pointer-events:none;z-index:0}
.content{position:relative;z-index:1}
.header{text-align:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1.5px solid #c9a96e}
.logo-row{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:3px}
.logo-word{font-family:'Playfair Display',serif;font-size:15pt;font-weight:700;color:#2c2416;letter-spacing:5px;text-transform:uppercase}
.logo-leaf{color:#c9a96e;font-size:18pt;line-height:1}
.clinic-sub{font-size:8pt;color:#9a8a6a;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase}
.doc-title{font-family:'Playfair Display',serif;font-size:20pt;font-weight:400;color:#2c2416;font-style:italic;margin-bottom:6px}
.gold-bar{width:50px;height:2px;background:#c9a96e;margin:0 auto 10px}
.client-line{font-size:10.5pt;color:#5a4a32;margin-bottom:4px}
.client-line b{font-style:italic}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-bottom:16px}
.col-title{font-family:'Playfair Display',serif;font-size:14pt;font-weight:600;color:#2c2416;border-bottom:1.5px solid #c9a96e;padding-bottom:4px;margin-bottom:12px}
.cat-block{margin-bottom:12px}
.cat-name{font-size:9pt;font-weight:700;color:#c9a96e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;display:flex;align-items:baseline;gap:5px}
.check{color:#c9a96e;font-weight:700;font-size:9.5pt}
.item-row{padding-left:14px;margin-bottom:2px}
.item-name{font-size:11.7pt;color:#2c2416;line-height:1.5;font-weight:500}
.item-instr{font-size:10.5pt;color:#7a6a55;font-style:italic;line-height:1.4}
.empty-slot{border-bottom:1px dashed rgba(201,169,110,.5);height:1px;margin:8px 0 10px 14px}
.add-section{padding-top:10px;border-top:1px solid #e8dcc8;margin-bottom:14px}
.add-title{font-family:'Playfair Display',serif;font-size:11pt;font-weight:600;color:#2c2416;margin-bottom:8px}
.add-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.add-col-title{font-size:9pt;font-weight:700;color:#c9a96e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.sheet-section{padding-top:12px;border-top:1.5px solid #c9a96e;margin-top:14px;margin-bottom:14px}
.section-title{font-family:'Playfair Display',serif;font-size:13pt;font-weight:600;color:#2c2416;margin-bottom:10px}
.sheet-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px}
.sheet-col-title{font-size:9pt;font-weight:700;color:#c9a96e;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #e8dcc8;padding-bottom:3px;margin-bottom:6px}
.vit-section{padding-top:12px;border-top:1px solid #e8dcc8;margin-top:10px;margin-bottom:14px}
.notes-block{padding:8px 12px;background:rgba(201,169,110,.08);border-left:3px solid #c9a96e;border-radius:3px;font-size:8.5pt;color:#5a4a32;margin-top:10px;font-style:italic}
.footer{margin-top:20px;padding-top:10px;border-top:1px solid #e8dcc8;display:flex;justify-content:space-between;align-items:flex-end;font-size:8pt;color:#a0907a}
.footer-sign{font-size:8.5pt;color:#5a4a32}
.footer-sign-line{border-bottom:1px solid #5a4a32;width:160px;display:inline-block;margin-left:6px;vertical-align:middle}
.no-print{position:fixed;bottom:20px;right:20px;display:flex;gap:8px;z-index:999}
@media print{.no-print{display:none!important}body{background:#faf4ec}}
</style>
</head><body>
<div class="page">
  <div class="watermark">${lotusSvg}</div>
  <div class="content">
    <div class="header">
      <div class="logo-row">
        <span class="logo-word">${salonName.includes(' ') ? salonName.split(' ')[0] : salonName}</span>
        <span class="logo-leaf">✿</span>
        <span class="logo-word">${salonName.includes(' ') ? salonName.split(' ').slice(1).join(' ') : 'CLINIC'}</span>
      </div>
      <div class="clinic-sub">Клиника Эстетической медицины</div>
      <div class="doc-title">Домашний уход</div>
      <div class="gold-bar"></div>
      <div class="client-line">Имя: <b>${clientName}</b></div>
    </div>
    ${(hasMorning || hasEvening) ? `<div class="two-col">
      <div><div class="col-title">Утро</div>${colSection('morning', morningCats)}</div>
      <div><div class="col-title">Вечер</div>${colSection('evening', eveningCats)}</div>
    </div>` : ''}
    ${addBlock()}
    ${sheetBlock()}
    ${vitBlock()}
    ${d.notes ? `<div class="notes-block">${esc(d.notes)}</div>` : ''}
    <div class="footer">
      <div>${salonName}</div>
      <div class="footer-sign">Подпись специалиста:<span class="footer-sign-line"></span></div>
    </div>
  </div>
</div>
<div class="no-print">
  <button onclick="window.print()" style="background:#c9a96e;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600;font-family:Georgia,serif">Печать / PDF</button>
  <button onclick="window.close()" style="background:#f5ece0;color:#5a4a32;border:1px solid #e8dcc8;padding:10px 16px;border-radius:8px;font-size:13px;cursor:pointer">Закрыть</button>
</div>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=750');
  if (w) { w.document.write(html); w.document.close(); }
  else notify('Разрешите всплывающие окна в браузере', 'err');
}

async function openAdherenceModal(prescriptionId) {
  const url = `/api/home-care/${prescriptionId}/adherence-history`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      notify('Не удалось загрузить данные выполнения', 'err');
      return;
    }
    const data = await res.json();
    renderAdherenceModal(data, prescriptionId);
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

function renderAdherenceModal(data, prescriptionId) {
  // Remove any previous instance
  const old = document.getElementById('hcAdherenceModal');
  if (old) old.remove();

  const pr = data.prescription;
  const totalExpected  = data.days.reduce((a, d) => a + d.expected, 0);
  const totalCompleted = data.days.reduce((a, d) => a + d.completed, 0);
  const pct = totalExpected === 0 ? null : Math.round((100 * totalCompleted) / totalExpected);

  // Group days into weeks starting on Monday of the week containing start_date
  const start = new Date(pr.start_date);
  const startOfWeek = new Date(start);
  const isodow = (start.getDay() + 6) % 7;     // 0=Mon..6=Sun
  startOfWeek.setDate(start.getDate() - isodow);
  const dayMap = {};
  data.days.forEach(d => {
    const key = String(d.date).slice(0, 10);
    dayMap[key] = d;
  });

  const today = new Date(); today.setHours(0,0,0,0);
  const endRender = pr.end_date ? new Date(pr.end_date) : today;
  endRender.setHours(0,0,0,0);
  const lastRender = endRender < today ? endRender : today;

  const startDay = new Date(start); startDay.setHours(0,0,0,0);

  const weeks = [];
  for (let cur = new Date(startOfWeek); cur <= lastRender; cur.setDate(cur.getDate() + 7)) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cur); d.setDate(cur.getDate() + i);
      // Build local YYYY-MM-DD (avoid UTC drift)
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const ds = `${d.getFullYear()}-${m}-${day}`;
      const inCourse = d >= startDay && d <= lastRender;
      week.push(inCourse ? (dayMap[ds] || { date: ds, expected: 0, completed: 0 }) : null);
    }
    weeks.push(week);
  }

  const cellColor = (cell) => {
    if (!cell) return 'transparent';
    if (cell.expected === 0)  return '#e6e2dc';
    const ratio = cell.completed / cell.expected;
    if (ratio === 0)   return '#f4d4d4';
    if (ratio < 0.5)   return '#f4e4b6';
    if (ratio < 1)     return '#f0c98a';
    return '#bee0bf';
  };

  const fmt = (d) => new Date(d).toLocaleDateString('ru');

  const modal = document.createElement('div');
  modal.id = 'hcAdherenceModal';
  modal.className = 'hc-modal-overlay';
  modal.innerHTML = `
    <div class="hc-modal">
      <button class="hc-modal-close" type="button" aria-label="Закрыть">×</button>
      <div class="hc-modal-header">
        <div>Назначение № ${pr.id}</div>
        <div class="hc-modal-sub">
          Курс: ${fmt(pr.start_date)} → ${pr.end_date ? fmt(pr.end_date) : 'бессрочно'}
          · Пунктов: ${pr.items_count}
        </div>
        <div class="hc-modal-sub">
          Выполнено: <b>${pct === null ? '—' : pct + '%'}</b> (${totalCompleted} из ${totalExpected})
        </div>
      </div>

      <div class="hc-cal-header">
        ${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="hc-cal-grid">
        ${weeks.map(w => w.map(c => `
          <div class="hc-cal-cell"
               data-date="${c ? c.date : ''}"
               style="background:${cellColor(c)};${c ? 'cursor:pointer' : ''}"
               title="${c ? `${fmt(c.date)} · ${c.completed}/${c.expected}` : ''}">
          </div>
        `).join('')).join('')}
      </div>

      <div class="hc-cal-legend">
        <span><i style="background:#e6e2dc"></i> нет назначений</span>
        <span><i style="background:#f4d4d4"></i> 0%</span>
        <span><i style="background:#f4e4b6"></i> &lt;50%</span>
        <span><i style="background:#f0c98a"></i> &lt;100%</span>
        <span><i style="background:#bee0bf"></i> 100%</span>
      </div>

      <div id="hcDayDetail" class="hc-day-detail" style="display:none;"></div>
    </div>
  `;

  // Close handlers
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector('.hc-modal-close').addEventListener('click', () => modal.remove());
  function onEsc(ev) {
    if (ev.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', onEsc);
    }
  }
  document.addEventListener('keydown', onEsc);

  // Click on a day cell → fetch items_for_day
  modal.querySelectorAll('.hc-cal-cell').forEach(el => {
    if (!el.dataset.date) return;
    el.addEventListener('click', async () => {
      const date = el.dataset.date;
      try {
        const r = await fetch(
          `/api/home-care/${prescriptionId}/adherence-history?date=${date}`,
          { headers: { Authorization: `Bearer ${TOKEN}` } }
        );
        if (!r.ok) return;
        const d = await r.json();
        const detail = document.getElementById('hcDayDetail');
        const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '';
        const sectionLabel = (s) => ({ morning: 'Утро', evening: 'Вечер', additional: 'Доп.' }[s] || s);
        const items = (d.items_for_day || []);
        detail.innerHTML = `
          <h4>День: ${fmt(date)}</h4>
          ${items.length === 0 ? '<div class="hc-day-empty">На этот день не было назначений</div>'
            : items.map(item => `
              <div class="hc-day-item">
                <span class="hc-day-section">${sectionLabel(item.time_of_day)}</span>
                <span class="hc-day-name">${esc(item.product_name)}</span>
                <span class="hc-day-status" style="color:${item.completed ? '#2e8b57' : '#c33'}">
                  ${item.completed ? '✓ ' + fmtTime(item.completed_at) : '✗ Не выполнено'}
                </span>
              </div>
            `).join('')}
        `;
        detail.style.display = 'block';
      } catch (e) {
        notify('Ошибка загрузки дня: ' + e.message, 'err');
      }
    });
  });

  document.body.appendChild(modal);
}
