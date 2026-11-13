// ── FINANCE PAGE: «Финансы» — финансовые операции салона ───────────────────
// Данные: GET /api/finance/operations (таблица finance_operations: оплаты визитов, отмены,
// бонусы, кассовые операции YClients; owner/admin). Страница ТОЛЬКО читает.
// Зависимости: api(), notify(), TOKEN, navTo(). Разметка рисуется в #page-finance при первом заходе.
// Всё из данных клиентов/названий экранируется finEsc() и в тексте, и в атрибутах.

const FIN_KIND = {
  visit_payment: 'Оплата визита', payment_reversal: 'Отмена оплаты', bonus_redemption: 'Списание бонусов',
  bonus_accrual: 'Начисление бонусов', bonus_adjustment: 'Корректировка бонусов', bonus_opening: 'Входящий остаток бонусов',
  goods_sale: 'Продажа товаров', certificate_sale: 'Продажа сертификата', abonement_sale: 'Продажа абонемента',
  deposit: 'Депозит', other_income: 'Прочий приход',
};
const FIN_METHOD = { cash: 'Наличные', card: 'Карта', bonus: 'Бонусы', other: 'Другое' };
const FIN_STATUS = {
  queued: 'В очереди (не отправлено в YClients)', sending: 'Передаётся', confirmed: 'Проведено',
  cancelled: 'Отменено', failed: 'Ошибка',
};
const FIN_STATUS_SHORT = { queued: 'В очереди', sending: 'Передаётся', confirmed: 'Проведено', cancelled: 'Отменено', failed: 'Ошибка' };
const FIN_ORIGIN = { journal: 'Журнал', yclients: 'YClients', loyalpro: 'LoyalPro', staff: 'Вручную', backfill: 'Перенос истории', opening: 'Входящий остаток' };
const FIN_PAGE_SIZE = 50;

const finState = { built: false, preset: 'month', from: '', to: '', kind: '', method: '', account: '', status: '', q: '',
  clientId: '', clientName: '', offset: 0, total: 0, req: 0, timer: null,
  disc: null, discOpen: false, discReq: 0 };

function finEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const finYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function finPresetRange(p) {
  const now = new Date();
  const to = finYmd(now);
  if (p === 'today') return { from: to, to };
  if (p === 'week') return { from: finYmd(new Date(now.getTime() - 6 * 864e5)), to };
  return { from: finYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to };   // month
}
const finRu = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'; };
const finNum = n => Math.abs(Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
function finAmount(r) {
  const v = Number(r.amount) || 0;
  const unit = r.method === 'bonus' ? ' Б' : ' ₽';
  const cls = v < 0 ? 'fin-neg' : 'fin-pos';
  const sign = v < 0 ? '−' : '+';
  return `<span class="${cls}${r.status === 'cancelled' || r.status === 'failed' ? ' fin-dim' : ''}">${sign}${finNum(v)}${unit}</span>`;
}
function finTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

function finBuild() {
  const el = document.getElementById('page-finance');
  if (!el) return false;
  const opt = (map, all) => `<option value="">${all}</option>` + Object.entries(map).map(([k, v]) => `<option value="${finEsc(k)}">${finEsc(v)}</option>`).join('');
  el.innerHTML = `
    <div class="bc-head">
      <div>
        <div class="bc-head-title">Операции за период</div>
        <div class="bc-head-sub">Оплаты визитов, бонусы и кассовые операции · <span id="finRangeLbl"></span></div>
      </div>
      <button class="btn btn-sec btn-sm" type="button" id="finExport">Скачать CSV</button>
    </div>
    <div class="fin-filters">
      <div class="pb-btns" id="finPresets">
        <button type="button" class="pb-btn" data-fp="today">Сегодня</button>
        <button type="button" class="pb-btn" data-fp="week">Неделя</button>
        <button type="button" class="pb-btn active" data-fp="month">Месяц</button>
        <button type="button" class="pb-btn" data-fp="custom">Свой</button>
      </div>
      <div class="fin-range" id="finRange" style="display:none">
        <input type="date" id="finFrom" class="pb-date" aria-label="С"><span class="pb-dash">—</span>
        <input type="date" id="finTo" class="pb-date" aria-label="По">
        <button type="button" class="btn btn-sm btn-pri" id="finApply">OK</button>
      </div>
      <select id="finKind" aria-label="Тип">${opt(FIN_KIND, 'Все типы')}</select>
      <select id="finMethod" aria-label="Способ">${opt(FIN_METHOD, 'Все способы')}</select>
      <select id="finAccount" aria-label="Касса"><option value="">Все кассы</option></select>
      <select id="finStatus" aria-label="Статус">${opt(FIN_STATUS, 'Все статусы')}</select>
      <input type="text" id="finQ" placeholder="Клиент, телефон, № визита" maxlength="100" aria-label="Поиск клиента">
    </div>
    <div class="fin-chip-row" id="finChips"></div>
    <div class="fin-tiles" id="finTiles"></div>
    <div class="fin-disc" id="finDisc" style="display:none"></div>
    <div class="card" style="padding:0"><div class="tw"><table class="fin-table">
      <thead><tr><th>Дата</th><th>Тип</th><th>Способ</th><th>Касса</th><th>Клиент</th><th>Визит</th><th style="text-align:right">Сумма</th><th>Статус</th><th>Источник</th><th>Кто</th></tr></thead>
      <tbody id="finBody"><tr><td colspan="10" class="empty">Загрузка…</td></tr></tbody>
    </table></div></div>
    <div class="fin-pager" id="finPager"></div>`;

  el.querySelector('#finPresets').addEventListener('click', e => {
    const b = e.target.closest('[data-fp]');
    if (b) finSetPreset(b.dataset.fp);
  });
  el.querySelector('#finApply').addEventListener('click', finApplyRange);
  for (const id of ['finKind', 'finMethod', 'finAccount', 'finStatus']) {
    el.querySelector('#' + id).addEventListener('change', () => finReadFilters(true));
  }
  const q = el.querySelector('#finQ');
  q.addEventListener('input', () => { clearTimeout(finState.timer); finState.timer = setTimeout(() => finReadFilters(true), 400); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(finState.timer); finReadFilters(true); } });
  el.querySelector('#finExport').addEventListener('click', finExport);
  el.querySelector('#finBody').addEventListener('click', finBodyClick);
  el.querySelector('#finChips').addEventListener('click', e => {
    if (e.target.closest('[data-fin-clear-client]')) { finState.clientId = ''; finState.clientName = ''; finState.offset = 0; finFetch(); }
  });
  el.querySelector('#finDisc').addEventListener('click', e => {
    if (e.target.closest('[data-fin-disc-toggle]')) { finState.discOpen = !finState.discOpen; finRenderDisc(); }
  });
  el.querySelector('#finPager').addEventListener('click', e => {
    const b = e.target.closest('[data-fin-off]');
    if (b && !b.disabled) { finState.offset = Math.max(0, Number(b.dataset.finOff)); finFetch(); }
  });
  return true;
}

function finSetPreset(p) {
  finState.preset = p;
  document.querySelectorAll('#finPresets .pb-btn').forEach(b => b.classList.toggle('active', b.dataset.fp === p));
  const custom = p === 'custom';
  document.getElementById('finRange').style.display = custom ? '' : 'none';
  if (custom) {
    const r = finPresetRange('month');
    const f = document.getElementById('finFrom'), t = document.getElementById('finTo');
    if (!f.value) f.value = finState.from || r.from;
    if (!t.value) t.value = finState.to || r.to;
    return;
  }
  const r = finPresetRange(p);
  finState.from = r.from; finState.to = r.to; finState.offset = 0;
  finFetch();
}
function finApplyRange() {
  const f = document.getElementById('finFrom').value, t = document.getElementById('finTo').value;
  if (!f || !t) { notify('Укажите обе даты периода', 'err'); return; }
  if (f > t) { notify('Начало периода позже конца', 'err'); return; }
  if ((Date.parse(t) - Date.parse(f)) / 864e5 + 1 > 366) { notify('Период не больше 366 дней', 'err'); return; }
  finState.from = f; finState.to = t; finState.offset = 0;
  finFetch();
}
function finReadFilters(reset) {
  finState.kind = document.getElementById('finKind').value;
  finState.method = document.getElementById('finMethod').value;
  finState.account = document.getElementById('finAccount').value;
  finState.status = document.getElementById('finStatus').value;
  finState.q = document.getElementById('finQ').value.trim();
  if (reset) finState.offset = 0;
  finFetch();
}
function finQuery(extra) {
  const p = new URLSearchParams({ from: finState.from, to: finState.to });
  for (const k of ['kind', 'method', 'account', 'status', 'q', 'clientId']) if (finState[k]) p.set(k, finState[k]);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p;
}

async function loadFinance() {
  if (!finState.built) finState.built = finBuild();
  if (!finState.built) return;
  if (!finState.from) { const r = finPresetRange(finState.preset === 'custom' ? 'month' : finState.preset); finState.from = r.from; finState.to = r.to; }
  finLoadAccounts();
  finLoadDisc();
  finFetch();
}

async function finLoadAccounts() {
  try {
    const d = await api('GET', '/api/finance/accounts');
    const sel = document.getElementById('finAccount');
    if (!sel || !d || !Array.isArray(d.accounts)) return;
    const cur = finState.account;
    sel.innerHTML = '<option value="">Все кассы</option>' + d.accounts.map(a => {
      const v = a.id != null ? String(a.id) : String(a.title);
      return `<option value="${finEsc(v)}"${v === cur ? ' selected' : ''}>${finEsc(a.title)}</option>`;
    }).join('');
  } catch (e) { /* фильтр кассы необязателен */ }
}

async function finFetch() {
  const my = ++finState.req;
  const body = document.getElementById('finBody');
  if (!body) return;
  document.getElementById('finRangeLbl').textContent = `${finRu(finState.from)} — ${finRu(finState.to)}`;
  try {
    const d = await api('GET', '/api/finance/operations?' + finQuery({ limit: FIN_PAGE_SIZE, offset: finState.offset }));
    if (my !== finState.req) return;   // ответ устаревшего запроса
    finState.total = d.total || 0;
    finRenderTiles(d.summary || {});
    finRenderRows(d.rows || []);
    finRenderPager();
    finRenderChips();
  } catch (e) {
    if (my !== finState.req) return;
    body.innerHTML = `<tr><td colspan="10" class="empty">${finEsc(e.message || 'Не удалось загрузить')}</td></tr>`;
    notify(e.message || 'Не удалось загрузить финансовые операции', 'err');
  }
}

function finRenderTiles(s) {
  const t = (label, val, unit, cls, hint) => `<div class="sc fin-tile" title="${finEsc(hint)}"><div class="sl">${finEsc(label)}</div><div class="sv ${cls}">${finNum(val)}<span class="fin-unit"> ${unit}</span></div></div>`;
  document.getElementById('finTiles').innerHTML =
    t('Приход', s.income, '₽', 'fin-pos', 'Деньги, проведённые в YClients') +
    t('Расход / возврат', s.expense, '₽', 'fin-neg', 'Возвраты и отмены оплат деньгами') +
    t('Бонусов списано', s.bonusRedeemed, 'Б', '', 'Списание бонусов за вычетом возвратов, включая ещё не отправленное') +
    t('Бонусов начислено', s.bonusAccrued, 'Б', '', 'Кэшбэк, подарки и корректировки, включая ещё не отправленное') +
    `<div class="sc fin-tile" title="Операции журнала, которые ещё не проведены в YClients"><div class="sl">Не отправлено в YClients</div><div class="sv${(s.queued || 0) > 0 ? ' fin-warn' : ''}">${Number(s.queued) || 0}<span class="fin-unit"> оп.</span></div></div>`;
}

function finRenderRows(rows) {
  const body = document.getElementById('finBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="10" class="empty">Операций за период нет</td></tr>'; return; }
  body.innerHTML = rows.map(r => {
    const visit = r.yclientsRecordId
      ? `<a href="#journal" class="fin-visit" data-rec="${finEsc(r.yclientsRecordId)}" title="Открыть визит в журнале">#${finEsc(r.yclientsRecordId)}</a>`
      : (r.outboxId ? `<a href="#journal" class="fin-visit" data-rec="${finEsc(-r.outboxId)}" title="Новая запись в очереди журнала">очередь №${finEsc(r.outboxId)}</a>` : '—');
    const client = r.clientId
      ? `<a href="javascript:void(0)" class="fin-client" data-cid="${finEsc(r.clientId)}" data-cname="${finEsc(r.clientName || '')}"><strong>${finEsc(r.clientName || 'Без имени')}</strong></a><br><span class="fin-sub">${finEsc(r.clientPhone || '')}</span>`
      : '<span class="fin-sub">—</span>';
    const note = r.title ? `<br><span class="fin-sub">${finEsc(r.title)}</span>` : '';
    return `<tr class="fin-row fin-s-${finEsc(r.status)}">
      <td class="fin-card-title" style="white-space:nowrap">${finEsc(finRu(r.date))}<span class="fin-sub"> · ${finEsc(finTime(r.occurredAt))}</span></td>
      <td data-label="Тип">${finEsc(FIN_KIND[r.kind] || r.kind)}${note}</td>
      <td data-label="Способ">${finEsc(FIN_METHOD[r.method] || r.method || '—')}</td>
      <td data-label="Касса">${finEsc(r.accountTitle || '—')}</td>
      <td data-label="Клиент">${client}</td>
      <td data-label="Визит">${visit}</td>
      <td data-label="Сумма" class="fin-amt">${finAmount(r)}</td>
      <td data-label="Статус"><span class="fin-badge fin-st-${finEsc(r.status)}" title="${finEsc(FIN_STATUS[r.status] || r.status)}">${finEsc(FIN_STATUS_SHORT[r.status] || r.status)}</span></td>
      <td data-label="Источник">${finEsc(FIN_ORIGIN[r.origin] || r.origin)}</td>
      <td data-label="Кто">${finEsc(r.userName || '—')}</td>
    </tr>`;
  }).join('');
}

function finRenderPager() {
  const el = document.getElementById('finPager');
  const total = finState.total, off = finState.offset;
  if (!total) { el.innerHTML = ''; return; }
  const to = Math.min(total, off + FIN_PAGE_SIZE);
  el.innerHTML = `<span>Операции ${off + 1}–${to} из ${total}</span>
    <button type="button" class="btn btn-sec" data-fin-off="${off - FIN_PAGE_SIZE}" ${off <= 0 ? 'disabled' : ''}>← Назад</button>
    <button type="button" class="btn btn-sec" data-fin-off="${off + FIN_PAGE_SIZE}" ${to >= total ? 'disabled' : ''}>Вперёд →</button>`;
}
function finRenderChips() {
  document.getElementById('finChips').innerHTML = finState.clientId
    ? `<span class="fin-chip">Клиент: ${finEsc(finState.clientName || '#' + finState.clientId)} <button type="button" data-fin-clear-client aria-label="Сбросить клиента">×</button></span>` : '';
}

function finBodyClick(e) {
  const v = e.target.closest('.fin-visit');
  if (v) { e.preventDefault(); finOpenVisit(Number(v.dataset.rec)); return; }
  const c = e.target.closest('.fin-client');
  if (c) { finState.clientId = c.dataset.cid; finState.clientName = c.dataset.cname || ''; finState.offset = 0; finFetch(); }
}
// Журнал сам не читает хвост адреса, поэтому открываем раздел, а карточку визита — его же функцией jrOpen,
// когда журнал загрузился. Нет jrOpen — остаёмся в разделе «Журнал записи».
function finOpenVisit(id) {
  if (!Number.isFinite(id) || !id) return;
  navTo('journal');
  setTimeout(() => { try { if (typeof jrOpen === 'function') jrOpen(id); } catch (e) { /* журнал откроется без карточки */ } }, 700);
}

async function finExport() {
  try {
    const r = await fetch('/api/finance/operations/export.csv?' + finQuery(), { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch (_) { /* не JSON */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `finance-${finState.from}_${finState.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { notify(e.message || 'Не удалось скачать CSV', 'err'); }
}

// ── Расхождения бонусов с картой YClients (только при BONUS_LEDGER_PRIMARY) ──
// Грузится отдельно и независимо от основного списка: сбой прячет плашку, остальное живёт.
async function finLoadDisc() {
  const my = ++finState.discReq;
  try {
    const d = await api('GET', '/api/finance/bonus-discrepancies?limit=200');
    if (my !== finState.discReq) return;
    finState.disc = d && d.enabled && Array.isArray(d.rows) ? d.rows : null;
  } catch (e) {
    if (my !== finState.discReq) return;
    finState.disc = null;
  }
  finRenderDisc();
}
function finRenderDisc() {
  const el = document.getElementById('finDisc');
  if (!el) return;
  const rows = finState.disc;
  if (!rows) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const n = rows.length;
  const btn = `<button type="button" class="btn btn-sec btn-sm fin-disc-btn${n ? ' fin-disc-has' : ''}" data-fin-disc-toggle aria-expanded="${finState.discOpen ? 'true' : 'false'}">Расхождения с YClients: ${n}</button>`;
  if (!finState.discOpen) { el.innerHTML = btn; return; }
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '') + finNum(v);
  const body = n ? rows.map(r => `<tr>
      <td class="fin-card-title"><strong>${finEsc(r.name || 'Без имени')}</strong><br><span class="fin-sub">${finEsc(r.phone || '')}</span></td>
      <td data-label="Наш баланс" class="fin-amt">${finEsc(finNum(r.ours))} Б</td>
      <td data-label="Не отправлено" class="fin-amt">${finEsc(sgn(Number(r.unsent) || 0))} Б</td>
      <td data-label="Карта YClients" class="fin-amt">${r.card == null ? '—' : finEsc(finNum(r.card)) + ' Б'}</td>
      <td data-label="Разница" class="fin-amt"><span class="${(Number(r.diff) || 0) < 0 ? 'fin-neg' : 'fin-warn'}">${finEsc(sgn(Number(r.diff) || 0))} Б</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Расхождений нет</td></tr>';
  el.innerHTML = btn + `<div class="card fin-disc-panel" style="padding:0"><div class="tw"><table class="fin-table">
    <thead><tr><th>Клиент</th><th style="text-align:right">Наш баланс</th><th style="text-align:right">Не отправлено</th><th style="text-align:right">Карта YClients</th><th style="text-align:right">Разница</th></tr></thead>
    <tbody>${body}</tbody></table></div></div>
    <div class="fin-sub" style="margin-top:6px">Разница = подтверждённые бонусные операции − показание карты YClients. Автоматически ничего не правится.</div>`;
}
