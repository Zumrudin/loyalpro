// Журнал записи: карточка записи. Общая глобальная область с journal.js (префикс jr).
// Card parity with YClients (12.11.2026). Colour palette: one constant.
const JR_COLORS = ['#f4a0a0', '#ffad79', '#f7c76d', '#c5e384', '#9ee5d7', '#a8d8f0', '#b3bdfd', '#d7a6e8'];
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
    <div class="jr-side-label">Цвет записи<div class="jr-colors" role="group" aria-label="Цвет записи"><button type="button" class="jr-color jr-color-none${r.customColor ? '' : ' is-current'}" data-color="" title="Без цвета"${off(can)}>∅</button>${customOut ? `<button type="button" class="jr-color is-current" data-color="${r.customColor}" style="background:${r.customColor}" title="${r.customColor} (свой цвет)"${off(can)}></button>` : ''}${JR_COLORS.map(c => `<button type="button" class="jr-color${r.customColor === c ? ' is-current' : ''}" data-color="${c}" style="background:${c}" title="${c}"${off(can)}></button>`).join('')}</div></div>
    <div class="jr-side-label">Метки${labels.length || orphans.length ? `<div class="jr-labels">${labels.map(l => `<label class="jr-label-choice"><input type="checkbox" data-label="${Number(l.id)}"${chosen.has(Number(l.id)) ? ' checked' : ''}${off(can)}><i class="jr-label-dot" style="background:${JR_HEX.test(l.color || '') ? l.color : '#999999'}"></i>${jrEscape(l.title)}</label>`).join('')}${orphans.map(id => `<label class="jr-label-choice"><input type="checkbox" data-label="${id}" checked disabled>№${id} (нет в справочнике)</label>`).join('')}</div>` : '<p class="jr-hint">Меток в салоне нет.</p>'}</div>
    <label class="jr-notify"><input type="checkbox" id="jrNoNotify"${r.notifyClient === false ? ' checked' : ''}${off(can)}> Не уведомлять клиента</label>
  </section>`;
}
// One field of the card's session edit; enables «Сохранить изменения».
function jrCardEdit(key, value) {
  if (!jrCanEditJournal()) return false;
  if (!journal.session) return;
  journal.session.edit ||= {};
  journal.session.edit[key] = value;
  jrEl('jrSaveChanges').disabled = false;
  // Cancel would contradict the draft (as for status/services edits).
  if (jrEl('jrCancel')) jrEl('jrCancel').disabled = true;
}
function jrDeleteRecord(r) {
  if (!jrCanEditJournal()) return false;
  // Unsaved card edits are not sent with a deletion (the server refuses
  // [edit, delete]): ask first, as «Записать повторно» and closing do.
  const kind = journal.session?.edit ? jrUnsavedKind() : null;
  if (kind) return jrAskClose(kind);
  jrShowModal('Удалить запись');
  journal.draft = { action: 'delete', recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>Удалить запись насовсем? В отличие от отмены (статус «Не пришёл»), удалённая запись исчезнет из журнала. Вернуть её будет нельзя.</p>${r.paid ? '<p>Оплаты этой записи тоже будут удалены.</p>' : ''}<div class="jr-actions"><button type="button" class="btn btn-pri jr-danger" id="jrApply">Да, удалить запись</button><button type="button" class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: 'delete' });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
// «Записать повторно»: the same client and services, the date is chosen anew.
function jrRebook(r) {
  if (!jrCanEditJournal()) return false;
  // Unsaved card edits are not dropped silently: ask first, as on close.
  const kind = journal.session?.edit ? jrUnsavedKind() : null;
  if (kind) return jrAskClose(kind);
  const ids = new Set((r.services || []).map(s => Number(s.id)));
  const serviceIds = (journal.data?.services || []).filter(s => ids.has(Number(s.yclientsId)) && (s.staffIds || []).includes(r.staffId)).map(s => s.id);
  jrForm(null, { staffId: r.staffId, date: '', serviceIds, client: { name: r.clientName, phone: r.clientPhone || '' } });
  journal.formTouched = true; // a preset form counts as changed: closing asks
}

// ---- Record window, laid out like the YClients record window (13.11.2026) ----
// Colours stay LoyalPro's; the structure follows YClients: master/date card,
// pinned comment and tool tiles on the left; status, services, service picker
// and quick payment in the middle; client panel on the right.
function jrDurationText(min) {
  const n = Math.round(Number(min) || 0);
  if (!n) return '';
  const h = Math.floor(n / 60), m = n % 60;
  const hours = h === 1 ? '1 час' : h >= 2 && h <= 4 ? h + ' часа' : h + ' часов';
  return h && m ? `${h} ч ${m} мин` : h ? hours : m + ' мин';
}
function jrTimeRange(record) {
  const start = String(record?.time || '');
  if (!/^\d\d:\d\d$/.test(start)) return start;
  const end = Number(record.duration) > 0 ? ' — ' + jrTimeLabel(jrMinutes(start) + Number(record.duration)) : '';
  const length = jrDurationText(record.duration);
  return start + end + (length ? ' · ' + length : '');
}
function jrPhonePretty(digits) {
  return /^7\d{10}$/.test(digits) ? `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}` : '+' + digits;
}
// A tile of the left/right grids: live (own id) or a disabled placeholder.
function jrTile(title, icon, id = null, extra = '') {
  return id ? `<button type="button" class="jr-tool-live jr-placeholder${extra}" id="${id}">${jrIcon(icon)}<span>${title}</span></button>` : jrStub(title, icon);
}
function jrTools(record, card = false) {
  // Negative IDs are locally queued records.  They already have a LoyalPro
  // history, even though YClients has not assigned an ID yet.
  const live = !!record && Number.isFinite(Number(record.id)) && Number(record.id) !== 0;
  const ids = { 'Списание расходников': card && record ? 'jrConsumablesOpen' : null, 'История изменений': live ? 'jrHistoryOpen' : null,
    'Расширенные поля': card ? 'jrExtraOpen' : null,
    'Повторение записи': card && record && !record.deleted ? 'jrRebook' : null };
  return `<div class="jr-tools">${[['ЕГИСЗ','egisz'],['Текущий прием','plus'],['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell'],['Списание расходников','box'],['История изменений','receipt'],['Лист назначения','receipt']]
    .map(([title, icon]) => jrTile(title, icon, ids[title])).join('')}</div>${live ? '<div id="jrHistory" class="jr-history-box" hidden></div>' : ''}`;
}
function jrPhoneHtml(r) {
  if (!jrCanViewPhones() || r?.capabilities?.canViewPhones === false) return '';
  const digits = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!digits) return '<p class="jr-hint">Телефон не указан</p>';
  const tel = '+' + digits;
  return `<p class="jr-client-phone"><a href="tel:${jrEscape(tel)}">${jrEscape(jrPhonePretty(digits))}</a><button type="button" class="jr-icon-btn" id="jrCopyPhone" data-phone="${jrEscape(tel)}" title="Копировать телефон" aria-label="Копировать телефон">${jrIcon('copy')}</button></p>`;
}
function jrClientPanel(record, creating = false, editable = false) {
  const canSwap = jrCanOpenClientCard() && !creating && editable && record && jrCanReshape(record);
  const name = jrEscape(record?.clientName || 'Клиент');
  return `<aside class="jr-booking-client jr-booking-panel">${canSwap
      ? `<button type="button" class="jr-back-link" id="jrChangeClient">${jrIcon('back')}Сменить клиента</button><div id="jrChangeClientBox" class="jr-fields jr-change-client" hidden><label>Найти клиента<input id="jrClientSearch" type="search" placeholder="Имя или телефон" autocomplete="off"></label><h4 id="jrClientsTitle">Последние клиенты</h4><div id="jrClientResults" aria-live="polite"></div></div>`
      : `<button type="button" class="jr-back-link jr-placeholder" disabled title="Сменить клиента — недоступно для этой записи">${jrIcon('back')}<span>Сменить клиента</span></button>`}
    ${!creating && editable && record
      ? '<div class="jr-client-tabs" role="tablist"><button type="button" role="tab" class="jr-tab is-active" id="jrTabClient" aria-selected="true">Клиент</button><button type="button" role="tab" class="jr-tab" id="jrTabChat" aria-selected="false">Чат</button></div><div id="jrChatPane" class="jr-chat-pane" hidden></div><div id="jrClientPane">'
      : `<div class="jr-client-tabs"><span class="is-active">Клиент</span>${jrStub('Чат','chat','jr-tab-stub')}</div><div>`}${creating
    ? '<div class="jr-fields"><label>Имя клиента<input id="jrName" required maxlength="120" autocomplete="off" placeholder="Имя и фамилия"></label><label>Телефон с кодом страны<input id="jrPhone" required type="tel" maxlength="24" autocomplete="off" placeholder="Введите номер телефона"></label></div>'
    : `<div class="jr-client-head"><div class="jr-client-identity">${editable && record && jrCanOpenClientCard()
      ? `<button type="button" class="jr-client-link" id="jrClientLink" title="Открыть карточку клиента"><span id="jrClientName">${name}</span></button>`
      : `<h3 id="jrClientName">${name}</h3>`}</div><div class="jr-client-acts">${editable && record && jrCanOpenClientCard() ? `<button type="button" class="jr-icon-btn" id="jrClientIcon" title="Карточка клиента" aria-label="Карточка клиента">${jrIcon('user')}</button>` : ''}<button type="button" class="jr-icon-btn jr-placeholder" disabled title="Другие действия — скоро появятся в журнале" aria-label="Другие действия">${jrIcon('dots')}</button></div></div>${editable ? jrPhoneHtml(record) : ''}`}
    <div class="jr-client-tools">${[['Планы лечения','folder'],['Медкарта','medcard'],['История посещений','clock'],['Лояльность','loyalty'],['Счета клиента','wallet']].map(([title, icon]) => {
      const live = !creating && editable && record && { 'Планы лечения': 'jrTreatmentPlansOpen', 'Медкарта': 'jrMedicalCardOpen', 'История посещений': 'jrVisitsOpen', 'Лояльность': 'jrLoyaltyOpen', 'Счета клиента': 'jrClientAccountsOpen' }[title];
      return jrTile(title, icon, live || null);
    }).join('')}</div>
    <label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя</label>
    ${editable ? '<div id="jrClientSummaryBox"><p class="jr-hint">Загрузка данных клиента…</p></div>'
      : '<section class="jr-client-info"><h4>Дополнительно</h4><div class="jr-info-row"><small>Примечание о клиенте</small><span>—</span></div><div class="jr-info-row"><small>Дата рождения</small><span>—</span></div></section><section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>—</span></p><p>Всего визитов<span>—</span></p></div></section>'}
  </div></aside>`;
}
const jrRecordTotal = record => (record?.services || []).reduce((sum, s) => sum + Math.round(Number(s.cost || 0) * 100), 0) / 100;
// live: the record card (quick buttons work); otherwise a read-only copy (move form).
function jrPaymentPanel(record, live = false) {
  const payable = live && record && !record.deleted && record.attendance !== -1;
  const due = record?.paymentSummary?.due ?? (record ? jrRecordTotal(record) : 0);
  if (record?.paidFull && !record.paymentSync) {
    const amount = record.paymentSummary?.paidConfirmed ?? jrRecordTotal(record);
    return `<section class="jr-payment-panel jr-payment-complete-card"><div class="jr-payment-check" aria-hidden="true">${jrIcon('check')}</div><h3 role="status">Оплачено ${jrRub(amount)}</h3><button type="button" class="btn btn-sec" id="jrPaymentOpen" ${payable ? '' : 'disabled'}>Детали оплаты</button></section>`;
  }
  const head = record?.paidFull ? '<span>Оплачено</span><strong>полностью</strong>' : `<span>К оплате</span><strong id="jrPayDue">${jrEscape(due.toLocaleString('ru-RU'))} ₽</strong>`;
  const tile = (key, icon, title, sub, id = '') => payable
    ? `<button type="button" class="jr-quick-pay${key === 'all' ? '' : ' is-quick'}"${id ? ` id="${id}"` : ''} data-quick-pay="${key}">${jrIcon(icon)}<strong>${title}</strong><small>${sub}</small></button>`
    : `<button type="button" class="jr-quick-pay jr-placeholder" disabled title="${record ? 'Оплата этой записи недоступна' : 'Оплата после создания записи'}">${jrIcon(icon)}<span>${title}</span><small>${sub}</small></button>`;
  return `<section class="jr-payment-panel"><div class="jr-pay-due">${head}</div>${record?.paid && !record.paidFull ? '<p class="jr-hint">Есть оплаты — подробности в «Все способы».</p>' : ''}
    ${(record?.paymentDetails || []).map(p => `<div class="jr-paid-row"><span>${jrEscape(p.title)}</span><strong>${jrRub(p.amount)}</strong></div>`).join('')}
    ${record?.paymentSummary?.breakdownIncomplete ? '<p class="jr-hint">Оплата учтена. Детализация из YClients получена не полностью.</p>' : ''}
    <div class="jr-pay-quick-head"><span>Быстрая оплата</span><button type="button" class="jr-link-btn jr-placeholder" disabled title="Настройка быстрой оплаты — скоро появится в журнале">${jrIcon('sliders')}<span>Настроить</span></button></div>
    <div class="jr-pay-quick">${tile('card', 'card', 'Карта', 'Расчётный счёт')}${tile('cash', 'cash', 'Наличные', 'Основная касса')}${tile('all', 'wallet', 'Все способы', 'Бонусы, частичная оплата', 'jrPaymentOpen')}</div></section>`;
}
function jrStatusBar(record, canEdit = false) {
  if (record?.deleted) return `<div class="jr-status-bar"><span class="jr-state-pill is-current">${['queued', 'running'].includes(record.sync?.status) ? record.sync?.status === 'running' ? 'Удаляется…' : 'Удалена (ждёт отправки)' : 'Запись удалена'}</span></div>`;
  const current = record ? record.attendance : 0;
  const states = [[0,'Ожидание','clock'],[1,'Пришёл','plus'],[-1,'Не пришёл','minus'],[2,'Подтвердил','check']];
  return `<div class="jr-status-bar" aria-label="Статус визита">${states.map(([value,label,icon]) => {
    if (value === current && !canEdit) return `<span class="jr-state-pill is-current" aria-current="true">${jrIcon(icon)}${label}</span>`;
    if (canEdit) return `<button type="button" data-attendance="${value}" class="jr-state-pill${value === current ? ' is-current' : ''}">${jrIcon(icon)}${label}</button>`;
    if (jrSyncing(record)) return `<button type="button" class="jr-state-pill" disabled title="Идёт отправка изменений">${jrIcon(icon)}${label}</button>`;
    if (record?.paid) return `<button type="button" class="jr-state-pill" disabled title="Сначала удалите оплаты визита">${jrIcon(icon)}${label}</button>`;
    return jrStub(label,icon,'jr-state-pill');
  }).join('')}</div>`;
}
function jrServiceDuration(record, s) {
  // A saved visit is a snapshot, not today's price-list duration.
  const seconds = Number(s.seance_length);
  if (seconds > 0) return seconds / 60;
  return (record.services || []).length === 1 ? record.duration : null;
}
// Service lines as cards «master · duration / title / price». editable: a card
// opens the editor of quantity and cost (10.11.2026).
function jrServiceCards(record, editable = false) {
  const staffName = jrEscape(journal.data?.staff?.find(s => s.id === record.staffId)?.name || record.staffName || 'Сотрудник');
  const tag = editable ? 'button type="button" data-service-line' : 'div';
  const end = editable ? 'button' : 'div';
  return (record.services || []).map(s => {
    const length = jrDurationText(jrServiceDuration(record, s));
    return `<${tag} class="jr-service-line"${editable ? ' title="Изменить количество и стоимость"' : ''}><small>${staffName}${length ? ' · ' + jrEscape(length) : ''}</small><span>${jrEscape(s.title || 'Услуга')}${Number(s.quantity) > 1 ? ` <small>× ${jrEscape(s.quantity)} по ${jrEscape(Number(s.unitPrice || 0).toLocaleString('ru'))} ₽</small>` : ''}</span><strong>${jrEscape(Number(s.cost || 0).toLocaleString('ru'))} ₽</strong>${editable ? jrIcon('chevron') : ''}</${end}>`;
  }).join('') || '<p class="jr-hint">Услуги не указаны</p>';
}
function jrServicesPanel(record, editable = false) {
  return `<div class="jr-service-lines" id="jrLinesBox">${jrServiceCards(record, editable)}</div>`;
}
// The «Услуги / Товары» block with search, popular services of the master and
// the full catalog tree; a tile adds the service to the visit (card editor).
function jrServicePicker(record) {
  const staffName = journal.data?.staff?.find(s => s.id === record.staffId)?.name || record.staffName || '';
  return `<section class="jr-service-panel">
    <label class="jr-search">${jrIcon('search')}<input id="jrCardServiceSearch" type="search" placeholder="Поиск по услугам" autocomplete="off" aria-label="Поиск по услугам"></label>
    <h5 class="jr-popular-title" id="jrCardQuickTitle">Популярные услуги${staffName ? ': ' + jrEscape(staffName) : ''}</h5>
    <div id="jrCardQuick" class="jr-service-choices"></div>
    <details class="jr-all-services" id="jrCardAllBox"><summary>Все услуги${jrIcon('chevron')}</summary><div id="jrCardAll" class="jr-service-tree"></div></details></section>`;
}
function jrCardServiceMeta(service, staffId) {
  const specific = service.staffDetails?.find(s => s.id === staffId);
  const duration = jrDurationText(specific?.duration || service.duration);
  const price = specific?.priceMin ?? service.priceMin, max = specific?.priceMax ?? service.priceMax;
  return [duration, price != null ? (max > price ? 'от ' : '') + Number(price).toLocaleString('ru-RU') + ' ₽' : ''].filter(Boolean).join(' · ');
}
// Outbox package that could not be delivered to YClients: reason + safe next steps.
function jrSyncAlert(record) {
  const sync = record?.sync;
  if (sync?.status !== 'failed') return '';
  const uncertain = sync.errorCode === 'uncertain';
  return `<div class="jr-sync-alert" role="alert"><strong>Ошибка отправки: ${jrEscape(sync.errorText || 'причина неизвестна')}</strong>${uncertain ? '<p>Нужна сверка — владелец: кнопка «Сверка операций».</p>' : ''}<div class="jr-actions">${uncertain ? '' : '<button type="button" class="btn btn-sec" id="jrSyncRetry">Повторить отправку</button>'}${uncertain ? '' : `<button type="button" class="btn btn-sec" id="jrSyncDismiss">${Number(record.id) < 0 ? 'Убрать из журнала' : 'Отменить неотправленные изменения'}</button>`}</div></div>`;
}
// A record whose changes are only saved locally stays editable (also a new
// record not yet in YClients); a package on its way or failed locks it.
const jrLocked = record => jrSyncing(record) || record.sync?.status === 'failed';
const jrCanChange = record => jrCanEditJournal() && !record.deleted && !record.paid && !jrLocked(record);
// Duration, client and deletion additionally exclude an arrived visit (spec §4.1).
const jrCanReshape = record => jrCanChange(record) && record.attendance !== 1;
// A new record saved only in the journal is deleted locally whatever its status
// and payments: nothing about it has left LoyalPro (sessions.deleteUnsent).
const jrCanDeleteUnsent = record => jrCanEditJournal() && !record.deleted && Number(record.id) < 0 && jrUnsent(record);
const jrCanEdit = record => jrCanEditJournal() && !record.deleted && record.attendance !== -1 && record.attendance !== 1 && !record.paid && !jrLocked(record);
function jrReadonlyAppointmentCard(record) {
  const staff = journal.data?.staff?.find(item => item.id === record.staffId);
  return `<section class="jr-booking-panel jr-readonly-card"><p class="jr-hint">Только просмотр</p>
    <h3>${jrEscape(record.clientName || 'Клиент')}</h3>
    <p>${jrEscape(record.date || '')} · ${jrEscape(jrTimeRange(record))} · ${jrEscape(staff?.name || record.staffName || 'Сотрудник')}</p>
    <p>${jrEscape(jrStatus(record))}</p>${jrServicesPanel(record, false)}
    ${record.comment ? '<h4>Комментарий к записи</h4><p>' + jrEscape(record.comment) + '</p>' : ''}
    <button type="button" class="btn btn-sec" id="jrHistoryOpen">История изменений</button><div id="jrHistory" class="jr-history-box" hidden></div></section>`;
}
function jrAppointmentCard(record) {
  if (!jrCanEditJournal() || record.capabilities?.canEdit === false) return jrReadonlyAppointmentCard(record);
  const canEdit = jrCanEdit(record),
    canChange = jrCanChange(record);
  const editNote = jrSyncing(record)
    ? "Идёт отправка изменений — карточка обновится автоматически."
    : record.sync?.status === "failed"
      ? "Сначала повторите или отмените неотправленные изменения."
      : canChange
        ? `Перенос и отмена недоступны для визита со статусом «${record.attendance === 1 ? "Пришёл" : "Не пришёл"}». Статус, услуги и стоимость можно менять.`
        : record.paid
          ? "Визит оплачен: чтобы изменить статус, услуги или стоимость, сначала удалите оплаты («Все способы»)."
          : "Этот визит сейчас изменить нельзя.";
  const staff = journal.data?.staff?.find((s) => s.id === record.staffId);
  const staffName = staff?.name || record.staffName || "Сотрудник";
  const initials = staffName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0] || "")
    .join("");
  const avatar =
    staff?.avatar && /^https:\/\//.test(staff.avatar)
      ? `<img class="jr-staff-avatar" src="${jrEscape(staff.avatar)}" alt="" loading="lazy">`
      : `<span class="jr-staff-avatar">${jrEscape(initials)}</span>`;
  const day = record.date
    ? new Date(record.date + "T12:00:00+03:00").toLocaleDateString("ru", {
        day: "numeric",
        month: "long",
        timeZone: "Europe/Moscow",
      })
    : "Дата не указана";
  return `${jrSyncAlert(record)}<div class="jr-booking-layout"><aside class="jr-booking-side"><div class="jr-visit-summary"><div class="jr-staff-identity">${avatar}<div><strong>${jrEscape(staffName)}</strong><small>${jrEscape(staff?.specialization||"Специалист")}</small></div></div><div class="jr-visit-date"><span class="jr-date-icon">${jrIcon("calendar")}</span><div><strong>${jrEscape(day)}</strong><small>${jrEscape(jrTimeRange(record))}</small></div></div>
      <div class="jr-move-row">${canEdit?`<button type="button" class="btn btn-sec jr-move-btn" id="jrMove">${jrIcon("move")}Перенести запись</button>`:`<button type="button" class="btn btn-sec jr-move-btn" disabled title="${jrEscape(editNote)}">${jrIcon("move")}Перенести запись</button>`}<button type="button" class="btn btn-sec jr-pencil" id="jrExtraToggle" title="Длительность, перерыв, цвет, метки" aria-label="Длительность, перерыв, цвет, метки" aria-expanded="false" aria-controls="jrExtraBox">${jrIcon("pencil")}</button></div></div>
    <div id="jrExtraBox" class="jr-extra-box" hidden>${jrExtraFields(record)}</div>
    <h4 class="jr-pinned">${jrIcon("pin")}Закрепленные поля</h4>
    <label class="jr-side-label">Комментарий к записи<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан"${canChange?"":" readonly"}>${jrEscape(record.comment||"")}</textarea></label>${jrTools(record,true)}</aside>
    <section class="jr-booking-main jr-booking-panel">${jrStatusBar(record,canChange)}${!canEdit?`<p class="jr-hint">${jrEscape(editNote)}</p>`:""}${jrServicesPanel(record,canChange)}<div id="jrGoodsLines" class="jr-goods-lines" aria-live="polite"></div><p id="jrGoodsSummary" class="jr-goods-summary"></p><div id="jrGoodsPayment"></div><p id="jrGoodsError" role="alert"></p><div class="jr-service-tabs"><button type="button" id="jrTabServices" class="is-active" ${UIEvents.attrs("click","journal-card-1",[])}>${jrIcon("list")} Услуги</button><button type="button" id="jrTabGoods" ${UIEvents.attrs("click","journal-card-2",[])}>${jrIcon("box")} Товары</button></div><div id="jrServicesPane">${canChange?'<button type="button" id="jrEditServices" hidden>Изменить услуги, количество и стоимость</button>'+jrServicePicker(record):""}</div><div id="jrGoodsPane" hidden></div><div id="jrConsumablesPane" hidden></div>${jrPaymentPanel(record,true)}</section>${jrClientPanel(record,false,true)}</div>
    <footer class="jr-booking-footer">${canEdit?'<button type="button" class="btn btn-sec" id="jrCancel">Отменить запись</button>':""}${jrCanReshape(record)||jrCanDeleteUnsent(record)?'<button type="button" class="btn btn-sec" id="jrDelete">Удалить запись</button>':""}${canChange?'<button type="button" class="btn btn-pri" id="jrSaveChanges" disabled>Сохранить запись</button>':jrStub("Сохранить запись","check","jr-stub-inline")}</footer>`;
}

// These client modules are not available in the journal yet. They still use
// the same page transition so every tile has predictable navigation and makes
// the limitation explicit instead of looking broken or silently doing nothing.
function jrOpenUnavailable(title) {
  const state = jrSectionOpen(title, 'jr-dialog-unavailable');
  if (!state) return;
  state.page.innerHTML = `<div class="jr-section-empty"><p class="jr-hint">Раздел «${jrEscape(title)}» пока недоступен в журнале записи.</p><button type="button" class="btn btn-sec" data-jr-section-back>К записи</button></div>`;
  state.page.querySelector('[data-jr-section-back]')?.addEventListener('click', () => jrSectionClose());
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
    jrEl('jrModal').classList?.add('jr-dialog-card');
    jrSetCardStatus(r.deleted ? null : r.attendance);
    if (jrEl('jrModal')?.dataset) { if (r.paidFull) jrEl('jrModal').dataset.paidFull = '1'; else delete jrEl('jrModal').dataset.paidFull; }
    if (!jrCanEditJournal() || r.capabilities?.canEdit === false) { jrBindHistory(r); return; }
    if (!r.deleted && r.attendance !== -1) {
      jrEl('jrPaymentOpen').onclick = () => jrPayFromCard(r.id);
      // Quick payment preselects the method in the payment form.
      jrEl('jrModalBody').querySelectorAll('.jr-quick-pay.is-quick').forEach(b => { b.onclick = () => jrPayFromCard(r.id, b.dataset.quickPay); });
    }
    const extraBox = jrEl('jrExtraBox'), extraToggle = jrEl('jrExtraToggle');
    const toggleExtra = () => {
      extraBox.hidden = !extraBox.hidden;
      extraToggle.setAttribute?.('aria-expanded', String(!extraBox.hidden));
      extraToggle.classList?.toggle('is-current', !extraBox.hidden);
    };
    if (extraBox && extraToggle) extraToggle.onclick = toggleExtra;
    if (extraBox && jrEl('jrExtraOpen')) jrEl('jrExtraOpen').onclick = toggleExtra;
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
    if ((jrCanReshape(r) || jrCanDeleteUnsent(r)) && jrEl('jrDelete')) jrEl('jrDelete').onclick = () => jrDeleteRecord(r);
    if (!r.deleted && jrEl('jrRebook')) jrEl('jrRebook').onclick = () => jrRebook(r);
    if (jrEl('jrVisitsOpen')) jrEl('jrVisitsOpen').onclick = () => jrOpenVisits(r);
    if (jrEl('jrLoyaltyOpen')) jrEl('jrLoyaltyOpen').onclick = () => jrOpenLoyalty(r);
    for (const [id, title] of [['jrTreatmentPlansOpen', 'Планы лечения'], ['jrMedicalCardOpen', 'Медкарта'], ['jrClientAccountsOpen', 'Счета клиента']]) {
      if (jrEl(id)) jrEl(id).onclick = () => jrOpenUnavailable(title);
    }
    if (jrEl('jrClientLink')) jrEl('jrClientLink').onclick = () => jrOpenClientCard(r);
    if (jrEl('jrClientIcon')) jrEl('jrClientIcon').onclick = () => jrOpenClientCard(r);
    // «Клиент / Чат»: the chat pane loads our conversation with this client.
    if (jrEl('jrTabChat')) {
      jrEl('jrTabChat').onclick = () => jrChatShowTab(r, 'chat');
      jrEl('jrTabClient').onclick = () => jrChatShowTab(r, 'client');
    }
    jrBindHistory(r);
    // Lazy, once per opened card; errors stay inside the panel.
    if (jrCanUseStock() && typeof jrStockBind === 'function') jrStockBind(r);
    if (!jrCanUseStock()) for (const id of ['jrTabGoods', 'jrConsumablesOpen']) { const el = jrEl(id); if (el) { el.disabled = true; el.hidden = true; } }
    jrLoadClientSummary(r);
}
function jrBindHistory(r) {
    const historyBtn = jrEl('jrHistoryOpen');
    if (historyBtn) {
      historyBtn.setAttribute?.('aria-controls', 'jrHistory');
      historyBtn.setAttribute?.('aria-expanded', String(!!jrHistoryState(r.id)?.open));
      historyBtn.onclick = () => jrToggleHistory(r.id);
      // Polling while a package is being sent re-renders the card. Preserve
      // both states: an intentionally closed panel must stay closed, and a
      // loaded/open panel must retain its contents.
      const kept = jrHistoryState(r.id), history = jrEl('jrHistory');
      if (kept && history) {
        history.hidden = !kept.open;
        history.innerHTML = kept.html || (kept.loading ? '<p class="jr-hint">Загрузка истории…</p>' : '');
        historyBtn.setAttribute?.('aria-expanded', String(kept.open));
        // The card may be re-rendered by the local outbox poll. Refresh an
        // open audit trail at once; jrLoadHistory's loading flag prevents a
        // second request while the previous refresh is still in flight.
        if (kept.open && !kept.loading) void jrLoadHistory(r.id);
      }
    }
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
  if (!jrCanEditJournal()) return false;
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
  if (!jrCanEditJournal()) return false;
  jrShowModal(action === 'cancel' ? 'Отменить запись' : 'Подтвердить запись');
  journal.draft = { action, recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>${action === 'cancel' ? 'Отменить визит? Будет установлен статус «Не пришёл», длительность сократится до 5 минут.' : 'Подтвердить запись?'}</p><div class="jr-actions"><button class="btn btn-pri" id="jrApply">${action === 'cancel' ? 'Да, отменить запись' : 'Подтвердить запись'}</button><button class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: action });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
// «Оплата визита» from the card (11.11.2026): an unsaved status/services edit
// (typically «Пришёл») is saved as its own package first, then the payment form
// opens. Before, the button was disabled after any change and the cashier had
// to save, reopen the card and only then pay.
async function jrPayFromCard(recordId, preferred = 'all') {
  if (!jrCanEditJournal()) return false;
  if (journal.busy) return;
  if (journal.session?.edit && !journal.payment) {
    const saved = await jrSave(jrSessionBody());
    if (!saved) return false;
  }
  return preferred === 'all' ? jrOpenPayment(recordId) : jrOpenPayment(recordId, preferred);
}
function jrBindRecordEdit(record) {
  if (!jrCanEditJournal()) return false;
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
  // Services editor: the lines box turns into editors of quantity and cost;
  // the picker below adds services (an existing one gets +1 to its quantity).
  const choices = (journal.data?.services || []).filter(s => s.yclientsId > 0 && (s.staffIds || []).includes(record.staffId));
  let lines = null;
  const mark = () => {
    journal.session.edit ||= {};
    journal.session.edit.lines = lines.map(({ title, ...line }) => line);
    changed();
  };
  const renderLines = () => {
    const box = jrEl('jrLinesBox');
    box.innerHTML = lines.map((l, i) => {
      const calc = jrLineCalculation(l);
      return `<section class="jr-line-editor"><div class="jr-line-heading"><strong>${jrEscape(l.title)}</strong><button type="button" data-remove="${i}" aria-label="Удалить услугу">×</button></div><div class="jr-line-fields">${[['quantity','Кол-во'],['unitPrice','Цена, ₽'],['discount','Скидка, %'],['total','Итого, ₽']].map(([key,label]) => `<label>${label}<input type="number" min="${key === 'quantity' ? 1 : 0}" step="${key === 'quantity' ? 1 : '0.01'}" data-edit-line="${i}" data-field="${key}" value="${jrEscape(key === 'total' ? calc?.total ?? l.total : key === 'discount' && l.mode === 'total' ? calc?.discount ?? 0 : l[key])}"></label>`).join('')}</div></section>`;
    }).join('') + '<p class="jr-hint">Длительность визита сохраняется. Добавить услугу — в блоке «Услуги» ниже.</p>';
    // «К оплате» follows the draft (until saved it is the draft total).
    const totals = lines.map(jrLineCalculation), due = jrEl('jrPayDue');
    if (due) due.textContent = totals.every(Boolean) ? (totals.reduce((sum, t) => sum + Math.round(t.total * 100), 0) / 100).toLocaleString('ru-RU') + ' ₽' : 'Проверьте стоимость';
    box.querySelectorAll('[data-edit-line]').forEach(input => { input.onchange = () => {
      const l = lines[Number(input.dataset.editLine)], key = input.dataset.field;
      const discount = jrLineCalculation(l)?.discount ?? 0;
      l[key] = input.value;
      l.mode = key === 'total' ? 'total' : 'discount';
      if (key !== 'discount') l.discount = discount;
      mark(); renderLines();
    }; });
    box.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => { lines.splice(Number(b.dataset.remove), 1); mark(); renderLines(); }; });
  };
  const startEdit = () => {
    if (!lines) lines = record.services.map(s => ({ serviceId: s.id, title: s.title, quantity: s.quantity || 1,
      unitPrice: s.unitPrice ?? s.cost, total: s.cost, mode: 'total', discount: 0 }));
    renderLines();
  };
  const addService = id => {
    const s = choices.find(x => x.yclientsId === Number(id));
    if (!s) return;
    if (!lines) startEdit();
    const same = lines.find(l => l.serviceId === s.yclientsId);
    if (same) {
      const discount = jrLineCalculation(same)?.discount ?? 0;
      same.quantity = Number(same.quantity) + 1; same.mode = 'discount'; same.discount = discount;
    } else {
      const price = s.staffDetails?.find(x => x.id === record.staffId)?.priceMin ?? s.priceMin ?? 0;
      lines.push({ serviceId: s.yclientsId, title: s.title, quantity: 1, unitPrice: price, total: price, discount: 0, mode: 'discount' });
    }
    mark(); renderLines();
    notify(`Добавлено: ${s.title}. Сохраните запись.`);
  };
  jrEl('jrEditServices').onclick = startEdit;
  jrEl('jrModalBody').querySelectorAll('[data-service-line]').forEach(line => { line.onclick = startEdit; });
  const renderPicker = () => {
    const quick = jrEl('jrCardQuick'), all = jrEl('jrCardAll');
    if (!quick || !all) return;
    const query = String(jrEl('jrCardServiceSearch')?.value || '').trim().toLowerCase();
    const last = new Set();
    const summary = journal.clientSummary?.request === journal.modalRequest ? journal.clientSummary : null;
    for (const v of summary?.lastVisits || []) for (const t of v.services || []) last.add(String(t).toLowerCase());
    const tile = s => `<button type="button" class="jr-service-choice" data-add-service="${s.yclientsId}"><span>${jrEscape(s.title)}</span><small>${jrEscape(jrCardServiceMeta(s, record.staffId))}</small>${last.has(String(s.title).toLowerCase()) ? '<em class="jr-last-tag">Последний визит</em>' : ''}</button>`;
    const popular = query ? choices.filter(s => s.title.toLowerCase().includes(query))
      : [...choices.filter(s => last.has(String(s.title).toLowerCase())), ...choices.filter(s => !last.has(String(s.title).toLowerCase()))].slice(0, 3);
    if (jrEl('jrCardQuickTitle')) jrEl('jrCardQuickTitle').hidden = !!query;
    quick.innerHTML = popular.slice(0, query ? 12 : 3).map(tile).join('') || '<p class="jr-hint">Услуги не найдены</p>';
    const expanded = new Set(Array.from(all.querySelectorAll('details[open]')).map(node => node.dataset.categoryId));
    all.innerHTML = journal.data ? jrServiceCategoryTree(choices, tile, query, expanded) : '';
    jrEl('jrModalBody').querySelectorAll('[data-add-service]').forEach(b => { b.onclick = () => addService(b.dataset.addService); });
  };
  if (jrEl('jrCardServiceSearch')) jrEl('jrCardServiceSearch').oninput = renderPicker;
  journal.cardPicker = { request: journal.modalRequest, render: renderPicker };
  renderPicker();
}

// ---- History of changes (spec 4.2) and client panel (4.4) ----
const jrMskStamp = iso => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const jrHistoryValue = value => {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
};
const jrHistoryAuthor = event => event?.author || 'Автор не указан';
function jrHistoryHtml(events) {
  if (!events?.length) return '<p class="jr-hint">Изменений не зафиксировано. История изменений ведётся с 04.11.2026.</p>';
  return `<ol class="jr-history">${events.map(e => `<li><div class="jr-history-head"><time>${jrEscape(jrMskStamp(e.at))}</time><strong>${jrEscape(jrHistoryAuthor(e))}</strong><span>${jrEscape(e.title || 'Изменение')}</span></div>${(e.changes || []).length ? `<ul>${e.changes.map(c => `<li>${jrEscape(c.label || c.field || 'Поле')}: ${jrEscape(jrHistoryValue(c.from))} → ${jrEscape(jrHistoryValue(c.to))}</li>`).join('')}</ul>` : ''}${e.error ? `<p class="jr-sync-failed-note">${jrEscape(e.error)}${e.errorCode ? ' (' + jrEscape(e.errorCode) + ')' : ''}</p>` : ''}</li>`).join('')}</ol>`;
}
function jrHistoryState(id) {
  const state = journal.history;
  return state && state.request === journal.modalRequest && String(state.id) === String(id) ? state : null;
}
function jrToggleHistory(id) {
  const box = jrEl('jrHistory');
  if (!box) return;
  const current = jrHistoryState(id);
  if (current?.open) {
    current.open = false;
    box.hidden = true;
    jrEl('jrHistoryOpen')?.setAttribute?.('aria-expanded', 'false');
    return;
  }
  if (current) {
    current.open = true;
    box.hidden = false;
    jrEl('jrHistoryOpen')?.setAttribute?.('aria-expanded', 'true');
    if (current.loading) {
      box.innerHTML = current.html || '<p class="jr-hint">Загрузка истории…</p>';
      return;
    }
    // The panel is a live audit trail. Reopening it refreshes local events
    // immediately, including payments and queued edits.
    return jrLoadHistory(id);
  }
  jrEl('jrHistoryOpen')?.setAttribute?.('aria-expanded', 'true');
  return jrLoadHistory(id);
}
async function jrLoadHistory(id) {
  const box = jrEl('jrHistory'), request = journal.modalRequest;
  if (!box) return;
  let state = jrHistoryState(id);
  if (state?.loading) {
    box.hidden = !state.open;
    return;
  }
  state = { request, id, open: true, loading: true, html: state?.html || null };
  journal.history = state;
  box.hidden = false;
  box.innerHTML = '<p class="jr-hint">Загрузка истории…</p>';
  try {
    const data = await jrApi(`records/${encodeURIComponent(id)}/history`);
    if (request !== journal.modalRequest || journal.history !== state) return;
    const html = jrHistoryHtml(data.events);
    state.loading = false;
    state.html = html;
    const now = jrEl('jrHistory');
    if (now) { now.hidden = !state.open; now.innerHTML = html; }
  } catch (e) {
    if (request !== journal.modalRequest || journal.history !== state) return;
    state.loading = false;
    state.html = `<p class="jr-hint">${jrEscape(e.message)}</p>`;
    const now = jrEl('jrHistory');
    if (now) { now.hidden = !state.open; now.innerHTML = state.html; }
  }
}
const jrLongDate = iso => /^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? new Date(String(iso).slice(0, 10) + 'T12:00:00+03:00').toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(/\s*г\.$/, '') : null;
function jrAge(iso, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const today = new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
  let age = Number(today.slice(0, 4)) - Number(m[1]);
  if (today.slice(5) < `${m[2]}-${m[3]}`) age--;
  if (age < 0 || age > 130) return null;
  const tail = age % 10, teen = age % 100 >= 11 && age % 100 <= 14;
  return `${age} ${teen ? 'лет' : tail === 1 ? 'год' : tail >= 2 && tail <= 4 ? 'года' : 'лет'}`;
}
// «Дополнительно» and «Статистика» of the client panel (local data, abonements live).
function jrClientSummaryHtml(s) {
  if (!s) return '<p class="jr-hint">Нет данных клиента.</p>';
  const v = value => jrEscape(value ?? '—');
  const add = label => `<button type="button" class="jr-add-stub jr-placeholder" disabled title="${jrEscape(label)} — скоро появится в журнале">${jrIcon('plus')}<span>${jrEscape(label)}</span></button>`;
  const birth = jrLongDate(s.birthday);
  const age = birth ? jrAge(s.birthday) : null;
  const extra = `<section class="jr-client-info"><h4>Дополнительно</h4>
    <div class="jr-info-row"><small>Примечание о клиенте</small>${s.note ? `<span class="jr-note">${jrEscape(s.note)}</span>` : add('Добавить примечание')}</div>
    <div class="jr-info-row"><small>Дата рождения</small><span>${birth ? jrEscape(birth + (age ? ', ' + age : '')) : '-'}</span></div>
    <div class="jr-info-row"><small>Дополнительный телефон</small><span>-</span></div>
    <div class="jr-info-row"><small>Номер договора</small>${s.contractNo ? `<span>${jrEscape(s.contractNo)}</span>` : add('Добавить «Номер договора»')}</div></section>`;
  const abonements = s.abonements === null || s.abonements === undefined ? '<p class="jr-hint">Абонементы: не удалось прочитать.</p>'
    : s.abonements.length ? `<ul class="jr-abonements">${s.abonements.map(a => `<li>${jrEscape(a.title)}${a.balance != null ? ' · осталось ' + jrEscape(a.balance) : ''}${a.expires ? ' · до ' + jrEscape(String(a.expires).slice(0, 10)) : ''}${a.frozen ? ' · заморожен' : ''}</li>`).join('')}</ul>`
    : '<p class="jr-hint">Абонементов нет.</p>';
  const last = (s.lastVisits || []).length ? `<h5>Последние визиты</h5><ul class="jr-last-visits">${s.lastVisits.map(x => `<li>${jrEscape(x.date)} · ${jrEscape(x.staffName)} · ${jrEscape((x.services || []).join(', '))} · ${jrEscape(jrStatus({ attendance: x.attendance }))}</li>`).join('')}</ul>` : '';
  const source = s.bonusesSource === 'ledger' ? 'по журналу LoyalPro' : s.bonusesSource === 'card' ? 'по карте лояльности' : '';
  const lastVisit = jrLongDate(s.lastVisitDate);
  return `${extra}<section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>${lastVisit ? jrEscape(lastVisit) : '—'}</span></p><p>Всего визитов<span>${v(s.visits?.success)}</span></p><p>Неявок<span>${v(s.visits?.fail)}</span></p><p>Бонусы<span>${v(s.bonusBalance)}</span></p><p>Уровень<span>${v(s.loyaltyLevel)}</span></p><p>Потрачено<span>${s.totalSpent == null ? '—' : jrEscape(Number(s.totalSpent).toLocaleString('ru-RU') + ' ₽')}</span></p></div>${source ? `<small class="jr-hint">Бонусы ${source}</small>` : ''}<h5>Абонементы</h5>${abonements}${last}</section>`;
}
async function jrLoadClientSummary(r) {
  if (!jrCanUseClientTools()) return;
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
    journal.clientSummary = { phone, request, html, clientId: s?.clientId ?? null, lastVisits: s?.lastVisits || [] };
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = html;
    if (journal.cardPicker?.request === request) journal.cardPicker.render();
  } catch (e) {
    if (request !== journal.modalRequest) return;
    journal.clientSummary = null; // let the next render retry
    const now = jrEl('jrClientSummaryBox');
    if (now) now.innerHTML = `<p class="jr-hint">Не удалось загрузить данные клиента: ${jrEscape(e.message)}</p>`;
  }
}
// The client name opens the LoyalPro client card (clients.js openCD). The journal
// dialog is modal (top layer), so it is closed first; unsaved edits ask as on ✕.
async function jrOpenClientCard(r) {
  if (!jrCanOpenClientCard()) return false;
  const kind = jrUnsavedKind();
  if (kind) return jrAskClose(kind);
  const phone = String(r?.clientPhone || '').replace(/\D/g, '');
  if (!phone) return jrMessage('Телефон клиента неизвестен — карточку клиента найти нельзя.');
  const request = journal.modalRequest;
  let id = journal.clientSummary?.phone === phone ? journal.clientSummary.clientId : undefined;
  if (id === undefined) {
    try { id = (await jrApi('clients/summary?' + new URLSearchParams({ phone })))?.clientId ?? null; }
    catch (e) { if (request === journal.modalRequest) jrMessage(e.message); return; }
    if (request !== journal.modalRequest) return;
  }
  if (!id) return jrMessage('Клиента нет в базе LoyalPro.');
  if (typeof openCD !== 'function') return jrMessage('Карточка клиента недоступна.');
  jrClose(true);
  openCD(id);
}
