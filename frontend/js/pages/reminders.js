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
  const wrap = document.getElementById('remRules');
  if (wrap && !wrap.innerHTML.trim()) { wrap.className = 'empty'; wrap.innerHTML = 'Загрузка…'; }
  try {
    const d = await api('GET', '/api/reminders/rules');
    _remRules = d.rules || [];
    remRenderRules();
    remFillHistoryFilter();
  } catch (e) {
    notify(e.message || 'Не удалось загрузить правила', 'err');
    if (wrap) {
      wrap.className = 'empty';
      wrap.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message || 'не удалось загрузить правила')}</span>`;
    }
  }
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
  // Раскладка карточки — та же, что у программ «Заботы» (.bc-row + тумблер +
  // чипы статистики): страница одна, и две разные визуальные грамматики на
  // соседних вкладках читаются как два разных раздела.
  wrap.innerHTML = _remRules.map(r => {
    const on = !!r.isEnabled;
    const conv = r.sentCount ? Math.round((r.convertedCount / r.sentCount) * 100) : null;
    return `
    <div class="bc-row" data-id="${r.id}">
      <div class="bc-row-grid">
        <div class="bc-row-left">
          <div class="care-card-title">
            <label class="tgl" title="${on ? 'Выключить правило' : 'Включить правило'}"><input type="checkbox" ${on ? 'checked' : ''}
              onchange="remToggleRule(${r.id})"><span class="ts"></span></label>
            <b>${esc(r.title)}</b>
            ${on ? '' : '<span class="care-badge care-st-stopped">выключено</span>'}
          </div>
          <div class="care-meta">
            Через ${r.delayDays} дн. в ${esc(r.sendTime)} ·
            ${r.textMode === 'free' ? '✍️ Мила пишет сама' : '📋 готовый текст'} ·
            ${r.bonusEnabled ? `🎁 бонусы: ${(r.bonusTiers || []).length} ступ.` : 'без бонусов'}
          </div>
          <div class="care-stats">
            <span class="care-stat on" title="Ждут отправки"><b>${r.queuedCount}</b> в очереди</span>
            <span class="care-stat" title="Всего отправлено напоминаний"><b>${r.sentCount}</b> отправлено</span>
            <span class="care-stat" title="Записались после напоминания${conv === null ? '' : ` — ${conv}% от отправленных`}"><b>${r.convertedCount}</b> записались${conv === null ? '' : ` · ${conv}%`}</span>
            <span class="care-stat" title="Дошли до визита"><b>${r.visitedCount}</b> дошли</span>
            <span class="care-stat" title="Начислено бонусов по этому правилу"><b>${r.bonusTotal}</b> бонусов</span>
          </div>
        </div>
        <div class="bc-row-right">
          <div class="care-acts">
            <button class="btn btn-sec btn-sm" onclick="remOpenTest(${r.id})" title="Отправить это правило на свой номер">🧪 Тест</button>
            <button class="btn btn-sec btn-sm" onclick="remOpenBackfill(${r.id})" title="Кому ушло бы, если бы правило работало последние N дней">👁 Догон</button>
            <button class="btn btn-sec btn-sm" onclick="remOpenRuleModal(${r.id})">✏️ Изменить</button>
            <button class="btn btn-sec btn-sm care-act-icon" onclick="remDeleteRule(${r.id})" title="Удалить правило">🗑</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function remToggleRule(id) {
  try { await api('POST', `/api/reminders/rules/${id}/toggle`); await remLoadRules(); }
  catch (e) {
    notify(e.message || 'Не удалось переключить', 'err');
    // Тумблер уже переключился визуально — вернуть его к состоянию из модели,
    // иначе карточка врёт «включено» на правиле, которое осталось выключенным.
    remRenderRules();
  }
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
  // r.sendIntervalMin может прийти null/undefined у старого правила — тогда 3
  // (тот же дефолт, что бэкенд подставляет при отсутствии поля).
  document.getElementById('remInterval').value = r && r.sendIntervalMin != null ? r.sendIntervalMin : 3;
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
  const hint = '<div class="bc-section-hint" style="margin:6px 0 8px">' +
    'Порог не включается: ступень ловит баланс <b>строго меньше</b> указанного. ' +
    'Ступень с пустым порогом — «весь остаток», её стоит поставить последней.</div>';
  wrap.innerHTML = (_remTiers.map((t, i) => `
    <div class="nr-cond rem-tier" style="margin-bottom:8px">
      <div class="rem-tier-head">
        <span class="care-touch-num">${i + 1}</span>
        <span class="rem-tier-lbl">Ступень ${i + 1}</span>
        <button class="mc" onclick="remRemoveTier(${i})" title="Убрать ступень">✕</button>
      </div>
      <div class="rem-tier-fields">
        <label class="care-touch-lbl">баланс меньше
          <input type="number" min="0" style="width:110px" value="${t.upTo === null ? '' : t.upTo}"
                 placeholder="без предела" oninput="remTierField(${i},'upTo',this.value)"></label>
        <select style="width:auto" onchange="remTierField(${i},'action',this.value)">
          <option value="accrue"  ${t.action === 'accrue'  ? 'selected' : ''}>начислить бонусы</option>
          <option value="mention" ${t.action === 'mention' ? 'selected' : ''}>только упомянуть баланс</option>
          <option value="none"    ${t.action === 'none'    ? 'selected' : ''}>без бонусов</option>
        </select>
        ${t.action === 'accrue' ? `<label class="care-touch-lbl">сколько
          <input type="number" min="1" style="width:100px" value="${t.amount}"
                 placeholder="бонусов" oninput="remTierField(${i},'amount',this.value)"></label>` : ''}
      </div>
      <textarea rows="2" placeholder="Текст для этой ступени (пусто — возьмётся основной текст правила)"
                oninput="remTierField(${i},'text',this.value)">${esc(t.text || '')}</textarea>
    </div>`).join('') || '<div class="empty" style="padding:10px 0">Ступеней нет — добавьте хотя бы одну</div>') + hint;
}

async function remSaveRule() {
  // Number('') === 0, а 0 значит «слать без паузы» — самое опасное значение
  // из всех. Пустое поле уходит на сервер пустой строкой (бэкенд трактует её
  // как «поле не задано» и подставляет дефолт 3), а не как явный ноль.
  const rawInterval = document.getElementById('remInterval').value;
  const body = {
    title: document.getElementById('remTitle').value.trim(),
    conditions: condGet('rem'),
    delayDays: Number(document.getElementById('remDelay').value),
    sendTime: document.getElementById('remSendTime').value,
    textMode: _remMode,
    text: document.getElementById('remText').value.trim(),
    attributionDays: Number(document.getElementById('remAttrDays').value),
    backfillMaxPerDay: Number(document.getElementById('remCap').value),
    sendIntervalMin: rawInterval === '' ? '' : Number(rawInterval),
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

// Окно темпа 09:00–21:00 мск (DAY_WINDOW_START_MIN/END_MIN в
// backend/services/messaging/send-pacing.js) — вне него отправка переносится
// на ближайшее наступление send_time правила, поэтому выше пропускной
// способности окна не выжать, сколько бы ни был кап догона.
const REM_PACE_WINDOW_START_MIN = 9 * 60;
const REM_PACE_WINDOW_END_MIN = 21 * 60;

// «1 сообщение» — не редкость: при send_time у самого края окна ёмкость дня
// действительно одна строка.
function remPluralMsg(n) {
  const t = Math.abs(n) % 100, o = t % 10;
  if (t > 10 && t < 20) return 'сообщений';
  if (o > 1 && o < 5) return 'сообщения';
  if (o === 1) return 'сообщение';
  return 'сообщений';
}

/**
 * Заметка о пропускной способности темпа под сводкой превью. Правило тут
 * недоступно из ответа /backfill/preview (он его не отдаёт), но оно уже
 * загружено в _remRules — тащить его отдельным запросом не нужно.
 *
 * Ёмкость дня считается от SEND_TIME ПРАВИЛА, а не от всего окна: рассылка
 * стартует в send_time и упирается в конец окна, то есть доступен отрезок
 * [send_time, 21:00) — при 11:00 это 600 минут, при 15:00 всего 360, а не 720.
 * Взятое целиком окно завышало оценку почти вдвое, и предупреждение «кап выше
 * предела» не показывалось там, где хвост реально растягивается на дни.
 *
 * send_time ВНЕ окна — заметки нет вовсе: потолок по времени суток в этом
 * случае не применяется (салон выбрал время осознанно), и любая оценка была бы
 * выдумкой. Границы те же, что у sendTimeInDayWindow на бэкенде: конец
 * ВКЛЮЧИТЕЛЬНЫЙ, 21:00 — законное значение формы.
 */
function remPaceNote(rule) {
  const interval = rule ? Number(rule.sendIntervalMin) : NaN;
  if (!Number.isFinite(interval) || interval <= 0) return '';
  const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(String((rule && rule.sendTime) || '').trim());
  if (!m) return '';
  const sendMin = +m[1] * 60 + +m[2];
  if (sendMin < REM_PACE_WINDOW_START_MIN || sendMin > REM_PACE_WINDOW_END_MIN) return '';
  // Первое сообщение уходит в сам send_time, дальше по одному раз в interval,
  // пока не кончится окно — отсюда минимум 1 даже у send_time на его краю.
  const perDay = Math.max(1, Math.floor((REM_PACE_WINDOW_END_MIN - sendMin) / interval));
  const cap = rule && Number.isFinite(Number(rule.backfillMaxPerDay)) ? Number(rule.backfillMaxPerDay) : null;
  const overCap = cap != null && cap > perDay;
  return `<div style="margin:0 0 10px;font-size:12px;color:${overCap ? '#f59e0b' : 'var(--t3)'}">
    С паузой ${interval} мин темп даёт не больше ${perDay} ${remPluralMsg(perDay)} в сутки (от ${esc(m[0])} до 21:00)${
      overCap ? ` — кап догоняющей пачки (${cap}) выше этого предела, хвост растянется на несколько дней` : ''}.
  </div>`;
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
    // Даты в превью — это ПЛАНОВАЯ постановка в очередь (planBackfillSchedule),
    // а не гарантия момента отправки: воркер её двигает паузой темпа и ночным
    // потолком (services/messaging/send-pacing.js). Сортировка — по этой же
    // плановой дате, строки без неё (skipReason) — в хвост, иначе колонка
    // читается как каша (просроченные приходят от бэкенда в порядке «самый
    // давний визит первым», а живая выборка — «свежий визит сверху»).
    const rows = [...d.rows].sort((a, b) => {
      const am = a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity;
      const bm = b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity;
      return am - bm;
    });
    const rule = _remRules.find(x => x.id === _remBfRuleId);
    box.innerHTML = `
      <div style="margin:10px 0;font-size:13px">
        Записей за период: ${d.totals.records} · состоявшихся: ${d.totals.completed} ·
        под условия: ${d.totals.matched} · <b>уйдёт напоминаний: ${willSend}</b>
      </div>
      <div style="margin:0 0 10px;font-size:13px">
        Просрочено (визит был больше задержки назад): <b>${d.overdueCount}</b>${
          d.lastOverdueAt ? ` · встанут в очередь по ${remFmt(d.lastOverdueAt)}` : ''} ·
        встанут в очередь на будущее: <b>${d.futureCount}</b>${
          d.lastFutureAt ? ` · последнее ${remFmt(d.lastFutureAt)}` : ''}
      </div>
      ${remPaceNote(rule)}
      ${d.catMapFailed ? '<div class="empty" style="color:#f59e0b">Карта категорий не загрузилась — условия по категории не сработают</div>' : ''}
      <div class="tw mtbl-wrap"><table class="mtbl"><thead><tr>
        <th>Клиент</th><th>Визит</th><th>Услуги</th><th>Встанет на</th><th>Итог</th>
      </tr></thead><tbody>
      ${rows.slice(0, 200).map(r => `<tr>
        <td class="mtbl-title"><b>${esc(r.clientName || r.phone || '')}</b></td>
        <td data-label="Визит">${remFmt(r.visitAt)}</td>
        <td class="mtbl-full" data-label="Услуги">${esc((r.services || []).map(s => s.title).join(', '))}</td>
        <td data-label="Встанет на">${remFmt(r.scheduledAt)}</td>
        <td data-label="Итог">${r.skipReason ? `<span class="care-badge care-st-stopped">${esc(REM_SKIP_LBL[r.skipReason] || r.skipReason)}</span>`
                           : '<span class="care-badge care-st-completed">уйдёт</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>
      ${rows.length > 200 ? `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 200 из ${rows.length}</div>` : ''}`;
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

// ── тестовая отправка на свой номер ────────────────────────────

let _remTestRuleId = null;

function remOpenTest(ruleId) {
  _remTestRuleId = ruleId;
  // Номер тестировщика между прогонами не меняется — не заставляем набирать
  // его заново на каждое правило.
  const saved = localStorage.getItem('remTestPhone') || '';
  document.getElementById('remTestPhone').value = saved;
  document.getElementById('remTestAccrue').checked = false;
  const box = document.getElementById('remTestResult');
  box.className = 'empty';
  box.innerHTML = 'Укажите номер и нажмите «Отправить тест»';
  document.getElementById('remTestOv').classList.add('open');
}

function remCloseTest() { document.getElementById('remTestOv').classList.remove('open'); }

async function remRunTest() {
  const phone = document.getElementById('remTestPhone').value.trim();
  if (!phone) return notify('Укажите номер телефона', 'err');
  const accrue = document.getElementById('remTestAccrue').checked;
  if (accrue && !confirm('Бонусы будут начислены на карту клиента по-настоящему. Отменить начисление нельзя. Продолжить?')) return;
  localStorage.setItem('remTestPhone', phone);

  const box = document.getElementById('remTestResult');
  const btn = document.getElementById('remTestRunBtn');
  // Двойной клик = два реальных сообщения живому человеку (на сервере тот же
  // случай ловит testInFlight, но ждать 409 незачем).
  btn.disabled = true;
  box.className = 'empty';
  box.innerHTML = 'Отправляю…';
  try {
    const d = await api('POST', `/api/reminders/rules/${_remTestRuleId}/test`, { phone, accrue });
    box.className = '';
    box.innerHTML = remTestResultHtml(d);
    await remLoadRules();
  } catch (e) {
    box.className = 'empty';
    box.innerHTML = esc(e.message || 'Не удалось выполнить тестовую отправку');
  } finally {
    btn.disabled = false;
  }
}

function remTestResultHtml(d) {
  const st = REM_STATUS[d.status] || { lbl: d.status || 'неизвестно', color: '#9ca3af' };
  const b = d.bonus || {};
  // В сухом прогоне «начислено» звучало бы как свершившийся факт — там сумма
  // сослагательная, и это единственное, что администратор обязан прочитать
  // однозначно.
  // Ступень no_bonus имеет ДВА разных смысла, и путать их нельзя: «баланс не
  // попал ни в одну ступень» — правило отработало штатно (сообщение уйдёт без
  // бонусной части), а «карты нет / YClients молчит» — сбой, который админ
  // будет чинить. Различает их balanceBefore: он известен, только если карту
  // реально прочитали.
  const tierLbl = b.tier === 'no_bonus' && b.balanceBefore != null
    ? 'баланс не попал ни в одну ступень'
    : (REM_TIER_LBL[b.tier] || b.tier || '—');
  // txnOk ТРЁХЗНАЧЕН: true — начислено, false — начисление упало, null —
  // транзакции не требовалось (ступень «упомянуть»/«ничего» или no_bonus).
  // Схлопывание в булево показывало «транзакция не прошла» там, где ничего и
  // не начислялось — это читается как сбой (поймано 08.08.2026).
  const txnLine = b.txnOk === true ? ' · начислено по-настоящему'
    : b.txnOk === false ? ' · <b>начисление не прошло</b>'
    : ' · начисления не требовалось';
  const bonusLine = !b.enabled
    ? 'бонусы в правиле выключены'
    : (b.dryRun
        ? `ступень «${tierLbl}»` +
          (b.accrued ? ` · начислилось бы ${b.accrued}` : '') +
          (b.balanceBefore == null ? ' · баланс карты неизвестен' : ` · баланс ${b.balanceBefore}`) +
          ' · <b>сухой прогон, деньги НЕ начислялись</b>'
        : `${tierLbl}` +
          (b.accrued ? ` · ${b.accrued} бонусов` : '') +
          (b.balanceBefore == null ? ' · баланс карты неизвестен' : ` · баланс был ${b.balanceBefore}`) +
          txnLine);
  const anchor = d.anchor
    ? `визит ${remFmt(d.anchor.visitAt)}${d.anchor.staffName ? ', ' + esc(d.anchor.staffName) : ''}` +
      `${(d.anchor.services || []).length ? ', ' + esc(d.anchor.services.map(s => s.title).join(', ')) : ''}`
    : (d.anchorFailed
        ? 'визиты клиента не загрузились — {услуга} и {мастер} подставились пустыми'
        : 'состоявшихся визитов ПОД УСЛОВИЯ ПРАВИЛА не нашлось — дата взята из задержки правила, {услуга} и {мастер} пустые');
  return `
    <div style="margin:10px 0;font-size:13px">
      <div>Итог: <span style="color:${st.color};font-weight:600">${esc(st.lbl)}</span>
        ${d.reason ? ` · ${esc(d.reason)}` : ''}${d.channel ? ` · канал: ${esc(d.channel)}` : ''}</div>
      <div style="margin-top:4px">Якорь: ${anchor}</div>
      <div style="margin-top:4px">Бонусы: ${bonusLine}</div>
      ${d.clientFound ? '' : '<div style="margin-top:4px;color:#f59e0b">Карточки клиента с таким номером нет — {first_name} подставилось пустым</div>'}
      ${d.error ? `<div style="margin-top:4px;color:#ef4444">${esc(d.error)}</div>` : ''}
    </div>
    ${d.text ? `<div class="card" style="white-space:pre-wrap;font-size:13px">${esc(d.text)}</div>`
             : '<div class="empty" style="padding:10px 0">Текст не отправлялся</div>'}`;
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
  // Заглушка на время запроса: смена фильтра иначе оставляет на экране СТАРЫЕ
  // строки без единого признака, что идёт перезагрузка (на медленной сети это
  // читается как «фильтр не сработал»).
  const body = document.getElementById('remHistBody');
  if (body) body.innerHTML = '<tr><td colspan="9" class="empty">Загрузка…</td></tr>';
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
  } catch (e) {
    notify(e.message || 'Не удалось загрузить историю', 'err');
    if (body) body.innerHTML = `<tr><td colspan="9" class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message || 'не удалось загрузить историю')}</td></tr>`;
  }
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
    // Полный текст — в title: в ячейке он обрезан 200 символами, и до правки
    // прочитать отправленное целиком было негде.
    const full = r.text || '';
    return `<tr>
      <td data-label="Когда">${remFmt(when)}${r.status === 'scheduled'
            ? ' <span style="font-size:11px;color:var(--t3)">(план)</span>' : ''}</td>
      <td class="mtbl-title"><b>${esc(r.clientName || r.phone || '')}</b>
        ${r.clientName && r.phone ? `<div style="font-size:11.5px;color:var(--t3)">${esc(r.phone)}</div>` : ''}</td>
      <td data-label="Правило">${esc(r.ruleTitle || '—')}${r.source === 'test'
            ? ' <span class="bc-chip" title="тестовая отправка администратором">тест</span>' : ''}</td>
      <td data-label="Бонусы" title="баланс был: ${r.balanceBefore == null ? 'неизвестен' : r.balanceBefore}">${esc(String(bonus))}</td>
      <td class="mtbl-full mtbl-hide-empty" data-label="Текст" style="max-width:320px"
          title="${escAttr(esc(full))}">${esc(full.slice(0, 200))}${full.length > 200 ? '…' : ''}</td>
      <td data-label="Статус"><span class="care-badge" style="background:${st.color}22;color:${st.color}">${esc(st.lbl)}</span>
          ${r.reason ? `<div style="font-size:11px;color:var(--t3);margin-top:2px">${esc(r.reason)}</div>` : ''}</td>
      <td data-label="Записался">${r.convertedAt ? '✅ ' + remFmt(r.convertedAt) : '—'}</td>
      <td data-label="Дошёл">${r.visitedAt ? '✅ ' + remFmt(r.visitedAt) : '—'}</td>
      <td class="mtbl-act mtbl-hide-empty">${r.status === 'scheduled'
             ? `<button class="btn btn-sec btn-sm" onclick="remCancelQueued(${r.id})">Отменить отправку</button>`
             : (r.ruleId ? `<button class="btn btn-sec btn-sm" onclick="remToggleMute(${r.ruleId}, '${escJs(r.phone)}', ${!r.muted})"
                  title="${r.muted ? 'Разрешить напоминания этому клиенту по этому правилу' : 'Больше не напоминать этому клиенту по этому правилу'}">
                  ${r.muted ? '🔔 Разрешить снова' : '🔕 Запретить'}</button>` : '')}</td>
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
