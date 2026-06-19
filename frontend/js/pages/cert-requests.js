// frontend/js/pages/cert-requests.js — раздел «Заявки на справки» (owner/admin)
// Зависимости: api(), notify(), esc(), nav(); mcPrefillFromRequest() (medical-cert.js)

const CR_STATUS_LABEL = { new: 'Новая', in_progress: 'В работе', done: 'Готово', rejected: 'Отклонена' };

async function loadCertRequests() {
  const host = document.getElementById('page-cert-requests');
  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
      <h2 style="margin:0">Справки</h2>
      <button class="btn-pri" onclick="crNewCert()">+ Создать новую справку</button>
    </div>
    <div id="cr-list">Загрузка…</div>`;
  try {
    const data = await api('GET', '/api/medical-cert/requests');
    crRenderList(data.items || []);
  } catch (e) { document.getElementById('cr-list').textContent = 'Ошибка загрузки'; }
}

// Открыть генератор с чистой формой (новая справка «с нуля»).
function crNewCert() { navTo('medical-cert'); }

function crFio(l, f, m) { return [l, f, m].filter(Boolean).join(' '); }

function crRenderList(items) {
  const el = document.getElementById('cr-list');
  if (!items.length) { el.innerHTML = '<div style="color:#9ca3af">Заявок нет</div>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="text-align:left;color:#6b7280;font-size:13px">
      <th>Дата</th><th>Год</th><th>Получатель</th><th>Пациент</th><th>Сопоставлен</th><th>Статус</th><th></th></tr></thead>
    <tbody>${items.map(crRow).join('')}</tbody></table>`;
}

function crRow(r) {
  const date = new Date(r.created_at).toLocaleDateString('ru-RU');
  const payer = esc(crFio(r.payer_last, r.payer_first, r.payer_middle) + ' · ' + (r.payer_phone || ''));
  const patient = r.payer_is_patient ? '— (он же)' : esc(crFio(r.patient_last, r.patient_first, '') + ' · ' + (r.patient_phone || ''));
  const matched = r.matched_client_id ? '✅' : '—';
  return `<tr style="border-top:1px solid #eee;font-size:14px">
    <td>${date}</td><td>${esc(String(r.report_year))}</td><td>${payer}</td><td>${patient}</td>
    <td>${matched}${r.computed_amount != null ? ' · ' + esc(Number(r.computed_amount).toLocaleString('ru-RU')) + ' ₽' : ''}</td>
    <td>${esc(CR_STATUS_LABEL[r.status] || r.status)}</td>
    <td>
      <button class="btn-pri" onclick="crOpenInGenerator(${r.id})">Создать справку</button>
      ${r.status !== 'done' ? `<button onclick="crSetStatus(${r.id},'done')">Готово</button>` : ''}
      ${r.status !== 'rejected' ? `<button onclick="crSetStatus(${r.id},'rejected')">Отклонить</button>` : ''}
    </td>
  </tr>`;
}

async function crOpenInGenerator(id) {
  let p;
  try {
    p = await api('GET', `/api/medical-cert/requests/${id}/prefill`);
  } catch (e) { return notify('Не удалось открыть заявку', 'err'); }
  navTo('medical-cert'); // переключиться на генератор (под-страница раздела «Справки»)
  setTimeout(() => { if (typeof mcPrefillFromRequest === 'function') mcPrefillFromRequest(p); }, 50);
  try { await api('PUT', `/api/medical-cert/requests/${id}/status`, { status: 'in_progress' }); }
  catch (e) { /* статус не критичен для открытия генератора */ }
}

async function crSetStatus(id, status) {
  try {
    await api('PUT', `/api/medical-cert/requests/${id}/status`, { status });
    notify('Статус обновлён');
    loadCertRequests();
  } catch (e) { notify('Не удалось изменить статус', 'err'); }
}
