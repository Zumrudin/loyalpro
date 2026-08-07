// ── НАПОМИНАНИЯ О ПОВТОРНОМ ВИЗИТЕ (вкладки страницы «Забота») ──
// Вкладка «Напоминания»: CRUD reminder_rules + догон по базе.
// Вкладка «История напоминаний»: журнал reminder_queue с бонусами, конверсией
// и ручным тумблером анти-повтора.
// Зависимости: api(), esc(), escAttr(), notify() и модуль conditions-editor.js
// (условия этой вкладки адресуются префиксом 'rem' — так же названы id
// разметки: #remConds/#remLogicWrap/#remLogic-and/#remLogic-or).

const REM_STATUS = {
  scheduled: { lbl: 'Запланировано', color: '#9ca3af' },
  sent:      { lbl: 'Отправлено',    color: '#10b981' },
  skipped:   { lbl: 'Пропущено',     color: '#f59e0b' },
  cancelled: { lbl: 'Отменено',      color: '#9ca3af' },
  failed:    { lbl: 'Ошибка',        color: '#ef4444' },
};
const REM_TIER_LBL = { accrue: 'начислено', mention: 'упомянут баланс', none: 'без бонусов', no_bonus: 'бонусы недоступны' };

let _remRules = [];
let _remEditId = null;
let _remMode = 'strict';
let _remTiers = [];          // [{ upTo, action, amount, text }]
let _remBfRuleId = null;
let _remBfRows = null;

// ── вкладка «Напоминания» ──────────────────────────────────────

async function remLoadRules() {
  try {
    const d = await api('GET', '/api/reminders/rules');
    _remRules = d.rules || [];
    remRenderRules();
    remFillHistoryFilter();
  } catch (e) { notify(e.message || 'Не удалось загрузить правила', 'err'); }
}

function remRenderRules() {
  const wrap = document.getElementById('remRules');
  if (!wrap) return;
  if (!_remRules.length) {
    wrap.className = 'empty';
    wrap.innerHTML = 'Правил пока нет. Создайте первое — например, «Лазерная эпиляция раз в месяц».';
    return;
  }
  wrap.className = '';
  wrap.innerHTML = _remRules.map(r => `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
        <div>
          <div style="font-weight:600">${esc(r.title)}
            <span class="bc-chip ${r.isEnabled ? 'on' : ''}" style="margin-left:8px">${r.isEnabled ? 'включено' : 'выключено'}</span>
          </div>
          <div style="font-size:12px;color:var(--t3);margin-top:4px">
            Через ${r.delayDays} дн. в ${esc(r.sendTime)} ·
            ${r.textMode === 'free' ? 'Мила пишет сама' : 'готовый текст'} ·
            ${r.bonusEnabled ? `бонусы: ${(r.bonusTiers || []).length} ступ.` : 'без бонусов'}
          </div>
          <div style="font-size:12px;color:var(--t3);margin-top:4px">
            В очереди: ${r.queuedCount} · отправлено: ${r.sentCount} ·
            записались: ${r.convertedCount} · дошли: ${r.visitedCount} ·
            начислено бонусов: ${r.bonusTotal}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sec btn-sm" onclick="remOpenBackfill(${r.id})">👁 Догон</button>
          <button class="btn btn-sec btn-sm" onclick="remOpenRuleModal(${r.id})">Изменить</button>
          <button class="btn btn-sec btn-sm" onclick="remToggleRule(${r.id})">${r.isEnabled ? 'Выключить' : 'Включить'}</button>
          <button class="btn btn-sec btn-sm" onclick="remDeleteRule(${r.id})">Удалить</button>
        </div>
      </div>
    </div>`).join('');
}

async function remToggleRule(id) {
  try { await api('POST', `/api/reminders/rules/${id}/toggle`); await remLoadRules(); }
  catch (e) { notify(e.message || 'Не удалось переключить', 'err'); }
}

async function remDeleteRule(id) {
  if (!confirm('Удалить правило? История отправок сохранится.')) return;
  try { await api('DELETE', `/api/reminders/rules/${id}`); await remLoadRules(); notify('Правило удалено'); }
  catch (e) { notify(e.message || 'Не удалось удалить', 'err'); }
}

// ── редактор правила ───────────────────────────────────────────

async function remOpenRuleModal(id) {
  try { await careEnsureDicts(); }                // общий словарь с «Заботой»
  catch (e) { notify('Ошибка справочников: ' + e.message, 'err'); return; }
  condInit('rem', _careDicts);
  _remEditId = id || null;
  const r = id ? _remRules.find(x => x.id === id) : null;
  document.getElementById('remRuleTitle').textContent = r ? 'Правило напоминания' : 'Новое правило';
  document.getElementById('remTitle').value = r ? r.title : '';
  document.getElementById('remDelay').value = r ? r.delayDays : 30;
  document.getElementById('remSendTime').value = r ? r.sendTime : '11:00';
  document.getElementById('remAttrDays').value = r ? r.attributionDays : 30;
  document.getElementById('remCap').value = r ? r.backfillMaxPerDay : 30;
  document.getElementById('remText').value = r ? r.text : '';
  document.getElementById('remBonusEnabled').checked = r ? !!r.bonusEnabled : false;
  _remTiers = r && Array.isArray(r.bonusTiers)
    ? r.bonusTiers.map(t => ({ upTo: t.up_to, action: t.action, amount: t.amount, text: t.text || '' }))
    : [];
  remSetMode(r ? r.textMode : 'strict');
  condSet('rem', r ? r.conditions : { logic: 'and', items: [] });
  remRenderTiers();
  document.getElementById('remSaveBtn').disabled = false;
  document.getElementById('remRuleOv').classList.add('open');
}

function remCloseRuleModal() { document.getElementById('remRuleOv').classList.remove('open'); }

function remSetMode(mode) {
  _remMode = mode === 'free' ? 'free' : 'strict';
  document.getElementById('remMode-strict').classList.toggle('on', _remMode === 'strict');
  document.getElementById('remMode-free').classList.toggle('on', _remMode === 'free');
}

function remAddTier() {
  _remTiers.push({ upTo: 500, action: 'accrue', amount: 300, text: '' });
  remRenderTiers();
}

function remRemoveTier(i) { _remTiers.splice(i, 1); remRenderTiers(); }

function remTierField(i, field, value) {
  if (field === 'upTo') _remTiers[i].upTo = value === '' ? null : Number(value);
  else if (field === 'amount') _remTiers[i].amount = Number(value) || 0;
  else _remTiers[i][field] = value;
  if (field === 'action') remRenderTiers();
}

function remRenderTiers() {
  const on = document.getElementById('remBonusEnabled').checked;
  const wrap = document.getElementById('remTiers');
  document.getElementById('remAddTierBtn').style.display = on ? '' : 'none';
  if (!on) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = _remTiers.map((t, i) => `
    <div class="nr-cond" style="margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--t3)">баланс меньше</span>
        <input type="number" min="0" style="width:110px" value="${t.upTo === null ? '' : t.upTo}"
               placeholder="без предела" oninput="remTierField(${i},'upTo',this.value)">
        <select style="width:auto" onchange="remTierField(${i},'action',this.value)">
          <option value="accrue"  ${t.action === 'accrue'  ? 'selected' : ''}>начислить</option>
          <option value="mention" ${t.action === 'mention' ? 'selected' : ''}>только упомянуть баланс</option>
          <option value="none"    ${t.action === 'none'    ? 'selected' : ''}>без бонусов</option>
        </select>
        ${t.action === 'accrue' ? `<input type="number" min="1" style="width:100px" value="${t.amount}"
               placeholder="бонусов" oninput="remTierField(${i},'amount',this.value)">` : ''}
        <button class="mc" onclick="remRemoveTier(${i})" title="Убрать ступень">✕</button>
      </div>
      <textarea rows="2" placeholder="Текст для этой ступени (пусто — возьмётся основной текст правила)"
                oninput="remTierField(${i},'text',this.value)">${esc(t.text || '')}</textarea>
    </div>`).join('') || '<div class="empty" style="padding:10px 0">Ступеней нет — добавьте хотя бы одну</div>';
}

async function remSaveRule() {
  const body = {
    title: document.getElementById('remTitle').value.trim(),
    conditions: condGet('rem'),
    delayDays: Number(document.getElementById('remDelay').value),
    sendTime: document.getElementById('remSendTime').value,
    textMode: _remMode,
    text: document.getElementById('remText').value.trim(),
    attributionDays: Number(document.getElementById('remAttrDays').value),
    backfillMaxPerDay: Number(document.getElementById('remCap').value),
    bonusEnabled: document.getElementById('remBonusEnabled').checked,
    bonusTiers: _remTiers.map(t => ({ upTo: t.upTo, action: t.action, amount: t.amount, text: t.text || '' })),
  };
  if (!condHasAny('rem')) {
    return notify('Добавьте хотя бы одно условие: без него напоминание уйдёт после любого визита', 'err');
  }
  // Блокировка на время запроса — как в careSaveProgram(): без неё двойной клик
  // (или медленная сеть + повторный клик) создаёт два одинаковых ВКЛЮЧЁННЫХ
  // правила, и оба потом независимо планируют напоминания одному клиенту.
  const btn = document.getElementById('remSaveBtn');
  btn.disabled = true;
  try {
    if (_remEditId) await api('PUT', `/api/reminders/rules/${_remEditId}`, body);
    else await api('POST', '/api/reminders/rules', body);
    remCloseRuleModal();
    await remLoadRules();
    notify('Правило сохранено');
  } catch (e) {
    notify(e.message || 'Не удалось сохранить', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── догон по базе ──────────────────────────────────────────────

const REM_SKIP_LBL = {
  no_phone: 'нет телефона', blacklist: 'чёрный список', muted: 'уже напоминали',
  already_queued: 'уже в очереди', future_booking: 'уже записан', superseded: 'есть визит позже',
};

function remOpenBackfill(ruleId) {
  _remBfRuleId = ruleId;
  _remBfRows = null;
  document.getElementById('remBfResult').className = 'empty';
  document.getElementById('remBfResult').innerHTML = 'Задайте период и нажмите «Показать выборку»';
  document.getElementById('remBfRunBtn').disabled = true;
  document.getElementById('remBackfillOv').classList.add('open');
}

function remCloseBackfill() { document.getElementById('remBackfillOv').classList.remove('open'); }

// Правка периода ПОСЛЕ построения выборки делает старое превью (и число в
// confirm() внутри remRunBackfill) недостоверными для НОВОГО значения поля —
// без сброса кнопка «Поставить в очередь» осталась бы включённой, а сам
// запуск послал бы на сервер СВЕЖИЙ days из поля при СТАРОМ подтверждённом
// числе. Сбрасываем результат и гасим кнопку до следующего «Показать выборку».
function remBfDaysChanged() {
  _remBfRows = null;
  const box = document.getElementById('remBfResult');
  box.className = 'empty';
  box.innerHTML = 'Задайте период и нажмите «Показать выборку»';
  document.getElementById('remBfRunBtn').disabled = true;
}

async function remRunBackfillPreview() {
  const days = Number(document.getElementById('remBfDays').value) || 30;
  const box = document.getElementById('remBfResult');
  box.className = 'empty';
  box.innerHTML = 'Считаю…';
  try {
    const d = await api('POST', `/api/reminders/rules/${_remBfRuleId}/backfill/preview`, { days });
    _remBfRows = d;
    box.className = '';
    const willSend = d.totals.willSend;
    document.getElementById('remBfRunBtn').disabled = willSend === 0;
    box.innerHTML = `
      <div style="margin:10px 0;font-size:13px">
        Записей за период: ${d.totals.records} · состоявшихся: ${d.totals.completed} ·
        под условия: ${d.totals.matched} · <b>уйдёт напоминаний: ${willSend}</b>
        ${d.lastScheduledAt ? ` · последнее ${remFmt(d.lastScheduledAt)}` : ''}
      </div>
      ${d.catMapFailed ? '<div class="empty" style="color:#f59e0b">Карта категорий не загрузилась — условия по категории не сработают</div>' : ''}
      <div class="tw"><table><thead><tr>
        <th>Клиент</th><th>Визит</th><th>Услуги</th><th>Итог</th>
      </tr></thead><tbody>
      ${d.rows.slice(0, 200).map(r => `<tr>
        <td>${esc(r.clientName || r.phone || '')}</td>
        <td>${remFmt(r.visitAt)}</td>
        <td>${esc((r.services || []).map(s => s.title).join(', '))}</td>
        <td>${r.skipReason ? `<span style="color:var(--t3)">${esc(REM_SKIP_LBL[r.skipReason] || r.skipReason)}</span>`
                           : '<span style="color:#10b981">уйдёт</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>
      ${d.rows.length > 200 ? `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 200 из ${d.rows.length}</div>` : ''}`;
  } catch (e) {
    box.className = 'empty';
    box.innerHTML = esc(e.message || 'Не удалось построить выборку');
  }
}

async function remRunBackfill() {
  // Период берём из ПОСТРОЕННОГО превью (d.days с бэкенда), а не заново из
  // поля: поле могло уйти вперёд превью (remBfDaysChanged на этот случай уже
  // гасит кнопку, но функция не должна полагаться только на состояние DOM).
  // Без превью отправлять нечего — n и days должны быть ровно тем, что видел
  // администратор в подтверждении.
  if (!_remBfRows) return;
  const days = _remBfRows.days;
  const n = _remBfRows.totals.willSend;
  if (!confirm(`Поставить в очередь ${n} напоминаний? Они уйдут живым клиентам по расписанию правила.`)) return;
  try {
    const d = await api('POST', `/api/reminders/rules/${_remBfRuleId}/backfill`, { days });
    remCloseBackfill();
    await remLoadRules();
    notify(`Поставлено в очередь: ${d.queued}`);
  } catch (e) { notify(e.message || 'Не удалось выполнить догон', 'err'); }
}

// ── вкладка «История напоминаний» ──────────────────────────────

function remFillHistoryFilter() {
  const sel = document.getElementById('remHistRule');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Все правила</option>' +
    _remRules.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('');
  sel.value = cur;
}

async function remLoadHistory() {
  if (!_remRules.length) await remLoadRules();
  const q = new URLSearchParams();
  const rule = document.getElementById('remHistRule').value;
  const status = document.getElementById('remHistStatus').value;
  const conv = document.getElementById('remHistConv').value;
  if (rule) q.set('ruleId', rule);
  if (status) q.set('status', status);
  if (conv) q.set('converted', conv);
  q.set('limit', '100');
  try {
    const d = await api('GET', `/api/reminders/history?${q}`);
    remRenderHistory(d.rows || []);
  } catch (e) { notify(e.message || 'Не удалось загрузить историю', 'err'); }
}

function remRenderHistory(rows) {
  const body = document.getElementById('remHistBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">Отправок пока нет</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const st = REM_STATUS[r.status] || { lbl: r.status, color: '#9ca3af' };
    const bonus = r.bonusAccrued ? `+${r.bonusAccrued}` : (REM_TIER_LBL[r.bonusTier] || '—');
    // Запланированные строки тоже живут в этой таблице (фильтр «Запланировано»):
    // отдельной вкладки очереди нет, и время у них своё — scheduled_at.
    const when = r.status === 'scheduled' ? r.scheduledAt : r.sentAt;
    return `<tr>
      <td>${remFmt(when)}</td>
      <td>${esc(r.clientName || r.phone || '')}</td>
      <td>${esc(r.ruleTitle || '—')}</td>
      <td title="баланс был: ${r.balanceBefore == null ? 'неизвестен' : r.balanceBefore}">${esc(String(bonus))}</td>
      <td style="max-width:320px">${esc((r.text || '').slice(0, 200))}</td>
      <td><span style="color:${st.color}">${esc(st.lbl)}</span>
          ${r.reason ? `<div style="font-size:11px;color:var(--t3)">${esc(r.reason)}</div>` : ''}</td>
      <td>${r.convertedAt ? remFmt(r.convertedAt) : '—'}</td>
      <td>${r.visitedAt ? remFmt(r.visitedAt) : '—'}</td>
      <td>${r.status === 'scheduled'
             ? `<button class="btn btn-sec btn-sm" onclick="remCancelQueued(${r.id})">Отменить</button>`
             : (r.ruleId ? `<button class="btn btn-sec btn-sm" onclick="remToggleMute(${r.ruleId}, '${escJs(r.phone)}', ${!r.muted})">
                  ${r.muted ? 'Разрешить снова' : 'Запретить'}</button>` : '')}</td>
    </tr>`;
  }).join('');
}

async function remCancelQueued(id) {
  if (!confirm('Отменить запланированное напоминание?')) return;
  try {
    await api('POST', `/api/reminders/queue/${id}/cancel`);
    await remLoadHistory();
    notify('Напоминание отменено');
  } catch (e) { notify(e.message || 'Не удалось отменить', 'err'); }
}

async function remToggleMute(ruleId, phone, muted) {
  try {
    await api('POST', '/api/reminders/suppressions/toggle', { ruleId, phone, muted });
    await remLoadHistory();
    notify(muted ? 'Напоминания по этому правилу запрещены' : 'Напоминания разрешены снова');
  } catch (e) { notify(e.message || 'Не удалось изменить флаг', 'err'); }
}

function remFmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
