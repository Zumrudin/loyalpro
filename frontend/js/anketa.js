// Публичная анкета пациента «Документов» (спека 2026-10-25 §6). Без зависимостей SPA и без JWT:
// токен — в адресе /anketa/<токен>. Сервер отдаёт только имя для приветствия, дату визита и список
// полей; уже известные данные пациента не приходят (у кого ссылка, тот паспорт не прочитает).
(function () {
  'use strict';
  var token = (location.pathname.split('/anketa/')[1] || '').split('/')[0];
  var api = '/api/public/anketa/' + encodeURIComponent(token);
  var fields = [];
  var $ = function (id) { return document.getElementById(id); };
  var GONE = {
    submitted: ['✓', 'Анкета уже заполнена', 'Спасибо! Данные переданы в клинику.'],
    expired: ['!', 'Срок действия ссылки истёк', 'Попросите клинику прислать новую ссылку.'],
    revoked: ['!', 'Ссылка больше не действует', 'Попросите клинику прислать новую ссылку.'],
    not_found: ['?', 'Ссылка не найдена', 'Проверьте, что ссылка открыта полностью, или попросите клинику прислать новую.'],
  };

  function show(id) { ['aLoading', 'aGone', 'aForm', 'aDone'].forEach(function (x) { $(x).hidden = x !== id; }); }
  function gone(status) {
    var g = GONE[status] || GONE.not_found;
    $('aGoneIco').textContent = g[0]; $('aGoneTitle').textContent = g[1]; $('aGoneText').textContent = g[2];
    show('aGone');
  }
  function msg(text, cls) { $('aMsg').innerHTML = ''; if (!text) return; var d = document.createElement('div'); d.className = 'msg ' + (cls || 'bad'); d.textContent = text; $('aMsg').appendChild(d); }
  function req(method, url, body, isForm) {
    var opts = { method: method, headers: {} };
    if (isForm) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j || {} }; });
    }, function () { return { ok: false, status: 0, body: { error: 'Нет связи — проверьте интернет и попробуйте ещё раз' } }; });
  }

  function input(f) {
    var w = document.createElement('div');
    w.className = 'f';
    w.id = 'aw-' + f.key;
    var l = document.createElement('label');
    l.setAttribute('for', 'af-' + f.key);
    l.textContent = f.label;
    if (!f.required) { var o = document.createElement('span'); o.className = 'opt'; o.textContent = ' — необязательно'; l.appendChild(o); }
    w.appendChild(l);
    var el;
    if (f.type === 'gender') {
      el = document.createElement('select');
      [['', 'Выберите'], ['F', 'Женский'], ['M', 'Мужской']].forEach(function (p) { var op = document.createElement('option'); op.value = p[0]; op.textContent = p[1]; el.appendChild(op); });
    } else {
      el = document.createElement('input');
      el.type = f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text';
      if (f.type === 'digits') { el.inputMode = 'numeric'; el.autocomplete = 'off'; }
      if (f.key === 'passport_series') el.maxLength = 5;
      if (f.key === 'passport_number') el.maxLength = 7;
      if (f.key === 'authority_code') { el.inputMode = 'numeric'; el.maxLength = 7; el.placeholder = '000-000'; }
      if (f.key === 'last_name') el.autocomplete = 'family-name';
      if (f.key === 'first_name') el.autocomplete = 'given-name';
      if (f.key === 'middle_name') el.autocomplete = 'additional-name';
      if (f.key === 'birth_date') el.autocomplete = 'bday';
      if (f.key === 'address') el.autocomplete = 'street-address';
    }
    el.id = 'af-' + f.key;
    el.addEventListener('input', function () { w.classList.remove('err'); });
    w.appendChild(el);
    return w;
  }

  function render(d) {
    $('aClinic').textContent = d.clinic || 'Клиника';
    $('aMono').textContent = String(d.clinic || 'К').trim().charAt(0).toUpperCase();
    document.title = 'Анкета — ' + (d.clinic || 'клиника');
    $('aHello').textContent = d.greetingName ? 'Здравствуйте, ' + d.greetingName + '!' : 'Здравствуйте!';
    $('aLead').textContent = (d.visit ? 'Перед визитом ' + d.visit.label + ' заполните' : 'Заполните') + ', пожалуйста, данные для договора — это займёт пару минут.';
    if (d.policyUrl) $('aPolicy').href = d.policyUrl;
    $('aPhotoCard').hidden = !d.canRecognize;
    fields = d.fields || [];
    var form = $('aFields');
    form.innerHTML = '';
    var groups = { last_name: 'Личные данные', passport_series: 'Паспорт РФ', address: 'Адрес регистрации', email: 'Для связи' };
    fields.forEach(function (f) {
      if (groups[f.key]) { var s = document.createElement('div'); s.className = 'sect'; s.textContent = groups[f.key]; form.appendChild(s); }
      form.appendChild(input(f));
    });
    show('aForm');
  }

  function values() {
    var out = {};
    fields.forEach(function (f) { out[f.key] = ($('af-' + f.key).value || '').trim(); });
    return out;
  }
  function markEmpty() {
    var first = null;
    fields.forEach(function (f) {
      var empty = f.required && !($('af-' + f.key).value || '').trim();
      $('aw-' + f.key).classList.toggle('err', empty);
      if (empty && !first) first = $('af-' + f.key);
    });
    if (first) first.focus();
    return !first;
  }

  function submit() {
    msg('');
    if (!markEmpty()) { msg('Заполните отмеченные поля'); return; }
    if (!$('aConsent').checked) { msg('Подтвердите согласие на обработку персональных данных'); return; }
    var body = values();
    body.consent = true;
    var btn = $('aSubmit');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    req('POST', api, body).then(function (r) {
      btn.disabled = false;
      btn.textContent = 'Отправить';
      if (r.ok) {
        $('aDoneText').textContent = r.body.docs === 'sending'
          ? 'Данные получены. В течение пары минут придёт SMS со ссылкой на подписание документов — откройте её и подпишите кодом из SMS.'
          : 'Данные переданы в клинику.';
        show('aDone');
        return;
      }
      if (r.status === 410) { gone(r.body.code === 'form_submitted' ? 'submitted' : r.body.code === 'form_expired' ? 'expired' : 'revoked'); return; }
      msg(r.body.error || 'Не получилось отправить — попробуйте ещё раз');
    });
  }

  function photo(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var fd = new FormData();
    fd.append('photo', file);
    msg('Распознаём паспорт…', 'info');
    $('aPhotoBtn').classList.add('busy');
    req('POST', api + '/photo', fd, true).then(function (r) {
      if (!r.ok) { msg(r.body.error || 'Не удалось распознать — введите данные вручную'); return; }
      if (!r.body.recognized) { msg('Паспорт на фото не нашёлся — снимите разворот целиком или введите данные вручную'); return; }
      Object.keys(r.body.fields || {}).forEach(function (k) { var el = $('af-' + k); if (el) el.value = r.body.fields[k]; });
      msg(r.body.confidence ? 'Поля заполнены по фото — проверьте их, пожалуйста' : 'Распознано не очень уверенно — внимательно проверьте каждое поле', 'info');
    });
  }

  $('aSubmit').addEventListener('click', submit);
  $('aPhoto').addEventListener('change', photo);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { gone('not_found'); return; }
  req('GET', api).then(function (r) {
    if (!r.ok) { if (r.status === 429) { $('aLoading').textContent = r.body.error || 'Слишком много запросов — попробуйте позже'; return; } gone('not_found'); return; }
    if (r.body.status !== 'active') { gone(r.body.status); return; }
    render(r.body);
  });
})();
