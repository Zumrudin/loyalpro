// Журнал записи: карточка записи. Общая глобальная область с journal.js (префикс jr).
// Card parity with YClients (12.11.2026). Colour palette: one constant.
const JR_COLORS = ['#f4a0a0', '#ffad79', '#f7c76d', '#c5e384', '#9ee5d7', '#a8d8f0', '#b3bdfd', '#d7a6e8'];
function jrPhoneHtml(r) {
  const digits = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!digits) return '<p class="jr-hint">Телефон не указан</p>';
  const tel = '+' + digits;
  return `<p class="jr-client-phone"><a href="tel:${jrEscape(tel)}">${jrEscape(tel)}</a><button type="button" class="btn btn-sec" id="jrCopyPhone" data-phone="${jrEscape(tel)}">Копировать</button></p>`;
}
function jrExtraFields(r) {
  const can = jrCanChange(r), reshape = jrCanReshape(r);
  const off = flag => (flag ? '' : ' disabled');
  const labels = journal.data?.labels || [];
  const chosen = new Set((r.labels || []).map(l => Number(l.id)));
  const pauseSec = Number(r.technicalBreak) || 0;
  const pause = Math.round(pauseSec / 60);
  const offGrid = pauseSec > 0 && !(pauseSec % 300 === 0 && pauseSec <= 3600);
  const known = new Set(labels.map(l => Number(l.id)));
  const orphans = (r.labels || []).map(l => Number(l.id)).filter(id => !known.has(id));
  const customOut = JR_HEX.test(r.customColor || '') && !JR_COLORS.includes(r.customColor);
  return `<section class="jr-extra">
    <label class="jr-side-label">Длительность, мин<input id="jrDurationEdit" type="number" min="5" max="720" step="5" value="${jrEscape(r.duration)}"${off(reshape)}></label>
    <label class="jr-side-label">Технический перерыв<select id="jrBreakEdit"${off(can)}>${Array.from({ length: 13 }, (_, i) => i * 5).map(v => `<option value="${v}"${!offGrid && v === pause ? ' selected' : ''}>${v ? v + ' мин' : 'Нет'}</option>`).join('')}${offGrid ? `<option value="${pauseSec / 60}" selected>${jrEscape(Math.round(pauseSec / 6) / 10)} мин</option>` : ''}</select></label>
    <div class="jr-side-label">Цвет записи<div class="jr-colors" role="group" aria-label="Цвет записи"><button type="button" class="jr-color jr-color-none${r.customColor ? '' : ' is-current'}" data-color="" title="Без цвета"${off(can)}>∅</button>${customOut ? `<button type="button" class="jr-color is-current" data-color="${r.customColor}" style="background:${r.customColor}" title="${r.customColor} (цвет из YClients)"${off(can)}></button>` : ''}${JR_COLORS.map(c => `<button type="button" class="jr-color${r.customColor === c ? ' is-current' : ''}" data-color="${c}" style="background:${c}" title="${c}"${off(can)}></button>`).join('')}</div></div>
    <div class="jr-side-label">Метки${labels.length || orphans.length ? `<div class="jr-labels">${labels.map(l => `<label class="jr-label-choice"><input type="checkbox" data-label="${Number(l.id)}"${chosen.has(Number(l.id)) ? ' checked' : ''}${off(can)}><i class="jr-label-dot" style="background:${JR_HEX.test(l.color || '') ? l.color : '#999999'}"></i>${jrEscape(l.title)}</label>`).join('')}${orphans.map(id => `<label class="jr-label-choice"><input type="checkbox" data-label="${id}" checked disabled>№${id} (нет в справочнике)</label>`).join('')}</div>` : '<p class="jr-hint">Меток в салоне нет.</p>'}</div>
    <label class="jr-notify"><input type="checkbox" id="jrNoNotify"${r.notifyClient === false ? ' checked' : ''}${off(can)}> Не уведомлять клиента</label>
  </section>`;
}
// One field of the card's session edit; enables «Сохранить изменения».
function jrCardEdit(key, value) {
  if (!journal.session) return;
  journal.session.edit ||= {};
  journal.session.edit[key] = value;
  jrEl('jrSaveChanges').disabled = false;
  // Cancel would contradict the draft (as for status/services edits).
  if (jrEl('jrCancel')) jrEl('jrCancel').disabled = true;
}
function jrDeleteRecord(r) {
  const carry = journal.session?.edit ? { ...journal.session.edit } : null;
  jrShowModal('Удалить запись');
  journal.draft = { action: 'delete', recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>Удалить запись насовсем? В отличие от отмены (статус «Не пришёл»), удалённая запись исчезнет из журнала, а после «Отправить в YClients» — и из YClients. Вернуть её будет нельзя.</p><div class="jr-actions"><button type="button" class="btn btn-pri jr-danger" id="jrApply">Да, удалить запись</button><button type="button" class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: 'delete', ...(carry ? { edit: carry } : {}) });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
// «Записать повторно»: the same client and services, the date is chosen anew.
function jrRebook(r) {
  // Unsaved card edits are not dropped silently: ask first, as on close.
  const kind = journal.session?.edit ? jrUnsavedKind() : null;
  if (kind) return jrAskClose(kind);
  const ids = new Set((r.services || []).map(s => Number(s.id)));
  const serviceIds = (journal.data?.services || []).filter(s => ids.has(Number(s.yclientsId)) && (s.staffIds || []).includes(r.staffId)).map(s => s.id);
  jrForm(null, { staffId: r.staffId, date: '', serviceIds, client: { name: r.clientName, phone: r.clientPhone || '' } });
  journal.formTouched = true; // a preset form counts as changed: closing asks
}

function jrTools(record) {
  const live = !!record && Number(record.id) > 0;
  return `<div class="jr-tools">${[['ЕГИСЗ','plus'],['Текущий приём','file'],['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell'],['Списание расходников','box'],['История изменений','clock'],['Лист назначения','file']].map(([title,icon]) => live && title === 'История изменений'
    ? `<button type="button" class="jr-tool-live jr-placeholder" id="jrHistoryOpen">${jrIcon(icon)}<span>${title}</span></button>`
    : jrStub(title,icon)).join('')}</div>${live ? '<div id="jrHistory" class="jr-history-box" hidden></div>' : ''}`;
}
function jrClientPanel(record, creating = false, editable = false) {
  return `<aside class="jr-booking-client jr-booking-panel"><div class="jr-client-tabs"><span class="is-active">${jrIcon('user')} Клиент</span>${jrStub('Чат','chat','jr-tab-stub')}</div>${creating
    ? '<div class="jr-fields"><label>Имя клиента<input id="jrName" required maxlength="120" autocomplete="off" placeholder="Имя и фамилия"></label><label>Телефон с кодом страны<input id="jrPhone" required type="tel" maxlength="24" autocomplete="off" placeholder="Введите номер телефона"></label></div>'
    : `<div class="jr-client-identity">${jrIcon('user')}<h3 id="jrClientName">${jrEscape(record?.clientName || 'Клиент')}</h3></div>${editable ? jrPhoneHtml(record) : ''}`}
    ${!creating && editable && record && jrCanReshape(record)
      ? `<button type="button" class="btn btn-sec" id="jrChangeClient">${jrIcon('user')} Сменить клиента</button><div id="jrChangeClientBox" class="jr-fields" hidden><label>Найти клиента<input id="jrClientSearch" type="search" placeholder="Имя или телефон" autocomplete="off"></label><h4 id="jrClientsTitle">Последние клиенты</h4><div id="jrClientResults" aria-live="polite"></div></div>`
      : jrStub('Сменить клиента','user','jr-stub-inline')}
    <div class="jr-client-tools">${[['Планы лечения','file'],['Медкарта','plus'],['История посещений','clock'],['Лояльность','wallet'],['Счета клиента','wallet']].map(([title,icon]) => jrStub(title,icon)).join('')}</div>
    <label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя <small>Скоро</small></label>
    <section class="jr-client-info"><h4>Дополнительно</h4><p>Примечание о клиенте<span>—</span></p><p>Дата рождения<span>—</span></p><p>Номер договора<span>—</span></p></section>
    ${editable ? '<section class="jr-client-info"><h4>Клиент</h4><div id="jrClientSummaryBox"><p class="jr-hint">Загрузка данных клиента…</p></div></section>'
      : '<section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>—</span></p><p>Всего визитов<span>—</span></p></div><small>Данные карточки клиента пока не подключены к журналу.</small></section>'}
  </aside>`;
}
function jrPaymentPanel(record) {
  const state = !record ? 'Оплата после создания записи' : record.paymentSync ? 'Оплата передаётся в YClients…' : record.paid ? 'Есть отметка об оплате' : 'Оплата не отмечена';
  return `<section class="jr-payment-panel"><div class="jr-payment-icon">${jrIcon('wallet')}</div><h3>${state}</h3><p>Актуальная сумма, доступные способы и история — в форме оплаты.</p>${record && !record.deleted && record.attendance !== -1 ? '<button type="button" class="btn btn-sec" id="jrPaymentOpen">Оплата визита</button>' : jrStub('Детали оплаты','wallet','jr-stub-inline')}</section>`;
}
function jrStatusBar(record, canEdit = false) {
  if (record?.deleted) return `<div class="jr-status-bar"><span class="jr-state-pill is-current">${['queued', 'running'].includes(record.sync?.status) ? record.sync?.status === 'running' ? 'Удаляется…' : 'Удалена (ждёт отправки)' : 'Запись удалена'}</span></div>`;
  const current = record ? record.attendance : 0;
  const states = [[0,'Ожидание','clock'],[1,'Пришёл','plus'],[-1,'Не пришёл','list'],[2,'Подтвердил','check']];
  return `<div class="jr-status-bar" aria-label="Статус визита">${states.map(([value,label,icon]) => {
    if (value === current && !canEdit) return `<span class="jr-state-pill is-current" aria-current="true">${jrIcon(icon)}${label}</span>`;
    if (canEdit) return `<button type="button" data-attendance="${value}" class="jr-state-pill${value === current ? ' is-current' : ''}">${jrIcon(icon)}${label}</button>`;
    if (jrSyncing(record)) return `<button type="button" class="jr-state-pill" disabled title="Изменения передаются в YClients">${jrIcon(icon)}${label}</button>`;
    if (record?.paid) return `<button type="button" class="jr-state-pill" disabled title="Сначала удалите оплаты визита">${jrIcon(icon)}${label}</button>`;
    return jrStub(label,icon,'jr-state-pill');
  }).join('')}</div>`;
}
// editable: the lines themselves open the editor (a separate button alone
// looked like a read-only list — 10.11.2026).
function jrServicesPanel(record, editable = false) {
  const tag = editable ? 'button type="button" data-service-line' : 'div';
  const end = editable ? 'button' : 'div';
  return `<section class="jr-service-panel"><div class="jr-service-tabs"><span class="is-active">${jrIcon('list')} Услуги</span>${jrStub('Товары','box','jr-tab-stub')}</div>
    <div class="jr-service-lines">${(record.services || []).map(s => `<${tag} class="jr-service-line"${editable ? ' title="Изменить количество и стоимость"' : ''}><span>${jrEscape(s.title || 'Услуга')}${Number(s.quantity) > 1 ? ` <small>× ${jrEscape(s.quantity)} по ${jrEscape(Number(s.unitPrice || 0).toLocaleString('ru'))} ₽</small>` : ''}</span><strong>${jrEscape(Number(s.cost || 0).toLocaleString('ru'))} ₽</strong></${end}>`).join('') || '<p>Услуги не указаны</p>'}</div>
    <p class="jr-hint">Длительность визита при изменении услуг сохраняется.</p></section>`;
}
// Outbox package that could not be delivered to YClients: reason + safe next steps.
function jrSyncAlert(record) {
  const sync = record?.sync;
  if (sync?.status !== 'failed') return '';
  const uncertain = sync.errorCode === 'uncertain';
  return `<div class="jr-sync-alert" role="alert"><strong>Не передано в YClients: ${jrEscape(sync.errorText || 'причина неизвестна')}</strong>${uncertain ? '<p>Нужна сверка в YClients — владелец: кнопка «Сверка операций».</p>' : ''}<div class="jr-actions">${uncertain ? '' : '<button type="button" class="btn btn-sec" id="jrSyncRetry">Повторить отправку</button>'}${uncertain ? '' : `<button type="button" class="btn btn-sec" id="jrSyncDismiss">${Number(record.id) < 0 ? 'Убрать из журнала' : 'Отменить неотправленные изменения'}</button>`}</div></div>`;
}
// A record whose changes are only saved locally stays editable (also a new
// record not yet in YClients); a package on its way or failed locks it.
const jrLocked = record => jrSyncing(record) || record.sync?.status === 'failed';
const jrCanChange = record => !record.deleted && !record.paid && !jrLocked(record);
// Duration, client and deletion additionally exclude an arrived visit (spec §4.1).
const jrCanReshape = record => jrCanChange(record) && record.attendance !== 1;
const jrCanEdit = record => !record.deleted && record.attendance !== -1 && record.attendance !== 1 && !record.paid && !jrLocked(record);
function jrAppointmentCard(record) {
  const canEdit = jrCanEdit(record);
  const local = Number(record.id) < 0;
  const editNote = jrSyncing(record) ? 'Изменения передаются в YClients' : record.sync?.status === 'failed' ? 'Сначала повторите или отмените неотправленные изменения.'
    : jrCanChange(record) ? `Перенос и отмена недоступны для визита со статусом «${record.attendance === 1 ? 'Пришёл' : 'Не пришёл'}». Статус, услуги и стоимость можно менять.`
    : 'Изменения этого визита выполняются в YClients.';
  const staffName = journal.data?.staff?.find(s => s.id === record.staffId)?.name || record.staffName || 'Сотрудник';
  const initials = staffName.split(/\s+/).slice(0,2).map(s => s[0] || '').join('');
  const day = record.date ? new Date(record.date + 'T12:00:00+03:00').toLocaleDateString('ru', { day:'numeric',month:'long',timeZone:'Europe/Moscow' }) : 'Дата не указана';
  return `${jrSyncAlert(record)}<div class="jr-booking-layout"><aside class="jr-booking-side"><div class="jr-visit-summary"><div class="jr-staff-identity"><span class="jr-staff-avatar">${jrEscape(initials)}</span><div><strong>${jrEscape(staffName)}</strong><small>Специалист</small></div></div><div class="jr-visit-date">${jrIcon('calendar')}<div><strong>${jrEscape(day)}</strong><small>${jrEscape(record.time)} · ${jrEscape(record.duration)} мин.</small></div></div>${canEdit ? `<button type="button" class="btn btn-sec jr-move-btn" id="jrMove">${jrIcon('move')}Перенести запись</button>` : `<button type="button" class="btn btn-sec jr-move-btn" disabled title="${jrEscape(editNote)}">Перенести запись</button>`}</div>
    <label class="jr-side-label">Комментарий к записи<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан"${jrCanChange(record) ? '' : ' readonly'}>${jrEscape(record.comment || '')}</textarea></label>${jrExtraFields(record)}${record ? jrTools(record) : '<div class="jr-tools">' + [['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell']].map(([label,icon]) => jrStub(label,icon)).join('') + '</div>'}</aside>
    <section class="jr-booking-main jr-booking-panel">${jrStatusBar(record,jrCanChange(record))}${jrSyncing(record) ? '<p class="jr-hint" role="status">Передаём изменения в YClients… Карточка обновится автоматически.</p>' : jrUnsent(record) ? `<p class="jr-hint jr-unsent-hint" role="status">${local ? 'Новая запись сохранена в журнале' : 'Изменения сохранены в журнале'} и ещё не отправлены в YClients — кнопка «Отправить в YClients» над журналом.</p>` : ''}${jrServicesPanel(record, jrCanChange(record))}${jrCanChange(record) ? '<button type="button" class="btn btn-sec" id="jrEditServices">Изменить услуги, количество и стоимость</button>' : record.paid && !record.deleted ? '<p class="jr-hint">Визит оплачен: чтобы изменить статус, услуги или стоимость, сначала удалите оплаты в «Оплата визита».</p>' : ''}${jrPaymentPanel(record)}${!canEdit ? `<p class="jr-hint">${jrEscape(editNote)}</p>` : ''}</section>${jrClientPanel(record, false, true)}</div>
    <footer class="jr-booking-footer"><span class="jr-hint">Изменения сохраняются в журнале кнопкой «Сохранить изменения» (при закрытии карточки спросим); в YClients они уходят по кнопке «Отправить в YClients».</span><div>${canEdit ? '<button type="button" class="btn btn-sec" id="jrCancel">Отменить запись</button>' : ''}${jrCanReshape(record) ? '<button type="button" class="btn btn-sec jr-danger" id="jrDelete">Удалить запись</button>' : ''}${record.deleted ? '' : '<button type="button" class="btn btn-sec" id="jrRebook">Записать повторно</button>'}${jrCanChange(record) ? '<button type="button" class="btn btn-pri" id="jrSaveChanges" disabled>Сохранить изменения</button>' : jrStub('Сохранить изменения','check','jr-stub-inline')}</div></footer>`;
}

async function jrOpen(id) {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  jrShowModal('Карточка записи', true);
  try {
    const r = await jrApi('records/' + id);
    if (request !== journal.modalRequest) return;
    jrRenderRecord(r);
    if (jrSyncing(r)) jrWatchRecord(r.id);

  } catch (e) { if (request === journal.modalRequest) jrMessage(e.message); }
}
function jrRenderRecord(r) {
    const canEdit = jrCanEdit(r);
    jrEl('jrModalBody').innerHTML = jrAppointmentCard(r);
    jrSetCardStatus(r.deleted ? null : r.attendance);
    if (jrEl('jrModal')?.dataset) { if (r.paidFull) jrEl('jrModal').dataset.paidFull = '1'; else delete jrEl('jrModal').dataset.paidFull; }
    if (!r.deleted && r.attendance !== -1) jrEl('jrPaymentOpen').onclick = () => jrPayFromCard(r.id);
    if (r.sync?.status === 'failed') {
      if (r.sync.errorCode !== 'uncertain') jrEl('jrSyncRetry').onclick = () => jrSyncAction(r.sync.outboxId, 'retry');
      if (r.sync.errorCode !== 'uncertain') jrEl('jrSyncDismiss').onclick = () => jrSyncAction(r.sync.outboxId, 'dismiss');
    }
    if (jrCanChange(r)) jrBindRecordEdit(r);
    if (canEdit) {
      jrEl('jrMove').onclick = () => jrForm(r, { carry: journal.session?.edit ? { edit: journal.session.edit, servicesVersion: journal.session.servicesVersion } : null });

      jrEl('jrCancel').onclick = () => jrConfirmAction(r, 'cancel');
    }
    const copy = jrEl('jrCopyPhone');
    if (copy) copy.onclick = () => {
      const clip = typeof navigator !== 'undefined' && navigator.clipboard;
      (clip ? clip.writeText(copy.dataset?.phone || '') : Promise.reject(new Error('no clipboard')))
        .then(() => notify('Телефон скопирован.'))
        .catch(() => notify('Не удалось скопировать — выделите номер вручную.', 'err'));
    };
    if (jrCanReshape(r) && jrEl('jrDelete')) jrEl('jrDelete').onclick = () => jrDeleteRecord(r);
    if (!r.deleted && jrEl('jrRebook')) jrEl('jrRebook').onclick = () => jrRebook(r);
    const historyBtn = jrEl('jrHistoryOpen');
    if (historyBtn) {
      historyBtn.onclick = () => jrLoadHistory(r.id);
      // A re-render (polling while sending) keeps an already loaded history.
      const kept = journal.history;
      if (kept && kept.request === journal.modalRequest && kept.id === r.id) { jrEl('jrHistory').hidden = false; jrEl('jrHistory').innerHTML = kept.html; }
    }
    // Lazy, once per opened card; errors stay inside the panel.
    jrLoadClientSummary(r);
}
// The card is tinted by the visit status (like the block in the grid) and
// follows a status click at once, before saving.
function jrSetCardStatus(attendance) {
  const modal = jrEl('jrModal');
  if (!modal?.dataset) return;
  if (attendance === null || attendance === undefined) delete modal.dataset.status;
  else modal.dataset.status = String(attendance);
}
function jrStopRecordWatch() {
  clearTimeout(journal.cardTimer);
  journal.cardTimer = null;
  journal.cardWatch = null;
}
function jrWatchRecord(id) {
  jrStopRecordWatch();
  const watch = { id, request: journal.modalRequest };
  journal.cardWatch = watch;
  const current = () => journal.cardWatch === watch && journal.modalRequest === watch.request && jrEl('jrModal').open;
  const schedule = () => { journal.cardTimer = setTimeout(refresh, 2000); };
  const refresh = async () => {
    journal.cardTimer = null;
    if (!current()) return;
    if (document.hidden || journal.busy) { schedule(); return; }
    try {
      const record = await jrApi('records/' + id);
      if (!current()) return;
      jrRenderRecord(record);
      if (!jrSyncing(record)) { jrStopRecordWatch(); return; }
    } catch (_) {
      // A transient read failure must not permanently freeze the open card.
      if (!current()) return;
    }
    schedule();
  };
  schedule();
}
async function jrSyncAction(outboxId, action) {
  let ok = false;
  await jrWithBusy(action === 'retry' ? 'Отправляем повторно…' : 'Убираем…', async () => {
    try { await jrApi(`sessions/${encodeURIComponent(outboxId)}/${action}`, {}); ok = true; }
    catch (e) { jrMessage(e.message); }
  });
  if (!ok) return false;
  jrMessage(''); jrClose(true); loadJournal({ silent: true });
  return true;
}
function jrConfirmAction(r, action) {
  jrShowModal(action === 'cancel' ? 'Отменить запись' : 'Подтвердить запись');
  journal.draft = { action, recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>${action === 'cancel' ? 'Отменить визит? В YClients будет установлен статус «Не пришёл», длительность сократится до 5 минут. Это текущий способ отмены в LoyalPro.' : 'Подтвердить запись?'}</p><div class="jr-actions"><button class="btn btn-pri" id="jrApply">${action === 'cancel' ? 'Да, отменить запись' : 'Подтвердить запись'}</button><button class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: action });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
// «Оплата визита» from the card (11.11.2026): an unsaved status/services edit
// (typically «Пришёл») is saved as its own package first, then the payment form
// opens. Before, the button was disabled after any change and the cashier had
// to save, reopen the card and only then pay.
async function jrPayFromCard(recordId) {
  if (journal.busy) return;
  if (journal.session?.edit && !journal.payment) {
    const saved = await jrSave(jrSessionBody());
    if (!saved) return false;
  }
  return jrOpenPayment(recordId);
}
function jrBindRecordEdit(record) {
  journal.session = jrNewSession({ recordId: record.id, servicesVersion: record.servicesVersion });
  const changed = () => {
    jrEl('jrSaveChanges').disabled = false;
    // Other workflows open a new session; save this draft before entering them.
    // Cancel would contradict the draft; payment stays open — it saves the draft
    // first (the server keeps edits and payments in separate packages).
    if (jrEl('jrCancel')) jrEl('jrCancel').disabled = true;
  };
  jrEl('jrModalBody').querySelectorAll('[data-attendance]').forEach(button => {
    button.onclick = () => {
      journal.session.edit ||= {};
      journal.session.edit.attendance = Number(button.dataset.attendance);
      jrEl('jrModalBody').querySelectorAll('.jr-state-pill').forEach(el => {
        el.classList.remove('is-current'); el.removeAttribute('aria-current');
      });
      button.classList.add('is-current'); button.setAttribute('aria-current', 'true');
      jrSetCardStatus(journal.session.edit.attendance);
      changed();
    };
  });
  jrEl('jrSaveChanges').onclick = () => jrSave(jrSessionBody());
  // Parity fields (12.11.2026): each goes into the same session edit.
  const comment = jrEl('jrCommentEdit');
  if (comment) comment.oninput = () => jrCardEdit('comment', comment.value);
  const duration = jrEl('jrDurationEdit');
  if (duration && !duration.disabled) duration.onchange = () => {
    const n = Number(duration.value);
    if (!Number.isInteger(n) || n < 5 || n > 720 || n % 5 !== 0) { jrMessage('Длительность — от 5 до 720 минут, кратно 5.'); return; }
    jrMessage('');
    jrCardEdit('seanceLength', n);
  };
  const pause = jrEl('jrBreakEdit');
  if (pause) pause.onchange = () => jrCardEdit('technicalBreak', Number(pause.value) * 60);
  const noNotify = jrEl('jrNoNotify');
  if (noNotify) noNotify.onchange = () => jrCardEdit('notifyClient', !noNotify.checked);
  const body = jrEl('jrModalBody');
  body.querySelectorAll('[data-color]').forEach(b => { b.onclick = () => {
    jrCardEdit('customColor', b.dataset.color || null);
    body.querySelectorAll('[data-color]').forEach(x => x.classList?.toggle('is-current', x === b));
  }; });
  body.querySelectorAll('[data-label]').forEach(box => { box.onchange = () => {
    jrCardEdit('labelIds', Array.from(body.querySelectorAll('[data-label]')).filter(x => x.checked).map(x => Number(x.dataset.label)));
  }; });
  const pickClient = client => {
    const name = String(client?.name || '').trim();
    let digits = String(client?.phone || '').replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
    if (digits.length < 11 || digits.length > 15) { notify('У клиента нет корректного телефона (11–15 цифр) — выберите другого.', 'err'); return; }
    if (!name || name.length > 120) { notify('У клиента нет имени или оно длиннее 120 символов — выберите другого.', 'err'); return; }
    jrMessage('');
    jrCardEdit('client', { name, phone: digits });
    jrEl('jrChangeClientBox').hidden = true;
    jrEl('jrClientName').textContent = `${name} — заменит клиента после сохранения`;
  };
  const changeClient = jrEl('jrChangeClient');
  if (changeClient) changeClient.onclick = () => {
    jrEl('jrChangeClientBox').hidden = false;
    jrEl('jrClientSearch').oninput = () => jrLoadClients(jrEl('jrClientSearch').value.trim(), pickClient);
    jrLoadClients('', pickClient);
  };
  jrEl('jrEditServices').onclick = () => {
    const panel = jrEl('jrModalBody').querySelector('.jr-service-panel');
    let lines = record.services.map(s => ({ serviceId: s.id, title: s.title, quantity: s.quantity || 1,
      unitPrice: s.unitPrice ?? s.cost, total: s.cost, mode: 'total', discount: 0 }));
    const choices = (journal.data?.services || []).filter(s => s.yclientsId > 0 && s.staffIds.includes(record.staffId));
    const mark = () => {
      journal.session.edit ||= {};
      journal.session.edit.lines = lines.map(({ title, ...line }) => line);
      changed();
    };
    const render = () => {
      panel.innerHTML = `<h3>Услуги и стоимость</h3>${lines.map((l, i) => {
        const calc = jrLineCalculation(l);
        return `<section class="jr-line-editor"><div class="jr-line-heading"><strong>${jrEscape(l.title)}</strong><button type="button" data-remove="${i}" aria-label="Удалить услугу">×</button></div><div class="jr-line-fields">${[['quantity','Кол-во'],['unitPrice','Цена, ₽'],['discount','Скидка, %'],['total','Итого, ₽']].map(([key,label]) => `<label>${label}<input type="number" min="${key === 'quantity' ? 1 : 0}" step="${key === 'quantity' ? 1 : '0.01'}" data-edit-line="${i}" data-field="${key}" value="${jrEscape(key === 'total' ? calc?.total ?? l.total : key === 'discount' && l.mode === 'total' ? calc?.discount ?? 0 : l[key])}"></label>`).join('')}</div></section>`;
      }).join('')}<label>Добавить услугу<select id="jrAddService"><option value="">Выберите услугу</option>${choices.filter(s => !lines.some(l => l.serviceId === s.yclientsId)).map(s => `<option value="${s.yclientsId}">${jrEscape(s.title)}</option>`).join('')}</select></label><p class="jr-hint">Длительность визита сохраняется. Изменения отправятся по кнопке «Сохранить изменения».</p>`;
      panel.querySelectorAll('[data-edit-line]').forEach(input => { input.onchange = () => {
        const l = lines[Number(input.dataset.editLine)], key = input.dataset.field;
        const discount = jrLineCalculation(l)?.discount ?? 0;
        l[key] = input.value;
        l.mode = key === 'total' ? 'total' : 'discount';
        if (key !== 'discount') l.discount = discount;
        mark(); render();
      }; });
      panel.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => { lines.splice(Number(b.dataset.remove), 1); mark(); render(); }; });
      jrEl('jrAddService').onchange = e => {
        const s = choices.find(s => s.yclientsId === Number(e.target.value));
        if (!s) return;
        const price = s.staffDetails?.find(x => x.id === record.staffId)?.priceMin ?? s.priceMin ?? 0;
        lines.push({serviceId:s.yclientsId,title:s.title,quantity:1,unitPrice:price,total:price,discount:0,mode:'discount'});
        mark(); render();
      };
    };
    render(); jrEl('jrEditServices').disabled = true;
  };
  jrEl('jrModalBody').querySelectorAll('[data-service-line]').forEach(line => { line.onclick = () => jrEl('jrEditServices').onclick(); });
}

// ---- History of changes (spec 4.2) and client panel (4.4) ----
const jrMskStamp = iso => new Date(iso).toLocaleString('ru', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function jrHistoryHtml(events) {
  if (!events?.length) return '<p class="jr-hint">Изменений не зафиксировано. Журнал вебхуков YClients ведётся с 04.11.2026.</p>';
  return `<ol class="jr-history">${events.map(e => `<li><div class="jr-history-head"><time>${jrEscape(jrMskStamp(e.at))}</time><strong>${jrEscape(e.author)}</strong><span>${jrEscape(e.title)}</span></div>${(e.changes || []).length ? `<ul>${e.changes.map(c => `<li>${jrEscape(c.label || c.field)}: ${jrEscape(c.from ?? '—')} → ${jrEscape(c.to ?? '—')}</li>`).join('')}</ul>` : ''}${e.error ? `<p class="jr-sync-failed-note">${jrEscape(e.error)}${e.errorCode ? ' (' + jrEscape(e.errorCode) + ')' : ''}</p>` : ''}</li>`).join('')}</ol>`;
}
async function jrLoadHistory(id) {
  const box = jrEl('jrHistory'), request = journal.modalRequest;
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<p class="jr-hint">Загрузка истории…</p>';
  try {
    const data = await jrApi(`records/${encodeURIComponent(id)}/history`);
    if (request !== journal.modalRequest) return;
    const html = jrHistoryHtml(data.events);
    journal.history = { request, id, html };
    const now = jrEl('jrHistory');
    if (now) { now.hidden = false; now.innerHTML = html; }
  } catch (e) {
    const now = jrEl('jrHistory');
    if (request === journal.modalRequest && now) now.innerHTML = `<p class="jr-hint">${jrEscape(e.message)}</p>`;
  }
}
function jrClientSummaryHtml(s) {
  if (!s) return '<p class="jr-hint">Нет данных клиента.</p>';
  const v = value => jrEscape(value ?? '—');
  const abonements = s.abonements === null || s.abonements === undefined ? '<p class="jr-hint">Абонементы: не удалось прочитать.</p>'
    : s.abonements.length ? `<ul class="jr-abonements">${s.abonements.map(a => `<li>${jrEscape(a.title)}${a.balance != null ? ' · осталось ' + jrEscape(a.balance) : ''}${a.expires ? ' · до ' + jrEscape(String(a.expires).slice(0, 10)) : ''}${a.frozen ? ' · заморожен' : ''}</li>`).join('')}</ul>`
    : '<p class="jr-hint">Абонементов нет.</p>';
  const last = (s.lastVisits || []).length ? `<h4>Последние визиты</h4><ul class="jr-last-visits">${s.lastVisits.map(x => `<li>${jrEscape(x.date)} · ${jrEscape(x.staffName)} · ${jrEscape((x.services || []).join(', '))} · ${jrEscape(jrStatus({ attendance: x.attendance }))}</li>`).join('')}</ul>` : '';
  const source = s.bonusesSource === 'ledger' ? 'по журналу LoyalPro' : s.bonusesSource === 'card' ? 'по карте YClients' : '';
  return `<div class="jr-client-stats"><p>Визитов<span>${v(s.visits?.success)}</span></p><p>Неявок<span>${v(s.visits?.fail)}</span></p><p>Бонусы<span>${v(s.bonusBalance)}</span></p><p>Уровень<span>${v(s.loyaltyLevel)}</span></p><p>Потрачено<span>${s.totalSpent == null ? '—' : jrEscape(Number(s.totalSpent).toLocaleString('ru-RU') + ' ₽')}</span></p></div>${source ? `<small class="jr-hint">Бонусы ${source}</small>` : ''}<h4>Абонементы</h4>${abonements}${last}`;
}
async function jrLoadClientSummary(r) {
  const box = jrEl('jrClientSummaryBox');
  if (!box) return;
  const phone = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!phone) { box.innerHTML = '<p class="jr-hint">Телефон клиента неизвестен — данных нет.</p>'; return; }
  const request = journal.modalRequest;
  const cached = journal.clientSummary;
  if (cached && cached.phone === phone && cached.request === request) {
    if (cached.html) box.innerHTML = cached.html;
    return; // loaded already, or the request is in flight and will fill the current box
  }
  journal.clientSummary = { phone, request, html: null };
  box.innerHTML = '<p class="jr-hint">Загрузка данных клиента…</p>';
  try {
    const s = await jrApi('clients/summary?' + new URLSearchParams({ phone }));
    if (request !== journal.modalRequest) return;
    const html = jrClientSummaryHtml(s);
    journal.clientSummary = { phone, request, html };
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = html;
  } catch (e) {
    if (request !== journal.modalRequest) return;
    journal.clientSummary = null; // let the next render retry
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = `<p class="jr-hint">Не удалось загрузить данные клиента: ${jrEscape(e.message)}</p>`;
  }
}
