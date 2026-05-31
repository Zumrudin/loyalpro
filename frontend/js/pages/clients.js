// ── CLIENTS PAGE ───────────────────────────────────────────────
// Зависимости: api(), notify(), esc(), openModal(), closeModal()
// avc(), avi(), LVL_B, LVL_L, fireConfetti()

let cPage_ = 1, cSortCol = 'last_visit_at', cSortDir = 'desc';
let bonusTarget = null;

// ── Синхронизация карты (старая версия, вызывается из других мест) ──
async function syncClientCard(clientId) {
  try {
    const r = await api('POST', `/api/clients/${clientId}/sync-card`);
    if (r.ok) notify(`Карта синхронизирована. Баланс: ${r.balance} бонусов, транзакций: ${r.transactionsImported}`, 'ok');
    else notify(r.message || 'Карта не найдена', 'err');
  } catch(e) { notify(e.message, 'err'); }
}

// ── Таблица клиентов ───────────────────────────────────────────
function cPage(d) { cPage_ = Math.max(1, cPage_ + d); loadClients(); }

function cFilter() { cPage_ = 1; loadClients(); }

function cSort(col) {
  if (cSortCol === col) {
    cSortDir = cSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    cSortCol = col;
    cSortDir = col === 'name' || col === 'phone' ? 'asc' : 'desc';
  }
  cUpdateSortUI();
  cPage_ = 1;
  loadClients();
}

function cUpdateSortUI() {
  document.querySelectorAll('#page-clients .th-sort').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.col === cSortCol) th.classList.add(cSortDir);
  });
}

function cResetFilters() {
  ['cf-name','cf-phone','cf-bonus-min','cf-bonus-max','cf-spent-min','cf-spent-max',
   'cf-visits-min','cf-visits-max','cf-visit-from','cf-visit-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const lvl = document.getElementById('cf-level');
  if (lvl) lvl.value = '';
  const stat = document.getElementById('cstat');
  if (stat) stat.value = '';
  cSortCol = 'last_visit_at'; cSortDir = 'desc';
  cUpdateSortUI();
  cPage_ = 1;
  loadClients();
}

function cGetFilters() {
  const g = id => document.getElementById(id)?.value || '';
  return {
    name:            g('cf-name'),
    phone:           g('cf-phone'),
    level:           g('cf-level'),
    status:          g('cstat'),
    bonus_min:       g('cf-bonus-min'),
    bonus_max:       g('cf-bonus-max'),
    spent_min:       g('cf-spent-min'),
    spent_max:       g('cf-spent-max'),
    visits_min:      g('cf-visits-min'),
    visits_max:      g('cf-visits-max'),
    last_visit_from: g('cf-visit-from'),
    last_visit_to:   g('cf-visit-to'),
  };
}

async function loadClients() {
  try {
    const f = cGetFilters();
    const params = { page: cPage_, limit: 50, sort: cSortCol, sort_dir: cSortDir };
    Object.entries(f).forEach(([k, v]) => { if (v) params[k] = v; });
    const q = new URLSearchParams(params);
    const d = await api('GET', '/api/clients?' + q);
    const tb = document.getElementById('cBody');
    if (!d.clients?.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">Клиенты не найдены</td></tr>'; return; }
    tb.innerHTML = d.clients.map(c => `
      <tr onclick="openCD(${c.id})">
        <td class="c-card-title"><div style="display:flex;align-items:center;gap:9px"><div class="av" style="background:${avc(c.name)};color:#fff;font-size:10px">${avi(c.name)}</div><div style="font-weight:600">${esc(c.name)}</div></div></td>
        <td data-label="Телефон" style="color:var(--t2)">${esc(c.phone || '—')}</td>
        <td data-label="Уровень"><span class="badge ${LVL_B[c.loyalty_level] || 'bgr'}">${LVL_L[c.loyalty_level] || '—'}</span></td>
        <td data-label="Бонусы" style="font-weight:700;color:var(--a)">${(c.bonus_balance || 0).toLocaleString('ru')}</td>
        <td data-label="Потрачено">${parseFloat(c.total_spent || 0).toLocaleString('ru')} ₽</td>
        <td data-label="Визитов">${c.visits_count || 0}</td>
        <td data-label="Последний визит" style="color:var(--t3)">${c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString('ru', {day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
        <td class="c-card-arrow"><button class="btn btn-sec btn-sm" onclick="event.stopPropagation();openCD(${c.id})">→</button></td>
      </tr>`).join('');
    const shown = Math.min(cPage_ * 50, d.total);
    const from  = d.total === 0 ? 0 : (cPage_ - 1) * 50 + 1;
    document.getElementById('cPager').textContent = `Показано ${from}–${shown} из ${d.total}`;
    cUpdateSortUI();
  } catch(e) { notify(e.message, 'err'); }
}

// ── Карточка клиента ───────────────────────────────────────────
async function openCD(id) {
  try {
    const [{client:c, history, records}, cardTxnsResp] = await Promise.all([
      api('GET', '/api/clients/' + id),
      api('GET', '/api/clients/' + id + '/card-transactions').catch(() => ({local:[], yclients:[]})),
    ]);
    document.getElementById('cmTitle').textContent = c.name;

    const lctRows = (cardTxnsResp.local || []).map(t => ({
      created_at:    t.txn_date || t.created_at,
      amount:        parseFloat(t.amount || 0),
      description:   t.title || (parseFloat(t.amount || 0) >= 0 ? 'Начисление' : 'Списание'),
      balance_after: parseFloat(t.balance_after || 0),
      _src: 'card'
    }));
    const bonusRows = (history || []).map(t => ({
      created_at:    t.created_at,
      amount:        parseFloat(t.amount || 0),
      description:   t.description || t.type,
      balance_after: parseFloat(t.balance_after || 0),
      _src: 'bonus'
    }));

    const allTxns = lctRows.length > 0
      ? [...lctRows, ...bonusRows.filter(b => !lctRows.some(l =>
          Math.abs(new Date(l.created_at) - new Date(b.created_at)) < 86400000 &&
          Math.abs(l.amount - b.amount) < 0.01
        ))]
      : bonusRows;

    allTxns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = allTxns.slice(0, 50).map(t => `
      <tr>
        <td style="color:var(--t3)">${t.created_at ? new Date(t.created_at).toLocaleDateString('ru', {day:'numeric',month:'short',year:'2-digit'}) : '—'}</td>
        <td style="color:${t.amount > 0 ? 'var(--a)' : 'var(--danger)'};font-weight:600">${t.amount > 0 ? '+' : ''}${parseFloat(t.amount).toLocaleString('ru')}</td>
        <td style="color:var(--t2);font-size:12px">${t.description || '—'}</td>
        <td style="font-weight:600">${t.balance_after ? parseFloat(t.balance_after).toLocaleString('ru') : '—'}</td>
      </tr>`).join('');

    const cardBlock = c.yclients_card_id
      ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--as);border-radius:8px;margin-bottom:14px">
           <div>
             <div style="font-size:12px;color:var(--t3)">Карта YClients</div>
             <div style="font-size:13px;font-weight:600">№${c.yclients_card_number || c.yclients_card_id} · Баланс: <span style="color:var(--a)">${parseFloat(c.yclients_card_balance || 0).toLocaleString('ru')} бонусов</span></div>
           </div>
           <button class="btn btn-sec btn-sm" id="syncCardBtn_${c.id}" onclick="doSyncCard(${c.id})">
             🔄 Синхронизировать карту
           </button>
         </div>`
      : `<div style="padding:10px 12px;background:var(--bg);border-radius:8px;margin-bottom:14px;font-size:12.5px;color:var(--t3)">
           Карта лояльности YClients не привязана.
           <button class="btn btn-sec btn-sm" style="margin-left:8px" onclick="doSyncCard(${c.id})">Найти и привязать</button>
         </div>`;

    document.getElementById('cmBody').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <div class="av" style="width:48px;height:48px;font-size:15px;background:${avc(c.name)};color:#fff">${avi(c.name)}</div>
        <div>
          <div style="font-size:17px;font-weight:700">${esc(c.name)}</div>
          <div style="color:var(--t2);font-size:13px">${esc(c.phone || '—')}${c.email ? ' · ' + esc(c.email) : ''}</div>
        </div>
        <span class="badge ${LVL_B[c.loyalty_level] || 'bgr'}" style="margin-left:auto">${LVL_L[c.loyalty_level] || '—'}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
        <div class="sc"><div class="sl">Бонусы (наша БД)</div><div class="sv" style="font-size:20px;color:var(--a)">${(c.bonus_balance || 0).toLocaleString('ru')}</div></div>
        <div class="sc"><div class="sl">Потрачено</div><div class="sv" style="font-size:20px">${parseFloat(c.total_spent || 0).toLocaleString('ru')} ₽</div></div>
        <div class="sc"><div class="sl">Визитов</div><div class="sv" style="font-size:20px">${c.visits_count || 0}</div></div>
      </div>
      ${cardBlock}
      <div class="div"></div>
      <div class="fg"><label class="fl">Ручная корректировка</label>
        <div style="display:flex;gap:7px">
          <input type="number" id="qAmt" placeholder="Бонусы" style="flex:1">
          <input type="text" id="qCmt" placeholder="Причина" style="flex:1">
          <button class="btn btn-pri btn-sm" onclick="quickB(${c.id},1)">+ Начислить</button>
          <button class="btn btn-sec btn-sm btn-dng" onclick="quickB(${c.id},-1)">− Списать</button>
        </div>
      </div>
      <div class="div"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:13px;font-weight:700">История операций</div>
        <span style="font-size:11px;color:var(--t3)">${allTxns.length} операций</span>
      </div>
      ${rows ? `<div style="max-height:280px;overflow-y:auto"><table><thead><tr><th>Дата</th><th>Сумма</th><th>Описание</th><th>Баланс</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Нет операций</div>'}
      <div id="cardTxnsBlock_${c.id}"></div>`;

    openModal('clientModal');
  } catch(e) { notify(e.message, 'err'); }
}

async function doSyncCard(clientId) {
  const btn = document.getElementById(`syncCardBtn_${clientId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Загрузка...'; }
  try {
    const r = await api('POST', `/api/clients/${clientId}/sync-card`);
    if (r.ok) {
      notify(`✓ Карта синхронизирована. Баланс: ${parseFloat(r.balance || 0).toLocaleString('ru')} бонусов. Транзакций загружено: ${r.transactionsImported}`, 'ok');
      setTimeout(() => openCD(clientId), 500);
    } else {
      notify(r.message || 'Карта не найдена у клиента', 'err');
    }
  } catch(e) { notify('Ошибка синхронизации: ' + e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = '🔄 Синхронизировать карту'; } }
}

async function loadCardTxns(clientId) {
  const el = document.getElementById(`cardTxnsBlock_${clientId}`);
  if (!el) return;
  el.innerHTML = '<div style="margin-top:14px;font-size:13px;color:var(--t3)"><span class="spinner"></span> Загрузка полной истории...</div>';
  try {
    const r = await api('GET', `/api/clients/${clientId}/card-transactions`);
    const txns = r.transactions || [];
    if (!txns.length) { el.innerHTML = '<div class="empty" style="margin-top:10px">История операций пуста</div>'; return; }

    const TYPE_LBL = {accrual:'Начисление',redemption:'Списание',birthday:'День рождения',referral:'Реферал',manual:'Вручную',cancellation:'Отмена',expiry:'Сгорание'};
    const rows = txns.map(t => {
      const amt  = parseFloat(t.amount || 0);
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('ru', {day:'numeric',month:'short',year:'2-digit'}) : '—';
      const desc = t.description || TYPE_LBL[t.type] || t.type || '—';
      const bal  = parseFloat(t.balance_after || 0);
      const svc  = Array.isArray(t.record_services) ? t.record_services.map(s => s.title || s).join(', ') : '';
      return `<tr>
        <td style="color:var(--t3)">${date}</td>
        <td style="color:${amt >= 0 ? 'var(--a)' : 'var(--danger)'};font-weight:600">${amt >= 0 ? '+' : ''}${amt.toLocaleString('ru')}</td>
        <td style="color:var(--t2);font-size:12px">${esc(desc)}${svc ? '<br><span style="color:var(--t3)">' + esc(svc) + '</span>' : ''}</td>
        <td style="font-weight:600">${bal.toLocaleString('ru')}</td>
      </tr>`;
    }).join('');

    const s = r.summary || {};
    el.innerHTML = `
      <div class="div"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700">Полная история операций (${txns.length})</div>
        <div style="font-size:12px;color:var(--t3)">
          Начислено: <span style="color:var(--a);font-weight:600">+${parseFloat(s.totalAccrued || 0).toLocaleString('ru')}</span> ·
          Списано: <span style="color:var(--danger);font-weight:600">-${parseFloat(s.totalRedeemed || 0).toLocaleString('ru')}</span>
        </div>
      </div>
      <div style="max-height:300px;overflow-y:auto">
        <table><thead><tr><th>Дата</th><th>Сумма</th><th>Описание</th><th>Баланс</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  } catch(e) { el.innerHTML = `<div style="margin-top:10px;font-size:12.5px;color:var(--danger)">Ошибка: ${esc(e.message)}</div>`; }
}

async function quickB(id, sign) {
  const amt = parseInt(document.getElementById('qAmt')?.value) || 0;
  const cmt = document.getElementById('qCmt')?.value || 'Ручная корректировка';
  if (!amt) { notify('Введите количество', 'err'); return; }
  try {
    await api('POST', '/api/clients/' + id + '/bonus', {amount: sign * amt, description: cmt});
    notify(sign > 0 ? '+' + amt + ' начислено' : '-' + amt + ' списано', 'ok');
    closeModal('clientModal');
    loadClients();
  } catch(e) { notify(e.message, 'err'); }
}

// ── Бонусный модал (поиск клиента + начисление) ────────────────
async function searchBonusC(q) {
  const el = document.getElementById('bmr'); bonusTarget = null;
  if (!q) { el.innerHTML = ''; return; }
  try {
    const d = await api('GET', '/api/clients?search=' + encodeURIComponent(q) + '&limit=5');
    if (!d.clients?.length) { el.innerHTML = '<div style="font-size:12px;color:var(--t3)">Не найдено</div>'; return; }
    // Never interpolate client names into inline onclick handlers — HTML
    // attribute decoding bypasses esc()/escAttr() and produces XSS.
    // Use data-* + event delegation instead.
    el.innerHTML = d.clients.map(c => `
      <div data-bonus-pick="${c.id}" data-bonus-balance="${c.bonus_balance || 0}" style="padding:7px 10px;border:1px solid var(--bd);border-radius:7px;cursor:pointer;margin-bottom:4px;font-size:12.5px">
        <strong>${esc(c.name)}</strong> · ${esc(c.phone || '—')} · <span style="color:var(--a)">${c.bonus_balance || 0} бонусов</span>
      </div>`).join('');
    if (!el._bonusDelegated) {
      el.addEventListener('click', (e) => {
        const row = e.target.closest('[data-bonus-pick]');
        if (!row) return;
        const id = parseInt(row.dataset.bonusPick, 10);
        const balance = parseFloat(row.dataset.bonusBalance) || 0;
        const name = row.querySelector('strong')?.textContent || '';
        selBC(id, name, balance);
      });
      el._bonusDelegated = true;
    }
  } catch(e) { console.error('searchBonusC:', e); }
}

function selBC(id, name) {
  bonusTarget = id;
  document.getElementById('bms').value = name;
  document.getElementById('bmr').innerHTML = `<div style="font-size:12px;color:var(--a)">✓ ${esc(name)}</div>`;
}

async function submitBonus(sign) {
  if (!bonusTarget) { notify('Выберите клиента', 'err'); return; }
  const amt = parseInt(document.getElementById('bma')?.value) || 0;
  const cmt = document.getElementById('bmc')?.value || 'Ручная корректировка';
  if (!amt) { notify('Введите количество', 'err'); return; }
  try {
    await api('POST', '/api/clients/' + bonusTarget + '/bonus', {amount: sign * amt, description: cmt});
    notify(sign > 0 ? '+' + amt + ' начислено' : '-' + amt + ' списано', 'ok');
    closeModal('bonusModal');
    if (sign > 0) fireConfetti();
    loadClients();
  } catch(e) { notify(e.message, 'err'); }
}
