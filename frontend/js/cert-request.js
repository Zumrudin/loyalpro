// frontend/js/cert-request.js — публичная форма заявки на справку (в iframe).
(function () {
  // slug из пути /cert-request/<slug>
  const slug = location.pathname.split('/').filter(Boolean).pop();
  const base = `/api/public/cert-requests/${encodeURIComponent(slug)}`;
  const $ = (id) => document.getElementById(id);

  const TEXT_FIELDS = [
    'payer_last', 'payer_first', 'payer_middle', 'payer_birthdate', 'payer_inn',
    'payer_doc_type_code', 'payer_doc_serie_number', 'payer_doc_issue_date', 'payer_phone', 'payer_email',
    'patient_last', 'patient_first', 'patient_middle', 'patient_birthdate', 'patient_inn',
    'patient_doc_type_code', 'patient_doc_serie_number', 'patient_doc_date', 'patient_phone',
  ];

  function togglePatient() {
    const same = $('cr-payer_is_patient').checked;
    $('cr-patient-block').classList.toggle('hidden', same);
  }

  async function init() {
    try {
      const cfg = await (await fetch(`${base}/config`)).json();
      $('cr-clinic').textContent = cfg.clinicName || '';
      $('cr-policy').href = cfg.policyUrl || '#';
      $('cr-report_year').innerHTML = cfg.years.map((y) => `<option value="${y}">${y}</option>`).join('');
      $('cr-relationship').innerHTML =
        '<option value="">—</option>' + cfg.relationships.map((r) => `<option value="${r.code}">${r.label}</option>`).join('');
    } catch {
      $('cr-error').textContent = 'Не удалось загрузить форму. Обновите страницу.';
    }
    $('cr-payer_is_patient').addEventListener('change', togglePatient);
    togglePatient();
    $('cr-form').addEventListener('submit', submit);
  }

  async function submit(ev) {
    ev.preventDefault();
    $('cr-error').textContent = '';
    const same = $('cr-payer_is_patient').checked;
    const body = { report_year: Number($('cr-report_year').value), payer_is_patient: same,
      consent: $('cr-consent').checked, relationship: $('cr-relationship').value, website: $('cr-website').value };
    for (const f of TEXT_FIELDS) body[f] = $('cr-' + f).value.trim();

    if (!body.consent) { $('cr-error').textContent = 'Поставьте согласие на обработку данных.'; return; }
    const btn = $('cr-submit'); btn.disabled = true; btn.textContent = 'Отправка…';
    try {
      const resp = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        $('cr-error').textContent = data.error === 'validation'
          ? 'Проверьте поля: ' + (data.fields || []).join(', ')
          : (data.error === 'too_many_requests' ? 'Слишком много заявок, попробуйте позже.' : 'Ошибка отправки.');
        return;
      }
      $('cr-form-view').classList.add('hidden');
      $('cr-ok-view').classList.remove('hidden');
      if (data.applicationToken) $('cr-download').href = `${base}/application/${data.applicationToken}`;
    } catch {
      $('cr-error').textContent = 'Сеть недоступна. Повторите попытку.';
    } finally { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
  }

  init();
})();
