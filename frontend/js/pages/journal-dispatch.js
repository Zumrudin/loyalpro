// Журнал записи: «Отправить в YClients» и сверка операций. Общая глобальная область с journal.js.
async function jrReviewPending() {
  const request = ++journal.modalRequest;
  jrShowModal('Сверка операций');
  try {
    const rows = await jrApi('operations/pending');
    if (request !== journal.modalRequest) return;
    if (!rows.length) { jrEl('jrModalBody').textContent = 'Незавершённых операций нет.'; return; }
    jrEl('jrModalBody').innerHTML = '<p>Сначала проверьте в YClients, выполнилось ли действие. Только после сверки снимите блокировку. Снятие блокировки не повторяет действие и не удаляет записи.</p>' + rows.map(r => `<div class="jr-review-row"><p>${jrEscape(({create:'Создание',move:'Перенос',cancel:'Отмена',confirm:'Подтверждение',edit:'Изменение',delete:'Удаление'})[r.action])} · ${jrEscape(new Date(r.created_at).toLocaleString('ru', { timeZone: 'Europe/Moscow' }))}${r.record_id ? ' · запись №' + jrEscape(r.record_id) : ''}</p><label><input type="checkbox" data-check="${jrEscape(r.operation_id)}"> Я проверил результат в YClients</label><button class="btn btn-sec" data-review="${jrEscape(r.operation_id)}" disabled>Сверка завершена, снять блокировку</button></div>`).join('');
    jrEl('jrModalBody').querySelectorAll('[data-check]').forEach(el => { el.onchange = () => {
      jrEl('jrModalBody').querySelector(`[data-review="${el.dataset.check}"]`).disabled = !el.checked;
    }; });
    jrEl('jrModalBody').querySelectorAll('[data-review]').forEach(el => { el.onclick = async () => {
      el.disabled = true;
      try { await jrApi('operations/review', { operationId: el.dataset.review, checkedInYclients: true }); await jrReviewPending(); }
      catch (e) { jrMessage(e.message); el.disabled = false; }
    }; });
  } catch (e) { if (request === journal.modalRequest) jrMessage(e.message); }
}

// «Отправить в YClients»: journal changes wait locally; this sends the records
// whose visit falls into the chosen period (all their waiting changes).
function jrUpdateDispatchButton(unsent) {
  const button = jrEl('jrDispatch');
  if (!button) return;
  journal.unsent = unsent || null;
  const n = Number(unsent?.records) || 0;
  button.textContent = n ? `Отправить в YClients (${n})` : 'Отправить в YClients';
  button.classList.toggle('btn-pri', n > 0);
  button.classList.toggle('btn-sec', !n);
  button.title = n ? `Не отправлено в YClients: записей — ${n}` : 'Все изменения журнала отправлены в YClients';
}
const jrDispatchWord = n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'запись' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'записи' : 'записей'; };
async function jrDispatchOpen() {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  jrShowModal('Отправить в YClients');
  let summary = journal.unsent;
  try { summary = await jrApi('dispatch/summary'); } catch (_) { /* keep the day's figure */ }
  if (request !== journal.modalRequest) return;
  jrUpdateDispatchButton(summary);
  const today = jrToday();
  const from = summary?.from || jrEl('jrDate').value || today, to = summary?.to || from;
  jrEl('jrModalBody').innerHTML = `<form id="jrDispatchForm" class="jr-dispatch-form">
    <p>Изменения журнала сохраняются только у нас. Выберите период визитов: в YClients уйдут все неотправленные изменения записей этих дней — новые записи, статусы, услуги, время, специалист и оплаты.</p>
    <p class="jr-hint">${summary?.records ? `Всего не отправлено: ${summary.records} ${jrDispatchWord(summary.records)}${summary.from ? `, визиты с ${jrEscape(summary.from)} по ${jrEscape(summary.to)}` : ''}.` : 'Неотправленных изменений нет.'}</p>
    <div class="jr-dispatch-period"><label>С<input type="date" id="jrDispatchFrom" required value="${jrEscape(from)}"></label><label>По<input type="date" id="jrDispatchTo" required value="${jrEscape(to)}"></label></div>
    <p id="jrDispatchPreview" class="jr-dispatch-preview" role="status" aria-live="polite"></p>
    <div class="jr-actions"><button type="submit" class="btn btn-pri" id="jrDispatchGo" disabled>Отправить</button><button type="button" class="btn btn-sec" onclick="jrClose(true)">Отмена</button></div>
  </form>`;
  let previewRequest = 0;
  const preview = async () => {
    const mine = ++previewRequest, f = jrEl('jrDispatchFrom').value, t = jrEl('jrDispatchTo').value;
    jrEl('jrDispatchGo').disabled = true;
    if (!f || !t) { jrEl('jrDispatchPreview').textContent = 'Укажите обе даты.'; return; }
    jrEl('jrDispatchPreview').textContent = 'Считаем…';
    try {
      const r = await jrApi('dispatch/preview?' + new URLSearchParams({ from: f, to: t }));
      if (mine !== previewRequest || request !== journal.modalRequest) return;
      jrEl('jrDispatchPreview').textContent = r.records ? `Будет отправлено: ${r.records} ${jrDispatchWord(r.records)} (изменений: ${r.packages}).` : 'За этот период отправлять нечего.';
      jrEl('jrDispatchGo').disabled = !r.records;
    } catch (e) { if (mine === previewRequest) jrEl('jrDispatchPreview').textContent = e.message; }
  };
  jrEl('jrDispatchFrom').onchange = preview; jrEl('jrDispatchTo').onchange = preview;
  jrEl('jrDispatchForm').onsubmit = async e => {
    e.preventDefault();
    const f = jrEl('jrDispatchFrom').value, t = jrEl('jrDispatchTo').value;
    let out = null;
    await jrWithBusy('Отправляем…', async () => {
      try { out = await jrApi('dispatch', { from: f, to: t }); } catch (err) { jrMessage(err.message); }
    });
    if (!out || request !== journal.modalRequest) return;
    if (!out.releaseId) { jrEl('jrDispatchPreview').textContent = 'За этот период отправлять нечего.'; return; }
    loadJournal({ silent: true });
    jrDispatchProgress(out, request);
  };
  preview();
}
function jrDispatchProgress(started, request) {
  const body = jrEl('jrModalBody');
  const render = p => {
    const done = p.done + p.cancelled, left = p.queued + p.running;
    body.innerHTML = `<div class="jr-dispatch-progress" role="status" aria-live="polite">
      <p><strong>${p.finished ? (p.failed ? 'Отправка завершена с ошибками' : 'Отправлено в YClients') : 'Отправляем в YClients…'}</strong></p>
      <p>Записей: ${started.records} · изменений: ${p.total}. Готово: ${done}${left ? ` · в очереди: ${left}` : ''}${p.failed ? ` · ошибок: ${p.failed}` : ''}.</p>
      ${p.finished ? '' : '<p class="jr-hint">Окно можно закрыть: отправка продолжится. Записи журнала обновятся сами.</p>'}
      ${p.failures?.length ? `<ul class="jr-dispatch-failures">${p.failures.map(f => `<li><button type="button" class="btn btn-sec" data-open="${jrEscape(f.recordId)}">${jrEscape([f.date, f.clientName].filter(Boolean).join(' · ') || 'Запись')}</button> ${jrEscape(f.errorText || 'причина неизвестна')}</li>`).join('')}</ul><p class="jr-hint">Откройте запись: там можно повторить отправку или отменить неотправленные изменения.</p>` : ''}
      <div class="jr-actions"><button type="button" class="btn btn-sec" onclick="jrClose(true)">Закрыть</button></div></div>`;
    body.querySelectorAll('[data-open]').forEach(el => { el.onclick = () => jrOpen(Number(el.dataset.open)); });
  };
  const tick = async () => {
    if (request !== journal.modalRequest || !jrEl('jrModal').open) return;
    try {
      const p = await jrApi('dispatch/' + encodeURIComponent(started.releaseId));
      if (request !== journal.modalRequest) return;
      render(p);
      if (p.finished) { loadJournal({ silent: true }); return; }
    } catch (e) { jrMessage(e.message); }
    journal.cardTimer = setTimeout(tick, 2000);
  };
  render({ total: started.packages, queued: started.packages, running: 0, done: 0, failed: 0, cancelled: 0, finished: false });
  tick();
}
