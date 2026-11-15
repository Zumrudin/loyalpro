// Журнал записи: «Лояльность» клиента. Общая глобальная область с journal.js (префикс jrLy).
// Карты лояльности, абонементы и сертификаты клиента (GET clients/loyalty).
// По умолчанию — только активные; второй вариант фильтра показывает и
// просроченные/исчерпанные. Просмотр, без изменения баланса.
const JR_LY_FILTERS = [['active', 'Активные'], ['all', 'Активные, просроченные и исчерпанные']];

function jrLyDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
}
const jrLyKey = item => item.kind + ':' + (item.id ?? item.number ?? '');
const jrLyTile = (label, value) => `<div class="jr-ly-tile"><small>${jrEscape(label)}</small><strong>${jrEscape(value)}</strong></div>`;
const jrLyNum = v => Number(v || 0).toLocaleString('ru-RU');
function jrLyHead(item, open, expandable = true) {
  return `<div class="jr-ly-head"><div><h4>${jrEscape(item.title)}</h4>${item.number ? `<p class="jr-ly-number">№ ${jrEscape(item.number)}</p>` : ''}${item.network ? `<small>${jrEscape(item.network)}</small>` : ''}</div>`
    + (expandable ? `<button type="button" class="jr-ly-toggle" data-ly-toggle="${jrEscape(jrLyKey(item))}" aria-expanded="${open}">${open ? 'Свернуть' : 'Развернуть'} <span aria-hidden="true">${open ? '⌃' : '⌄'}</span></button>` : '')
    + '</div>';
}
function jrLyTabs(key, tabs, current) {
  return `<div class="jr-ly-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" class="${id === current ? 'is-active' : ''}" aria-selected="${id === current}" data-ly-tab="${jrEscape(key)}" data-ly-tab-id="${id}">${label}</button>`).join('')}</div>`;
}
function jrLyCard(c, open) {
  const tiles = [jrLyTile('Кэшбэк', jrRub(c.balance)), jrLyTile('Макс. процент скидки', jrLyNum(c.maxDiscountPercent) + '%'),
    jrLyTile('Макс. фиксированная скидка', jrLyNum(c.maxDiscountAmount)), jrLyTile('Начислено бонусных услуг', jrLyNum(c.points)),
    jrLyTile('Продано', jrRub(c.soldAmount)), jrLyTile('Оплачено', jrRub(c.paidAmount)), jrLyTile('Визиты', jrLyNum(c.visits))].join('');
  let body = '';
  if (open) {
    const rows = (c.history || []).map(h => `<tr><td>${jrLyDate(h.date)}</td><td>${jrEscape(h.title)}</td><td class="${h.amount < 0 ? 'jr-ly-minus' : 'jr-ly-plus'}">${h.amount < 0 ? '− ' : '+ '}${jrLyNum(Math.abs(h.amount))}</td></tr>`).join('');
    body = jrLyTabs(jrLyKey(c), [['history', 'История']], 'history')
      + (rows ? `<table class="jr-ly-table"><thead><tr><th>Дата</th><th>Операция</th><th>Кэшбэк</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="jr-hint">${c.linked ? 'Операций по карте нет.' : 'История операций ведётся только по карте программы лояльности салона.'}</p>`)
      + (c.programs?.length ? `<p class="jr-hint">Акции: ${jrEscape(c.programs.join(', '))}</p>` : '');
  }
  return `<article class="jr-ly-item">${jrLyHead(c, open)}<div class="jr-ly-tiles">${tiles}</div>${body}</article>`;
}
function jrLyAbonement(a, open, tab) {
  const balance = a.balance === 'безлимит' ? 'Безлимит' : jrLyNum(a.balance);
  const tiles = [jrLyTile('Статус', (a.status || '—') + (a.frozen ? ' · заморожен' : '')), jrLyTile('Дата создания', jrLyDate(a.created)),
    jrLyTile(a.united ? 'Общий баланс' : 'Остаток посещений', balance), jrLyTile('Дата активации', jrLyDate(a.activated)),
    jrLyTile('Срок действия', a.expires ? jrLyDate(a.expires) : (a.expirationType || '—'))].join('');
  let body = '';
  if (open) {
    const current = tab || 'services';
    body = jrLyTabs(jrLyKey(a), [['services', 'Услуги'], ['term', 'Срок действия']], current);
    if (current === 'term') {
      body += `<div class="jr-ly-tiles">${[jrLyTile('Начало срока', a.expirationType || '—'), jrLyTile('Дата активации', jrLyDate(a.activated)),
        jrLyTile('Действует до', jrLyDate(a.expires)), jrLyTile('Заморозка', a.frozen ? 'Заморожен' : 'Нет')].join('')}</div>`;
    } else {
      const rows = (a.services || []).map(s => `<tr><td>${jrEscape(s.category)}</td><td>${jrEscape(s.service)}</td>${a.united ? '' : `<td>${s.count === 'безлимит' ? 'Безлимит' : jrEscape(s.count ?? '—')}</td>`}</tr>`).join('');
      body += (a.united ? `<p class="jr-ly-sub">Общий баланс: <strong>${balance}</strong></p>` : '')
        + (rows ? `<table class="jr-ly-table"><thead><tr><th>Категория</th><th>Услуга</th>${a.united ? '' : '<th>Остаток</th>'}</tr></thead><tbody>${rows}</tbody></table>` : '<p class="jr-hint">Услуги абонемента не указаны.</p>');
    }
  }
  return `<article class="jr-ly-item">${jrLyHead(a, open)}<div class="jr-ly-tiles">${tiles}</div>${body}</article>`;
}
function jrLyCertificate(c) {
  const tiles = [jrLyTile('Статус', c.status || '—'), jrLyTile('Дата создания', jrLyDate(c.created)), jrLyTile('Баланс', jrRub(c.balance)),
    jrLyTile('Номинал', c.nominal == null ? '—' : jrRub(c.nominal)), jrLyTile('Срок действия', c.expires ? 'до ' + jrLyDate(c.expires) : 'Бессрочный'),
    ...(c.appliesTo ? [jrLyTile('Можно оплатить', c.appliesTo)] : [])].join('');
  return `<article class="jr-ly-item">${jrLyHead(c, false, false)}<div class="jr-ly-tiles">${tiles}</div></article>`;
}
function jrLySection(title, list, error, filter, render, emptyWord) {
  let inner;
  if (list == null) inner = `<p class="jr-hint">${jrEscape(error || 'Нет данных.')}</p>`;
  else {
    const shown = filter === 'all' ? list : list.filter(x => x.active);
    const hidden = list.length - shown.length;
    inner = (shown.length ? shown.map(render).join('') : `<p class="jr-hint">${filter === 'all' ? `${emptyWord} нет.` : `Активных ${emptyWord.toLowerCase()} нет.`}</p>`)
      + (hidden > 0 ? `<p class="jr-hint">Скрыто неактивных: ${hidden}.</p>` : '');
  }
  return `<section class="jr-ly-section"><h3>${jrEscape(title)}</h3>${inner}</section>`;
}
function jrLyHtml(data, v) {
  const open = key => v.open.has(key);
  return `<div class="jr-ly-toolbar"><select id="jrLyFilter" aria-label="Какие показать">${JR_LY_FILTERS.map(([id, label]) => `<option value="${id}"${v.filter === id ? ' selected' : ''}>${label}</option>`).join('')}</select>${v.fromId != null ? '<button type="button" class="btn btn-sec" id="jrLyBack">К записи</button>' : ''}</div>`
    + jrLySection('Карты лояльности', data.cards, data.errors?.cards, v.filter, c => jrLyCard(c, open(jrLyKey(c))), 'Карт')
    + jrLySection('Абонементы', data.abonements, data.errors?.abonements, v.filter, a => jrLyAbonement(a, open(jrLyKey(a)), v.tabs[jrLyKey(a)]), 'Абонементов')
    + jrLySection('Сертификаты', data.certificates, data.errors?.certificates, v.filter, jrLyCertificate, 'Сертификатов');
}
function jrLyRender() {
  const v = journal.loyalty;
  if (!v?.data) return;
  const body = jrEl('jrModalBody');
  body.innerHTML = jrLyHtml(v.data, v);
  jrEl('jrLyFilter').onchange = e => { v.filter = e.target.value; jrLyRender(); };
  if (jrEl('jrLyBack')) jrEl('jrLyBack').onclick = () => jrOpen(v.fromId);
  body.querySelectorAll('[data-ly-toggle]').forEach(b => b.onclick = () => {
    const key = b.dataset.lyToggle;
    if (v.open.has(key)) v.open.delete(key); else v.open.add(key);
    jrLyRender();
  });
  body.querySelectorAll('[data-ly-tab]').forEach(b => b.onclick = () => { v.tabs[b.dataset.lyTab] = b.dataset.lyTabId; jrLyRender(); });
}
// From the card: unsaved card edits are not dropped silently (as «История посещений»).
async function jrOpenLoyalty(r) {
  const kind = journal.session?.edit ? jrUnsavedKind() : null;
  if (kind) return jrAskClose(kind);
  const phone = String(r?.clientPhone || '').replace(/\D/g, '');
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  journal.loyalty = { fromId: r?.id ?? null, phone, filter: 'active', open: new Set(), tabs: {}, data: null };
  jrShowModal('Лояльность', true);
  jrEl('jrModal').className = 'jr-dialog jr-dialog-wide jr-dialog-loyalty';
  if (!phone) { jrEl('jrModalBody').innerHTML = '<p class="jr-hint">Телефон клиента неизвестен — данные лояльности показать нельзя.</p>'; return false; }
  try {
    const data = await jrApi('clients/loyalty?' + new URLSearchParams({ phone }));
    if (request !== journal.modalRequest) return false;
    journal.loyalty.data = data;
    jrLyRender();
    return true;
  } catch (e) {
    if (request !== journal.modalRequest) return false;
    jrMessage(e.message);
    jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrLyReload">Повторить загрузку</button>';
    jrEl('jrLyReload').onclick = () => jrOpenLoyalty(r);
    return false;
  }
}
