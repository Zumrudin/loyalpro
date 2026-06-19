// frontend/js/pages/medical-cert.js
// Зависимости: api(), notify(), esc(), escAttr()

// Поля формы: [key, label, авто?]. Авто-поля подтягиваются из /defaults.
const MC_FIELDS = [
  ['cert_number', 'Номер справки', false],
  ['correction_number', 'Номер корректировки', false],
  ['report_year', 'Отчётный год', true],
  ['org_name', 'Наименование организации', true],
  ['org_inn', 'ИНН организации', true],
  ['org_kpp', 'КПП организации', true],
  ['payer_last', 'Фамилия налогоплательщика', true],
  ['payer_first', 'Имя', true],
  ['payer_middle', 'Отчество', true],
  ['payer_inn', 'ИНН налогоплательщика', false],
  ['payer_birthdate', 'Дата рождения (ГГГГ-ММ-ДД)', false],
  ['doc_type_code', 'Код вида документа', false],
  ['doc_serie_number', 'Серия и номер', false],
  ['doc_issue_date', 'Дата выдачи (ГГГГ-ММ-ДД)', false],
  ['amount1', 'Сумма код «1», ₽', false],
  ['amount2', 'Сумма код «2», ₽', false],
  ['signer_last', 'Фамилия подписанта', true],
  ['signer_first', 'Имя подписанта', true],
  ['signer_middle', 'Отчество подписанта', true],
  ['sign_date', 'Дата справки (ГГГГ-ММ-ДД)', false],
];

const MC_PATIENT_FIELDS = [
  ['patient_last', 'Пациент: Фамилия'],
  ['patient_first', 'Пациент: Имя'],
  ['patient_middle', 'Пациент: Отчество'],
  ['patient_inn', 'Пациент: ИНН'],
  ['patient_birthdate', 'Пациент: дата рождения (ГГГГ-ММ-ДД)'],
  ['patient_doc_type', 'Пациент: код вида документа'],
  ['patient_doc_serie', 'Пациент: серия и номер'],
  ['patient_doc_date', 'Пациент: дата выдачи (ГГГГ-ММ-ДД)'],
];

function mcInput(key, label) {
  return `<div class="fg"><label class="fl">${label}</label><input id="mc-f-${key}"></div>`;
}

function loadMedicalCert() {
  const form = document.getElementById('mc-form');
  let html = MC_FIELDS.map(([k, l]) => mcInput(k, l)).join('');
  html += `<div class="fg" style="grid-column:1/3"><label class="fl">
    <input type="checkbox" id="mc-f-payer_is_patient" checked onchange="mcTogglePatient()"> Налогоплательщик и пациент — одно лицо</label></div>`;
  html += `<div id="mc-patient-block" style="display:none;grid-column:1/3">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">` +
    MC_PATIENT_FIELDS.map(([k, l]) => mcInput(k, l)).join('') + `</div></div>`;
  form.innerHTML = html;
  // Дата формирования справки по умолчанию — сегодня (ГГГГ-ММ-ДД).
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const sd = document.getElementById('mc-f-sign_date');
  if (sd) sd.value = today;
  mcLoadTemplateMeta();
}

function mcTogglePatient() {
  const same = document.getElementById('mc-f-payer_is_patient').checked;
  document.getElementById('mc-patient-block').style.display = same ? 'none' : 'block';
}

let mcSearchTimer = null;
function mcSearchClients() {
  clearTimeout(mcSearchTimer);
  mcSearchTimer = setTimeout(async () => {
    const q = document.getElementById('mc-client-search').value.trim();
    if (q.length < 2) { document.getElementById('mc-client-results').innerHTML = ''; return; }
    try {
      const rows = await api('GET', '/api/clients?search=' + encodeURIComponent(q) + '&limit=8');
      const list = Array.isArray(rows) ? rows : (rows.items || rows.clients || []);
      document.getElementById('mc-client-results').innerHTML = list.map(c =>
        `<div style="cursor:pointer;padding:4px" data-id="${escAttr(String(c.id))}" data-name="${escAttr(c.name || '')}" onclick="mcPickClient(this)">${esc(c.name || '')} ${esc(c.phone || '')}</div>`).join('');
    } catch {}
  }, 300);
}

function mcPickClient(el) {
  document.getElementById('mc-client-id').value = el.dataset.id;
  document.getElementById('mc-client-search').value = el.dataset.name;
  document.getElementById('mc-client-results').innerHTML = '';
}

async function mcLoadDefaults() {
  const clientId = document.getElementById('mc-client-id').value;
  const year = document.getElementById('mc-year').value;
  try {
    const d = await api('GET', `/api/medical-cert/defaults?clientId=${clientId}&year=${year}`);
    for (const [k] of MC_FIELDS) {
      const el = document.getElementById('mc-f-' + k);
      if (el && d[k] !== undefined) el.value = d[k];
    }
    if (d.amount_total) document.getElementById('mc-f-amount1').value = d.amount_total;
    notify('Данные подтянуты');
  } catch { notify('Не удалось подтянуть данные', 'err'); }
}

function mcCollect() {
  const body = {};
  for (const [k] of MC_FIELDS) { const el = document.getElementById('mc-f-' + k); if (el) body[k] = el.value; }
  for (const [k] of MC_PATIENT_FIELDS) { const el = document.getElementById('mc-f-' + k); if (el) body[k] = el.value; }
  body.payer_is_patient = document.getElementById('mc-f-payer_is_patient').checked ? '1' : '0';
  return body;
}

async function mcGenerate() {
  try {
    const resp = await fetch('/api/medical-cert/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('lp_tk') },
      body: JSON.stringify(mcCollect()),
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || resp.status); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'spravka.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { notify('Ошибка генерации: ' + e.message, 'err'); }
}

async function mcLoadTemplateMeta() {
  try {
    const m = await api('GET', '/api/medical-cert/template');
    const el = document.getElementById('mc-template-meta');
    el.innerHTML = m && m.fileName
      ? `Активный бланк: ${m.fileName} (v${m.version}). <a href="${m.url}" target="_blank">открыть</a>`
      : '<span style="color:var(--danger)">Бланк не загружен</span>';
  } catch {}
}

async function mcUploadTemplate() {
  const f = document.getElementById('mc-template-file').files[0];
  if (!f) return notify('Выберите PDF-файл', 'err');
  const fd = new FormData(); fd.append('file', f);
  try {
    const resp = await fetch('/api/medical-cert/template', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + localStorage.getItem('lp_tk') }, body: fd });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.status);
    notify('Бланк загружен'); mcLoadTemplateMeta();
  } catch (e) { notify('Ошибка загрузки: ' + e.message, 'err'); }
}

// Простой редактор координат: textarea с JSON. Калибровка значений по реальному бланку.
async function mcOpenCoordsEditor() {
  const coords = await api('GET', '/api/medical-cert/template/coords');
  document.getElementById('mc-coords-editor').innerHTML =
    `<textarea id="mc-coords-json" rows="14" style="width:100%;font-family:monospace;font-size:12px">${JSON.stringify(coords, null, 2)}</textarea>
     <button class="btn" onclick="mcSaveCoords()">Сохранить координаты</button>`;
}

async function mcSaveCoords() {
  try {
    const coords = JSON.parse(document.getElementById('mc-coords-json').value);
    await api('PUT', '/api/medical-cert/template/coords', coords);
    notify('Координаты сохранены');
  } catch (e) { notify('Ошибка JSON/сохранения: ' + e.message, 'err'); }
}

// Предзаполнить форму генератора значениями из заявки (объект /prefill).
function mcPrefillFromRequest(p) {
  const same = p.payer_is_patient === '1';
  const setV = (k, v) => { const el = document.getElementById('mc-f-' + k); if (el && v !== undefined && v !== null) el.value = v; };
  for (const [k] of MC_FIELDS) if (p[k] !== undefined) setV(k, p[k]);
  for (const [k] of MC_PATIENT_FIELDS) if (p[k] !== undefined) setV(k, p[k]);
  const cb = document.getElementById('mc-f-payer_is_patient');
  if (cb) { cb.checked = same; mcTogglePatient(); }
  if (p.clientId) {
    const ci = document.getElementById('mc-client-id'); if (ci) ci.value = p.clientId;
    const cs = document.getElementById('mc-client-search'); if (cs) cs.value = p.clientName || '';
  }
  if (typeof notify === 'function') notify('Данные заявки загружены в генератор');
}
