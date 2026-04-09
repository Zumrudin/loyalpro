// ── SETTINGS PAGE ──────────────────────────────────────────────
// Зависимости: api(), notify(), avc(), avi()
// Включает: Loyalty Settings + Template Settings

// ── Loyalty Settings ───────────────────────────────────────────
async function loadLs() {
  try { lsData = await api('GET', '/api/loyalty-settings'); renderLvlEditor(); populateLsForm(); } catch {}
}

function renderLvlEditor() {
  const el = document.getElementById('lvlEditor'); if (!el) return;
  el.innerHTML = (lsData.levels || []).map((l, i) => `
    <div style="border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:flex;gap:8px;margin-bottom:9px">
        <input type="text" value="${l.emoji || ''}" style="width:42px;font-size:17px;text-align:center" id="le_${i}">
        <input type="text" value="${l.name || ''}" style="flex:1;font-weight:600" id="ln_${i}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><label class="fl" style="font-size:10px">Мин. покупки ₽</label><input type="number" value="${l.minSpent || 0}" id="lm_${i}"></div>
        <div><label class="fl" style="font-size:10px">Кэшбэк %</label><input type="number" value="${l.cashback || 0}" id="lc_${i}"></div>
        <div><label class="fl" style="font-size:10px">Макс. списание %</label><input type="number" value="${l.maxRedemptionPct || 30}" id="lx_${i}"></div>
      </div>
    </div>`).join('');
}

function populateLsForm() {
  const s = (id, v) => { const e = document.getElementById(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v !== undefined ? v : ''; } };
  s('ls-bonuses-on', lsData.bonuses_enabled !== false);
  s('ls-exp',        lsData.bonus_expiry_days || 0);
  s('ls-bd-on',      lsData.birthday_enabled !== false);
  s('ls-bd-bonus',   lsData.birthday_bonus || 500);
  s('ls-bd-days',    lsData.birthday_days_before || 3);
  s('ls-ref-on',     lsData.referral_enabled !== false);
  s('ls-ref-s',      lsData.referral_bonus_sender || 200);
  s('ls-ref-r',      lsData.referral_bonus_receiver || 150);
  updateBonusBanner();
}

function ltab(t, el) {
  ['levels','services','birthday','referral'].forEach(x => {
    const e = document.getElementById('lt-' + x);
    if (e) e.style.display = x === t ? 'block' : 'none';
  });
  document.querySelectorAll('#ltabs .tab').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  if (t === 'services') loadSvcCb();
  if (t === 'birthday') loadBdList();
}

async function loadSvcCb() {
  const el = document.getElementById('svcCb');
  try {
    if (!ycSvcs.length) ycSvcs = await api('GET', '/api/yclients/services');
    const sv  = lsData.service_cashback || {};
    const def = (lsData.levels?.[0]?.cashback) || 5;
    el.innerHTML = ycSvcs.slice(0, 40).map(s => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)">
        <div style="flex:1;font-size:13px">${s.title}</div>
        <input type="number" value="${sv[s.id] || def}" min="0" max="50" style="width:65px" id="sc_${s.id}">
        <span style="font-size:12px;color:var(--t3)">%</span>
      </div>`).join('');
  } catch(e) { el.innerHTML = `<div class="empty" style="color:var(--danger)">${e.message}</div>`; }
}

async function loadBdList() {
  const el = document.getElementById('bdList'); if (!el) return;
  try {
    const all = await api('GET', '/api/clients?limit=500');
    const now = new Date();
    const ups = (all.clients || []).filter(c => {
      if (!c.birthday) return false;
      const bd = new Date(c.birthday); if (isNaN(bd)) return false;
      const ty = new Date(now.getFullYear(), bd.getMonth(), bd.getDate());
      const diff = (ty - now) / 864e5;
      return diff >= -1 && diff <= 7;
    });
    if (!ups.length) { el.innerHTML = '<div class="empty">Нет именинников в ближайшие 7 дней</div>'; return; }
    el.innerHTML = ups.map(c => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)">
        <div class="av" style="background:${avc(c.name)};color:#fff;font-size:10px">${avi(c.name)}</div>
        <div style="flex:1"><div style="font-weight:600;font-size:13px">${c.name}</div><div style="font-size:11px;color:var(--t3)">${c.phone || '—'}</div></div>
        <button class="btn btn-pri btn-sm" onclick="sendBdB(${c.id})">🎁 Начислить</button>
      </div>`).join('');
  } catch(e) { el.innerHTML = `<div class="empty" style="color:var(--danger)">${e.message}</div>`; }
}

async function sendBdB(id) {
  const bonus = parseInt(document.getElementById('ls-bd-bonus')?.value) || 500;
  try {
    await api('POST', '/api/clients/' + id + '/bonus', {amount: bonus, description: '🎂 Подарок на день рождения'});
    notify('+' + bonus + ' бонусов!', 'ok');
    loadBdList();
  } catch(e) { notify(e.message, 'err'); }
}

async function saveLs() {
  const levels = (lsData.levels || []).map((l, i) => ({...l,
    emoji:           document.getElementById('le_' + i)?.value || l.emoji,
    name:            document.getElementById('ln_' + i)?.value || l.name,
    minSpent:        parseInt(document.getElementById('lm_' + i)?.value) || l.minSpent,
    cashback:        parseInt(document.getElementById('lc_' + i)?.value) || l.cashback,
    maxRedemptionPct:parseInt(document.getElementById('lx_' + i)?.value) || l.maxRedemptionPct,
  }));
  const sc = {}; ycSvcs.forEach(s => { const e = document.getElementById('sc_' + s.id); if (e) sc[s.id] = parseInt(e.value) || 5; });
  const g = id => document.getElementById(id);
  const payload = {
    levels, service_cashback: sc,
    bonuses_enabled:          g('ls-bonuses-on')?.checked !== false,
    birthday_enabled:         g('ls-bd-on')?.checked,
    birthday_bonus:           parseInt(g('ls-bd-bonus')?.value) || 500,
    birthday_days_before:     parseInt(g('ls-bd-days')?.value) || 3,
    referral_enabled:         g('ls-ref-on')?.checked,
    referral_bonus_sender:    parseInt(g('ls-ref-s')?.value) || 200,
    referral_bonus_receiver:  parseInt(g('ls-ref-r')?.value) || 150,
    bonus_expiry_days:        parseInt(g('ls-exp')?.value) || 0,
  };
  try { await api('PUT', '/api/loyalty-settings', payload); lsData = {...lsData, ...payload}; updateBonusBanner(); notify('Сохранено!', 'ok'); } catch(e) { notify(e.message, 'err'); }
}

function updateBonusBanner() {
  const on = document.getElementById('ls-bonuses-on')?.checked !== false;
  const banner = document.getElementById('bonuses-disabled-banner');
  if (banner) banner.style.display = on ? 'none' : 'flex';
}

// ── Template Settings ──────────────────────────────────────────
function syncColor(key) {
  const txt    = document.getElementById(`tmpl-${key}-txt`);
  const picker = document.getElementById(`tmpl-${key}`);
  if (!txt || !picker) return;
  const v = txt.value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) picker.value = v;
}

function setColorPair(key, value) {
  const picker = document.getElementById(`tmpl-${key}`);
  const txt    = document.getElementById(`tmpl-${key}-txt`);
  if (picker) picker.value = value || picker.value;
  if (txt)    txt.value    = value || '';
  if (picker && !picker._synced) {
    picker._synced = true;
    picker.addEventListener('input', () => { if (txt) txt.value = picker.value; });
  }
}

async function loadTemplateSettings() {
  try {
    const d = await api('GET', '/api/template-settings');
    const s = (id, v) => { const e = document.getElementById(id); if (e && v) e.value = v; };
    s('tmpl-line1',    d.template_logo_line1);
    s('tmpl-line2',    d.template_logo_line2);
    s('tmpl-subtitle', d.template_subtitle);
    s('tmpl-phone',    d.template_contact_phone);
    s('tmpl-web',      d.template_contact_web);
    s('tmpl-social',   d.template_contact_social);
    setColorPair('accent', d.template_accent_color || '#b8943e');
    setColorPair('bg',     d.template_bg_color     || '#faf0e6');
    setColorPair('text',   d.template_text_color   || '#2c2020');
    if (d.template_logo_url) {
      const el = document.getElementById('tmplLogoPreview');
      if (el) el.innerHTML = `<img src="${d.template_logo_url}" style="max-height:76px;max-width:100%;object-fit:contain">`;
    }
    if (d.template_wm_url) {
      const el = document.getElementById('tmplWmPreview');
      if (el) el.innerHTML = `<img src="${d.template_wm_url}" style="max-height:76px;max-width:100%;object-fit:contain">`;
    }
    ['accent','bg','text'].forEach(k => setColorPair(k, null));
  } catch(e) { /* silent */ }
}

async function saveTemplateSettings() {
  try {
    await api('PUT', '/api/template-settings', {
      template_logo_line1:     document.getElementById('tmpl-line1')?.value    || null,
      template_logo_line2:     document.getElementById('tmpl-line2')?.value    || null,
      template_subtitle:       document.getElementById('tmpl-subtitle')?.value || null,
      template_accent_color:   document.getElementById('tmpl-accent')?.value   || null,
      template_bg_color:       document.getElementById('tmpl-bg')?.value       || null,
      template_text_color:     document.getElementById('tmpl-text')?.value     || null,
      template_contact_phone:  document.getElementById('tmpl-phone')?.value    || null,
      template_contact_web:    document.getElementById('tmpl-web')?.value      || null,
      template_contact_social: document.getElementById('tmpl-social')?.value   || null,
    });
    const st = document.getElementById('tmplSaveStatus');
    if (st) { st.style.color = 'var(--a)'; st.textContent = '✓ Настройки сохранены'; setTimeout(() => st.textContent = '', 3000); }
  } catch(e) { notify(e.message, 'err'); }
}

async function uploadTemplateImage(type, input) {
  if (!input.files[0]) return;
  const fd  = new FormData();
  fd.append('file', input.files[0]);
  const tok = localStorage.getItem('lp_tk');
  const st  = document.getElementById('tmplSaveStatus');
  if (st) { st.style.color = 'var(--t3)'; st.textContent = 'Загрузка...'; }
  try {
    const r = await fetch(`/api/template-settings/upload/${type}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    const previewId = type === 'logo' ? 'tmplLogoPreview' : 'tmplWmPreview';
    const el = document.getElementById(previewId);
    if (el) el.innerHTML = `<img src="${d.url}?t=${Date.now()}" style="max-height:76px;max-width:100%;object-fit:contain">`;
    if (st) { st.style.color = 'var(--a)'; st.textContent = '✓ Изображение загружено'; setTimeout(() => st.textContent = '', 3000); }
  } catch(e) { notify(e.message, 'err'); if (st) st.textContent = ''; }
}

async function previewTemplateSettings() {
  try {
    const list  = await api('GET', '/api/home-care?limit=1');
    const first = list.rows?.[0] || list[0];
    if (!first) { notify('Нет назначений для предпросмотра. Создайте хотя бы одно.', 'err'); return; }
    const tok = localStorage.getItem('lp_tk');
    const r   = await fetch(`/api/home-care/${first.id}/preview`, { headers: { 'Authorization': `Bearer ${tok}` } });
    if (!r.ok) throw new Error('Ошибка предпросмотра');
    const html = await r.text();
    const blob = new Blob([html], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
  } catch(e) { notify(e.message, 'err'); }
}
