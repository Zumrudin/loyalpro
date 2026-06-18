// frontend/js/cert-request.js — публичная форма заявки на справку (в iframe).
(function () {
  // slug из пути /cert-request/<slug>
  const slug = location.pathname.split('/').filter(Boolean).pop();
  const base = `/api/public/cert-requests/${encodeURIComponent(slug)}`;
  const $ = (id) => document.getElementById(id);

  const TEXT_FIELDS = [
    'payer_last', 'payer_first', 'payer_middle', 'payer_birthdate', 'payer_inn',
    'payer_doc_serie_number', 'payer_doc_issue_date', 'payer_phone', 'payer_email',
    'patient_last', 'patient_first', 'patient_middle', 'patient_birthdate', 'patient_inn',
    'patient_doc_type_code', 'patient_doc_serie_number', 'patient_doc_date', 'patient_phone',
  ];

  // Коды ошибок валидации (клиент и сервер) → понятные пользователю сообщения.
  const FIELD_MESSAGES = {
    report_year: 'Выберите отчётный год.',
    consent: 'Поставьте отметку о согласии на обработку персональных данных.',
    payer_name: 'Укажите фамилию, имя и отчество получателя справки.',
    payer_birthdate: 'Укажите дату рождения получателя.',
    payer_adult: 'Получателем справки (плательщиком) может быть только совершеннолетний — 18 лет и старше.',
    payer_inn: 'Укажите корректный ИНН получателя — 10 или 12 цифр.',
    payer_doc: 'Серия и номер паспорта получателя — ровно 10 цифр (4 серии + 6 номера).',
    payer_doc_issue_date: 'Укажите дату выдачи паспорта получателя.',
    payer_phone: 'Укажите корректный телефон получателя в формате +7XXXXXXXXXX.',
    patient_name: 'Укажите фамилию, имя и отчество пациента.',
    patient_birthdate: 'Укажите дату рождения пациента.',
    patient_inn: 'Укажите корректный ИНН пациента — 10 или 12 цифр.',
    patient_doc_type: 'Выберите вид документа пациента — паспорт или свидетельство о рождении.',
    patient_doc: 'Проверьте серию и номер документа пациента (паспорт — ровно 10 цифр).',
    patient_doc_date: 'Укажите дату выдачи документа пациента.',
    patient_phone: 'Укажите телефон пациента в формате +7XXXXXXXXXX — по нему мы найдём оплаты в базе.',
    relationship: 'Выберите степень родства с пациентом.',
  };

  const digits = (s) => (s || '').replace(/\D/g, '');

  // Телефон → «+7XXXXXXXXXX» или null (зеркалит серверный toRuPhone).
  function toRuPhone(raw) {
    let d = digits(raw);
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    if (d.length !== 10) return null;
    return '+7' + d;
  }

  // Совершеннолетие на сегодня по дате рождения 'YYYY-MM-DD'.
  function isAdult(bd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bd || '')) return false;
    const [y, m, d] = bd.split('-').map(Number);
    const now = new Date();
    let age = now.getFullYear() - y;
    const mm = now.getMonth() + 1;
    if (mm < m || (mm === m && now.getDate() < d)) age -= 1;
    return age >= 18;
  }

  const innOk = (s) => digits(s).length === 10 || digits(s).length === 12;

  // Клиентская валидация: те же коды полей, что и на сервере.
  function validate(body, same) {
    const e = [];
    if (!body.report_year) e.push('report_year');
    if (!body.consent) e.push('consent');
    if (!body.payer_last || !body.payer_first || !body.payer_middle) e.push('payer_name');
    if (!body.payer_birthdate) e.push('payer_birthdate');
    else if (!isAdult(body.payer_birthdate)) e.push('payer_adult');
    if (!innOk(body.payer_inn)) e.push('payer_inn');
    if (digits(body.payer_doc_serie_number).length !== 10) e.push('payer_doc');
    if (!body.payer_doc_issue_date) e.push('payer_doc_issue_date');
    if (!toRuPhone(body.payer_phone)) e.push('payer_phone');
    if (!same) {
      if (!body.patient_last || !body.patient_first || !body.patient_middle) e.push('patient_name');
      if (!body.patient_birthdate) e.push('patient_birthdate');
      if (!innOk(body.patient_inn)) e.push('patient_inn');
      const dt = body.patient_doc_type_code;
      if (dt !== '21' && dt !== '03') e.push('patient_doc_type');
      if (dt === '21') { if (digits(body.patient_doc_serie_number).length !== 10) e.push('patient_doc'); }
      else if (!body.patient_doc_serie_number) e.push('patient_doc');
      if (!body.patient_doc_date) e.push('patient_doc_date');
      if (!toRuPhone(body.patient_phone)) e.push('patient_phone');
      if (!body.relationship) e.push('relationship');
    }
    return e;
  }

  function showErrors(fields) {
    const list = (fields || []).map((f) => FIELD_MESSAGES[f] || ('Проверьте поле: ' + f));
    $('cr-error').innerHTML = list.length
      ? 'Проверьте, пожалуйста:<ul style="margin:6px 0 0;padding-left:18px">'
        + list.map((m) => `<li>${m}</li>`).join('') + '</ul>'
      : 'Проверьте правильность заполнения полей.';
  }

  function togglePatient() {
    const same = $('cr-payer_is_patient').checked;
    $('cr-patient-block').classList.toggle('hidden', same);
  }

  // Подпись и подсказка поля «серия и номер» пациента зависят от вида документа.
  function syncPatientDoc() {
    const dt = $('cr-patient_doc_type_code').value;
    const inp = $('cr-patient_doc_serie_number');
    if (dt === '03') {
      $('cr-patient_doc_label').textContent = 'Серия и номер свидетельства *';
      inp.placeholder = 'напр. II-МЮ №123456';
      inp.removeAttribute('inputmode');
    } else {
      $('cr-patient_doc_label').textContent = 'Серия и номер паспорта *';
      inp.placeholder = '10 цифр';
      inp.setAttribute('inputmode', 'numeric');
    }
  }

  // Приводим введённый телефон к виду +7XXXXXXXXXX (на blur, чтобы не мешать вводу).
  function bindPhone(id) {
    const el = $(id);
    el.addEventListener('blur', () => { const p = toRuPhone(el.value); if (p) el.value = p; });
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
    $('cr-patient_doc_type_code').addEventListener('change', syncPatientDoc);
    syncPatientDoc();
    bindPhone('cr-payer_phone');
    bindPhone('cr-patient_phone');
    $('cr-form').addEventListener('submit', submit);
  }

  async function submit(ev) {
    ev.preventDefault();
    $('cr-error').innerHTML = '';
    const same = $('cr-payer_is_patient').checked;
    const body = { report_year: Number($('cr-report_year').value), payer_is_patient: same,
      consent: $('cr-consent').checked, relationship: $('cr-relationship').value, website: $('cr-website').value };
    for (const f of TEXT_FIELDS) body[f] = $('cr-' + f).value.trim();
    body.payer_doc_type_code = '21'; // получатель справки — всегда паспорт РФ

    const errs = validate(body, same);
    if (errs.length) { showErrors(errs); return; }

    // Телефоны → канонический +7 перед отправкой (сервер тоже нормализует).
    body.payer_phone = toRuPhone(body.payer_phone) || body.payer_phone;
    if (!same) body.patient_phone = toRuPhone(body.patient_phone) || body.patient_phone;

    const btn = $('cr-submit'); btn.disabled = true; btn.textContent = 'Отправка…';
    try {
      const resp = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (data.error === 'validation') showErrors(data.fields);
        else $('cr-error').textContent = data.error === 'too_many_requests'
          ? 'Слишком много заявок с этого устройства. Попробуйте позже.'
          : 'Не удалось отправить заявку. Повторите попытку.';
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
