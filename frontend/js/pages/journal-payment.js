// Журнал записи: форма оплаты визита. Общая глобальная область с journal.js (префикс jr).
// Payment form. Choosing methods only edits the session (no server calls);
// «Готово» or confirmed closing sends everything once.
const jrKop = value => Math.round((Number(value) || 0) * 100);
const jrRub = value => Number(value).toLocaleString('ru-RU') + ' ₽';
function jrPaymentView(base, session) {
  const pays = session?.payments || [], removes = session?.removePayments || [];
  const sum = (list, filter = () => true) => list.filter(filter).reduce((n, p) => n + jrKop(p.amount), 0);
  const baseDue = jrKop(base.due);
  const due = Math.max(0, baseDue - sum(pays) + sum(removes));
  const isBonus = p => p.method === 'loyalty_card';
  const bonusNet = sum(pays, isBonus) - sum(removes, isBonus);
  const arrived = pays.some(p => p.confirmArrival === true);
  const methods = (base.methods || []).map(v => {
    if (v.method === 'loyalty_card') {
      const limit = Math.max(0, Math.min(jrKop(v.limit) - bonusNet, due));
      return { ...v, limit: limit / 100, available: limit > 0, unavailableReason: limit > 0 ? null : v.unavailableReason || 'Нет доступных бонусов' };
    }
    // An account was unavailable only because the visit was paid: it reopens when due appears.
    const open = v.available === true || baseDue === 0;
    return { ...v, limit: due / 100, available: open && due > 0, unavailableReason: open && due > 0 ? null : open ? 'Визит оплачен' : v.unavailableReason,
      requiresArrivalConfirmation: v.requiresArrivalConfirmation === true && !arrived };
  });
  return { ...base, due: due / 100, methods };
}
function jrPayTitle(t) {
  if (t.method === 'loyalty_card') return 'Бонусы';
  const m = (journal.payment?.base?.methods || []).find(v => v.method === t.method && Number(v.id) === Number(t.methodId));
  return m ? (m.cash ? 'Наличные' : 'Банковская карта') + ' · ' + m.title : 'Касса';
}
const JR_PAY_STATUS = { confirmed: 'Проведено в YClients', queued: 'Ждёт отправки в YClients', sending: 'Передаётся в YClients', failed: 'Ошибка отправки' };
const jrPayBadge = status => JR_PAY_STATUS[status] ? `<em class="jr-pay-badge jr-pay-badge-${jrEscape(status)}">${jrEscape(JR_PAY_STATUS[status])}</em>` : '';
// Bill lines: «цена × кол-во, скидка −N ₽ (P %)». Old/live responses carry only `total`.
function jrBillItem(i) {
  const detailed = i.unitPrice !== undefined && i.unitPrice !== null;
  const detail = detailed ? `${jrRub(i.unitPrice)} × ${jrEscape(i.quantity)}${Number(i.discount) > 0 ? `, скидка −${jrRub(i.discount)}${Number(i.discountPercent) > 0 ? ` (${jrEscape(i.discountPercent)} %)` : ''}` : ''}` : `×${jrEscape(i.quantity)}`;
  return `<p>${jrEscape(i.title)}<small>${detail}</small><strong>${jrRub(i.total)}</strong></p>`;
}
function jrBillSummary(data, session) {
  const sm = data.summary;
  if (!sm) return '';
  const sum = (list, filter) => (list || []).filter(filter).reduce((n, x) => n + jrKop(x.amount), 0);
  const isBonus = x => x.method === 'loyalty_card';
  const bonusDelta = sum(session?.payments, isBonus) - sum(session?.removePayments, isBonus);
  const bonus = (data.methods || []).find(v => v.method === 'loyalty_card');
  const row = (label, value, cls = '') => `<div class="jr-bill-sum${cls}"><span>${label}</span><strong>${value}</strong></div>`;
  return `<div class="jr-bill-summary">${row('Без скидки', jrRub(sm.gross))}${Number(sm.discount) > 0 ? row('Скидка', '−' + jrRub(sm.discount)) : ''}${row('Итого к оплате за визит', jrRub(sm.total), ' jr-bill-sum-total')}`
    + `${Number(sm.bonusSpent) > 0 || bonusDelta > 0 ? row('Бонусов списано', jrRub((jrKop(sm.bonusSpent) + bonusDelta) / 100)) : ''}`
    + `${bonus && bonus.balanceAfter !== undefined && bonus.balanceAfter !== null ? row('Баланс бонусов после оплаты', jrRub(Math.max(0, jrKop(bonus.balanceAfter) - bonusDelta) / 100)) : ''}</div>`;
}
function jrPaymentBreakdown(data, session, readOnly = false) {
  const removed = new Set((session?.removePayments || []).map(t => t.method + ':' + t.transactionId));
  const real = (data.paid || []).map((t, i) => {
    const gone = removed.has(t.method + ':' + t.id);
    return `<div class="jr-paid-row${gone ? ' jr-pay-queued jr-pay-removed' : ''}"><span>${jrEscape(t.title)}${gone ? '<small>будет удалено</small>' : Array.isArray(data.payments) ? jrPayBadge('confirmed') : ''}</span><strong>${jrRub(t.amount)}</strong>${readOnly ? '' : gone
      ? `<button type="button" data-restore-payment="${i}" title="Не удалять" aria-label="Не удалять транзакцию ${jrEscape(t.title)}">↺</button>`
      : `<button type="button" data-remove-payment="${i}" title="Удалить транзакцию" aria-label="Удалить транзакцию ${jrEscape(t.title)}">${jrIcon('trash')}</button>`}</div>`;
  });
  // Server-side queue (not yet confirmed in YClients): payments and cancellations.
  const server = (Array.isArray(data.payments) ? data.payments : []).filter(t => t.status !== 'confirmed').map(t => {
    const cancel = t.kind === 'remove_payment';
    return `<div class="jr-paid-row jr-pay-queued jr-pay-server${cancel ? ' jr-pay-cancel' : ''}"><span>${cancel ? 'Отмена оплаты · ' : ''}${jrEscape(t.title)}${jrPayBadge(t.status)}</span><strong>${cancel ? '−' : ''}${jrRub(t.amount)}</strong></div>`;
  });
  const queued = (session?.payments || []).map((t, i) => `<div class="jr-paid-row jr-pay-queued"><span>${jrEscape(jrPayTitle(t))}<small>будет передано${t.confirmArrival ? ' · с отметкой прихода' : ''}</small></span><strong>${jrRub(t.amount)}</strong><button type="button" data-drop-payment="${i}" title="Убрать оплату" aria-label="Убрать оплату ${jrEscape(jrPayTitle(t))}">×</button></div>`);
  return `<h4>Оплаты визита</h4>${[...real, ...server, ...queued].join('') || '<p class="jr-hint">Оплат пока нет</p>'}`;
}
function jrPaymentShow(base, opts = {}) {
  const prev = journal.payment;
  const recordId = journal.session?.create ? null : journal.session?.recordId ?? null;
  // A queued create (negative id) is paid like any record (11.11.2026): the
  // server queues the payment package after the create package (create_outbox_id).
  journal.payment = { recordId, base, live: !!opts.live, preferred: opts.preferred || prev?.preferred || 'all', readOnly: false };
  jrRenderPayment(opts.keepScroll !== false);
}
function jrPreferredMethod(v, preferred) {
  if (v.method !== 'account') return false;
  return preferred === 'cash' ? v.cash === true : preferred === 'card' ? v.cash !== true : false;
}
function jrRenderPayment(keepScroll = true) {
  const p = journal.payment, session = journal.session;
  if (!p || !session) return;
  const data = jrPaymentView(p.base, session);
  p.data = data; delete p.arrival;
  const scroll = jrEl('jrModal').scrollTop;
  const dirty = jrSessionPending();
  const preferredIndex = data.methods.findIndex(v => v.available && v.limit && jrPreferredMethod(v, p.preferred));
  const bill = `<aside class="jr-payment-bill"><h3>Общий счёт</h3>${(data.items || []).map(jrBillItem).join('')}${jrBillSummary(data, session)}<div class="jr-bill-total">${data.summary ? 'Остаток к оплате' : 'К оплате'} <strong>${jrRub(data.due)}</strong></div>${jrPaymentBreakdown(data, session, p.readOnly)}`;
  if (p.readOnly) {
    jrEl('jrModalBody').innerHTML = `<div class="jr-payment-layout">${bill}${data.due === 0 ? '<div class="jr-payment-success" role="status">✓ Будет оплачено полностью</div>' : ''}</aside><section class="jr-payment-content"><h3>Оплата визита</h3><p class="jr-hint">Оплата станет доступна после передачи записи в YClients</p><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayDone">Готово</button><button type="button" class="btn btn-sec" id="jrPayBack">К записи</button><button type="button" class="btn btn-sec" id="jrPayClose">Закрыть</button></div></section></div>`;
    jrEl('jrModal').scrollTop = keepScroll ? scroll : 0;
    jrEl('jrPayDone').onclick = jrPayDone;
    jrEl('jrPayClose').onclick = () => jrClose();
    jrEl('jrPayBack').onclick = () => jrPayBack(p.recordId);
    return;
  }
  jrEl('jrModalBody').innerHTML = `<div class="jr-payment-layout">${bill}${data.due === 0 ? `<div class="jr-payment-success" role="status">✓ ${dirty ? 'Будет оплачено полностью' : 'Оплачено полностью'}</div>` : ''}</aside><section class="jr-payment-content"><h3>Оплата визита</h3><p class="jr-hint">${data.methods.some(v => v.method === 'account' && v.requiresArrivalConfirmation === true) ? 'Для оплаты наличными или картой потребуется подтвердить фактический приход клиента. Статус визита станет «Пришёл».' : 'Нажмите способ оплаты — сумма добавится к оплате визита.'} Всё выбранное сохранится по кнопке «Готово».</p><label class="jr-partial-payment">Сумма частичной оплаты, ₽ <input id="jrPayPartial" type="number" min="0.01" step="0.01" placeholder="Вся доступная сумма"></label><div class="jr-payment-methods">${data.methods.map((v, i) => `<button type="button" class="jr-pay-method${i === preferredIndex ? ' is-preferred' : ''}" data-method-index="${i}" ${!v.available || !v.limit ? 'disabled' : ''}><strong>${v.method === 'loyalty_card' ? 'Бонусы' : v.cash ? 'Наличные' : 'Банковская карта'}</strong><span>${jrEscape(v.title)}</span><small>${!v.available || !v.limit ? jrEscape(v.unavailableReason || 'Недоступно для оплаты') : 'К оплате ' + jrRub(v.limit)}</small>${v.balance === null || v.balance === undefined ? '' : `<small>Баланс: ${Number(v.balance).toLocaleString('ru-RU')}</small>`}${v.method === 'account' && v.requiresArrivalConfirmation === true ? '<small>Требуется подтверждение прихода</small>' : ''}</button>`).join('') || '<p>Способы оплаты недоступны.</p>'}</div><div id="jrPayArrival" role="group" aria-label="Приход клиента и оплата" aria-live="polite" hidden></div><p class="jr-hint">Для смешанной оплаты сначала нажмите «Бонусы», затем оплатите остаток наличными или картой.</p><div class="jr-payment-other"><h4>Другие способы</h4><div class="jr-pay-shortcuts">${jrStub('Сертификаты и абонементы', 'wallet', 'jr-stub-inline')}${jrStub('QR-код / СБП', 'wallet', 'jr-stub-inline')}${jrStub('Оплата по ссылке', 'wallet', 'jr-stub-inline')}</div></div><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayDone">Готово</button>${p.recordId != null ? '<button type="button" class="btn btn-sec" id="jrPayBack">К записи</button>' : ''}<button type="button" class="btn btn-sec" id="jrPayClose">Закрыть</button></div></section></div>`;
  jrEl('jrModal').scrollTop = keepScroll ? scroll : 0;
  jrEl('jrPayDone').onclick = jrPayDone;
  jrEl('jrPayClose').onclick = () => jrClose();
  if (p.recordId != null) jrEl('jrPayBack').onclick = () => jrPayBack(p.recordId);
  jrEl('jrPayPartial').oninput = () => { const selected = journal.payment?.arrival; jrClearArrivalConfirmation(); if (selected) jrMessage('Сумма изменилась. Выберите способ оплаты заново.'); };
  const body = jrEl('jrModalBody');
  body.querySelectorAll('[data-method-index]').forEach(b => b.onclick = () => jrPayMethod(Number(b.dataset.methodIndex)));
  body.querySelectorAll('[data-remove-payment]').forEach(b => b.onclick = () => jrRemovePayment(Number(b.dataset.removePayment)));
  body.querySelectorAll('[data-restore-payment]').forEach(b => b.onclick = () => jrRestorePayment(Number(b.dataset.restorePayment)));
  body.querySelectorAll('[data-drop-payment]').forEach(b => b.onclick = () => jrDropPayment(Number(b.dataset.dropPayment)));
}
function jrClearArrivalConfirmation() {
  if (journal.payment) delete journal.payment.arrival;
  const host = jrEl('jrPayArrival');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}
function jrAddPayment(payment) {
  if (!journal.session || !journal.payment) return;
  (journal.session.payments ||= []).push(payment);
  jrMessage('');
  jrRenderPayment();
}
function jrConfirmArrivalPayment(selection) {
  if (journal.busy) return;
  const p = journal.payment, method = p?.data?.methods?.[selection?.index];
  if (!selection || p?.arrival !== selection || selection.modalRequest !== journal.modalRequest) return;
  if (method?.method !== 'account' || method.requiresArrivalConfirmation !== true || !method.available) { jrClearArrivalConfirmation(); return; }
  const entered = jrEl('jrPayPartial').value, amount = entered === '' ? method.limit : Number(entered);
  if (!Number.isFinite(amount) || amount <= 0 || amount > method.limit || amount !== selection.payment.amount) {
    jrClearArrivalConfirmation(); jrMessage('Сумма изменилась. Выберите способ оплаты заново.'); return;
  }
  jrClearArrivalConfirmation();
  jrAddPayment({ ...selection.payment, confirmArrival: true });
}
function jrPayMethod(index) {
  if (journal.busy) return;
  const p = journal.payment, method = p?.data?.methods?.[index];
  if (p?.readOnly || !method?.available || !method.limit) return;
  jrClearArrivalConfirmation();
  const entered = jrEl('jrPayPartial').value, amount = entered === '' ? method.limit : Number(entered);
  if (!Number.isFinite(amount) || amount <= 0 || amount > method.limit) { jrMessage('Укажите сумму больше нуля и не больше доступной для этого способа.'); return; }
  const payment = { method: method.method, methodId: method.id, amount };
  if (method.method === 'account' && method.requiresArrivalConfirmation === true) {
    const selection = { index, payment, modalRequest: journal.modalRequest }; p.arrival = selection;
    const host = jrEl('jrPayArrival');
    host.innerHTML = `<div class="jr-pay-review"><p>Оплата изменит статус визита на <strong>«Пришёл»</strong>. Подтверждайте только фактический приход клиента.</p><p><strong>${jrEscape(method.title)} · ${jrRub(amount)}</strong></p><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayArrivalConfirm">Оплатить и отметить приход</button><button type="button" class="btn btn-sec" id="jrPayArrivalCancel">Отмена</button></div></div>`;
    host.hidden = false;
    jrEl('jrPayArrivalConfirm').onclick = () => jrConfirmArrivalPayment(selection);
    jrEl('jrPayArrivalCancel').onclick = () => { jrClearArrivalConfirmation(); jrMessage(''); };
    jrMessage('Подтвердите приход клиента и выбранную оплату.');
    return;
  }
  jrAddPayment(payment);
}
function jrRemovePayment(index) {
  if (journal.busy || !journal.session || journal.payment?.readOnly) return;
  const t = journal.payment?.base?.paid?.[index];
  if (!t) return;
  const list = (journal.session.removePayments ||= []);
  if (!list.some(x => x.method === t.method && x.transactionId === t.id)) list.push({ transactionId: t.id, method: t.method, methodId: t.methodId, amount: t.amount });
  jrRenderPayment();
}
function jrRestorePayment(index) {
  if (journal.busy || !journal.session) return;
  const t = journal.payment?.base?.paid?.[index];
  if (!t) return;
  journal.session.removePayments = (journal.session.removePayments || []).filter(x => !(x.method === t.method && x.transactionId === t.id));
  jrRenderPayment();
}
function jrDropPayment(index) {
  if (journal.busy || !journal.session?.payments?.[index]) return;
  journal.session.payments.splice(index, 1);
  jrRenderPayment();
}
function jrPayDone() {
  if (journal.busy) return;
  if (jrSessionPending()) return jrSave(jrSessionBody());
  jrClose(true);
}
function jrPayBack(recordId) {
  if (journal.busy) return;
  if (jrSessionPending()) {
    if (typeof confirm === 'function' && confirm('Сохранить изменения?')) return jrSave(jrSessionBody());
  }
  return jrOpen(recordId);
}
// Local data renders at once; live YClients data replaces it silently while
// nothing has been chosen yet. A live failure keeps the local form.
// What to show once the live sale arrives. Live knows only the YClients sale, not
// our outbox queue: with queued/sending/failed payments the local form stays.
function jrMergeLivePayment(local, live) {
  if (!live) return local || null;
  if (!local) return live;
  if ((Array.isArray(local.payments) ? local.payments : []).some(p => p && p.status !== 'confirmed')) return local;
  const paid = Array.isArray(live.paid) ? live.paid : [];
  const liveItems = Array.isArray(live.items) ? live.items : [];
  const localItems = Array.isArray(local.items) ? local.items : [];
  const same = localItems.length === liveItems.length && localItems.every((i, n) => i.title === liveItems[n].title);
  const items = same ? localItems : liveItems;
  const sum = (list, f = () => true) => list.filter(f).reduce((n, x) => n + jrKop(x.amount), 0);
  const money = k => k / 100;
  const detailed = items.length > 0 && items.every(i => i.gross !== undefined && i.gross !== null);
  const total = items.reduce((n, i) => n + jrKop(i.total), 0);
  const gross = detailed ? items.reduce((n, i) => n + jrKop(i.gross), 0) : total;
  const summary = { gross: money(Math.max(gross, total)), discount: money(detailed ? items.reduce((n, i) => n + jrKop(i.discount), 0) : 0), total: money(total),
    paidConfirmed: money(sum(paid)), paidQueued: 0, bonusSpent: money(sum(paid, t => t.method === 'loyalty_card')), due: live.due };
  const payments = paid.map(t => ({ method: t.method, methodId: t.methodId, title: t.title, amount: t.amount, status: 'confirmed', kind: 'payment', outboxId: null }));
  return { ...live, items, payments, summary };
}
async function jrOpenPayment(recordId, preferred = 'all') {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.payment = null;
  const session = journal.session = jrNewSession({ recordId, payments: [], removePayments: [] });
  jrShowModal('Оплата визита', true);
  jrEl('jrModal').className = 'jr-dialog jr-dialog-wide jr-dialog-payment';
  const current = () => request === journal.modalRequest && journal.session === session;
  const localP = jrApi(`payments/${recordId}?local=1`);
  const liveP = Number(recordId) > 0 ? jrApi('payments/' + recordId).catch(() => null) : null;
  let shown = false, local = null;
  try {
    const data = await localP;
    if (!current()) return false;
    local = data;
    jrPaymentShow(data, { preferred, keepScroll: false }); shown = true;
  } catch (e) {
    if (current() && !liveP) {
      jrMessage(e.message);
      jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrPayReload">Повторить загрузку оплаты</button>';
      jrEl('jrPayReload').onclick = () => jrOpenPayment(recordId, preferred);
      return false;
    }
  }
  if (liveP) {
    const live = await liveP;
    if (!current()) return shown;
    const untouched = !session.payments.length && !session.removePayments.length && !journal.payment?.arrival;
    const view = jrMergeLivePayment(local, live);
    if (live && view === local && shown) { /* queue is only known locally: keep the local form */ }
    else if (live && (untouched || !shown)) { jrPaymentShow(view, { preferred, live: true }); jrMessage(''); shown = true; }
    else if (!shown) {
      jrMessage('Не удалось загрузить оплату визита.');
      jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrPayReload">Повторить загрузку оплаты</button>';
      jrEl('jrPayReload').onclick = () => jrOpenPayment(recordId, preferred);
    }
  }
  return shown;
}
