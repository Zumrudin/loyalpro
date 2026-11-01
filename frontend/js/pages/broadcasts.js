// ── BROADCASTS PAGE ────────────────────────────────────────────
// Зависимости: api(), esc(), notify()

// Все ключи сегментов из backend/services/segments.js — должны совпадать.
const BC_SEGMENTS = [
  { key: 'champion',          label: '🏆 Чемпион' },
  { key: 'growing',           label: '📈 Растущий' },
  { key: 'newcomer',          label: '🌱 Новичок' },
  { key: 'post_visit',        label: '✅ После визита' },
  { key: 'waiting_champion',  label: '⏳ Ожидаем чемпиона' },
  { key: 'waiting_growing',   label: '⏳ Ожидаем растущего' },
  { key: 'waiting_newcomer',  label: '⏳ Ожидаем новичка' },
  { key: 'champion_risk',     label: '⚠️ Чемпион в риске' },
  { key: 'growing_risk',      label: '⚠️ Растущий в риске' },
  { key: 'newcomer_risk',     label: '⚠️ Новичок в риске' },
  { key: 'sleeping_champion', label: '💤 Спящий чемпион' },
  { key: 'sleeping_growing',  label: '💤 Спящий растущий' },
  { key: 'sleeping_newcomer', label: '💤 Спящий новичок' },
  { key: 'no_visit',          label: '👤 Без визитов' },
];

const BC_STATUS_LBL = {
  pending:      { lbl: 'В очереди',    color: '#9ca3af' },
  in_progress:  { lbl: 'Отправляется', color: '#f59e0b' },
  completed:    { lbl: 'Завершена',    color: '#10b981' },
  cancelled:    { lbl: 'Отменена',     color: '#6b7280' },
  failed:       { lbl: 'Ошибка',       color: '#ef4444' },
};

let _bcPreviewTimer = null;
let _bcPollTimer = null;
let _bcSegmentsSel = new Set();

// ── Состояние формы «мессенджеры» ─────────────────────────────────────────────────────
let _bcTransport = 'messengers';   // 'messengers' | 'telegram_bot'
let _bcSource = 'filters';         // 'filters' | 'list'
let _bcList = null;                // rows последнего «Разобрать» (или заполненный извне список)
let _bcImageUrl = null;            // /uploads/broadcast_… после загрузки
let _bcImageBusy = false;
let _bcForecastTimer = null;
let _bcForecastGen = 0;            // поколение: запоздалый ответ прогноза не рисуем
let _bcLastForecast = null;

async function loadBroadcasts() {
  // Шапка с числом подписчиков и список истории.
  await bcRenderSegmentChips();
  await bcLoadHistory();
  bcStartPolling();
}

// Чипы сегментов — внутри composer-модалки.
async function bcRenderSegmentChips() {
  const wrap = document.getElementById('bcSegments');
  if (!wrap) return;
  wrap.innerHTML = BC_SEGMENTS.map(s => `
    <span class="bc-chip" data-key="${s.key}" onclick="bcToggleSeg('${s.key}', this)">
      ${esc(s.label)}
    </span>`).join('');
}

function bcToggleSeg(key, el) {
  if (_bcSegmentsSel.has(key)) {
    _bcSegmentsSel.delete(key);
    el.classList.remove('on');
  } else {
    _bcSegmentsSel.add(key);
    el.classList.add('on');
  }
  bcUpdatePreview();
}

function bcCollectFilters() {
  const filters = {};
  const ph = (document.getElementById('bcPhone').value || '').trim();
  if (ph) filters.phone = ph;
  if (_bcSegmentsSel.size) filters.segments = Array.from(_bcSegmentsSel);
  const bMin = document.getElementById('bcBonusMin').value;
  const bMax = document.getElementById('bcBonusMax').value;
  if (bMin !== '') filters.bonusMin = Number(bMin);
  if (bMax !== '') filters.bonusMax = Number(bMax);
  const dG = document.getElementById('bcDaysGte').value;
  const dL = document.getElementById('bcDaysLte').value;
  const lv = {};
  if (dG !== '') lv.gte = Number(dG);
  if (dL !== '') lv.lte = Number(dL);
  if (Object.keys(lv).length) filters.lastVisitDays = lv;
  const m = document.getElementById('bcBirthMonth').value;
  if (m) filters.birthMonth = Number(m);
  const g = document.getElementById('bcGender').value;
  if (g) filters.gender = g;
  return filters;
}

function bcUpdatePreview() {
  if (_bcTransport === 'messengers') { bcUpdateForecast(); return; }
  // Debounce, чтобы при быстром наборе не молотить сервер
  if (_bcPreviewTimer) clearTimeout(_bcPreviewTimer);
  _bcPreviewTimer = setTimeout(async () => {
    const cntEl = document.getElementById('bcPreviewCount');
    const smpEl = document.getElementById('bcPreviewSample');
    if (!cntEl) return;
    cntEl.textContent = '…';
    smpEl.textContent = '';
    try {
      const filters = bcCollectFilters();
      const url = `/api/broadcasts/subscribers/preview?filters=${encodeURIComponent(JSON.stringify(filters))}`;
      const d = await api('GET', url);
      cntEl.textContent = (d.total || 0).toLocaleString('ru');
      if (d.sample && d.sample.length) {
        const names = d.sample.slice(0, 5).map(s => s.name || s.phone || '—').join(', ');
        const more = d.total > 5 ? ` и ещё ${d.total - 5}` : '';
        smpEl.textContent = `например: ${names}${more}`;
      }
    } catch (e) {
      cntEl.textContent = '!';
      smpEl.textContent = e.message;
    }
  }, 350);
}

function bcOpenComposer() {
  // reset
  _bcSegmentsSel.clear();
  document.querySelectorAll('#bcSegments .bc-chip').forEach(el => el.classList.remove('on'));
  ['bcPhone', 'bcBonusMin', 'bcBonusMax', 'bcDaysGte', 'bcDaysLte'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('bcBirthMonth').value = '';
  document.getElementById('bcGender').value = '';
  document.getElementById('bcText').value = '';
  document.getElementById('bcCharCount').textContent = '0';
  document.getElementById('bcSendBtn').disabled = false;
  bcResetMessengerForm();
  document.getElementById('bcComposerOv').classList.add('open');
  bcSetTransport('messengers');
  // counter
  const ta = document.getElementById('bcText');
  ta.oninput = () => { document.getElementById('bcCharCount').textContent = String(ta.value.length); bcUpdateBonusHint(); };
  // Правка списка после «Разобрать» делает разобранное устаревшим — отправлять можно только разобранное.
  const lt = document.getElementById('bcListText');
  lt.oninput = bcInvalidateList;
  document.getElementById('bcListFile').onchange = bcInvalidateList;
  const tp = document.getElementById('bcTestPhone');
  if (tp) tp.value = localStorage.getItem('bcTestPhone') || '';
}

// Открыть форму в режиме «По списку» с готовым списком [{name, phone}] (монитор: «Новая рассылка по пропущенным»).
// Список считается уже разобранным: _bcList = list, сводка пишется в #bcListReport, прогноз запускается сразу.
function bcOpenComposerWithList(list) {
  bcOpenComposer();
  bcSetSource('list');
  _bcList = Array.isArray(list) ? list.map(r => ({ name: r.name || '', phone: r.phone })) : [];
  const rep = document.getElementById('bcListReport');
  rep.style.display = '';
  rep.innerHTML = `Получателей в списке: <b>${_bcList.length}</b> (подготовлен из прошлой рассылки)`;
  bcUpdateForecast();
}

function bcResetMessengerForm() {
  _bcList = null; _bcImageUrl = null; _bcImageBusy = false; _bcLastForecast = null;
  _bcForecastGen++;
  if (_bcForecastTimer) { clearTimeout(_bcForecastTimer); _bcForecastTimer = null; }
  document.getElementById('bcListText').value = '';
  document.getElementById('bcListFile').value = '';
  document.getElementById('bcListReport').style.display = 'none';
  bcClearImage();
  document.getElementById('bcCascade').checked = true;
  for (const ch of BC_CHANNELS) {
    document.getElementById(`bcCh-${ch.key}-on`).checked = true;
    document.getElementById(`bcCh-${ch.key}-delay`).value = String(ch.delay);
    document.getElementById(`bcCh-${ch.key}-limit`).value = '';
  }
  document.getElementById('bcOnLimit').value = 'next_channel';
  document.getElementById('bcForecast').textContent = '—';
  _bcSource = 'filters';
  document.querySelectorAll('#bcSource .bc-chip').forEach(el => el.classList.toggle('on', el.dataset.v === 'filters'));
  document.getElementById('bcListBlock').style.display = 'none';
}

function bcSetTransport(v) {
  _bcTransport = v === 'telegram_bot' ? 'telegram_bot' : 'messengers';
  document.querySelectorAll('#bcTransport .bc-chip').forEach(el => el.classList.toggle('on', el.dataset.v === _bcTransport));
  const msg = _bcTransport === 'messengers';
  document.querySelectorAll('#bcComposerOv .bc-msg-only').forEach(el => { el.style.display = msg ? '' : 'none'; });
  document.querySelectorAll('#bcComposerOv .bc-bot-only').forEach(el => { el.style.display = msg ? 'none' : ''; });
  // Блок списка внутри .bc-msg-only живёт по своему переключателю источника
  if (msg) bcSetSource(_bcSource);
  document.getElementById('bcPreview').style.display = msg ? 'none' : '';
  document.getElementById('bcFiltersSection').style.display = (msg && _bcSource === 'list') ? 'none' : '';
  bcUpdateBonusHint();
  bcUpdatePreview();
}

function bcSetSource(v) {
  _bcSource = v === 'list' ? 'list' : 'filters';
  document.querySelectorAll('#bcSource .bc-chip').forEach(el => el.classList.toggle('on', el.dataset.v === _bcSource));
  document.getElementById('bcListBlock').style.display = _bcSource === 'list' ? '' : 'none';
  document.getElementById('bcFiltersSection').style.display = (_bcTransport === 'messengers' && _bcSource === 'list') ? 'none' : '';
  bcUpdateBonusHint();
  if (_bcTransport === 'messengers') bcUpdateForecast();
}

function bcUpdateBonusHint() {
  const el = document.getElementById('bcBonusHint');
  if (!el) return;
  const t = (document.getElementById('bcText') || {}).value || '';
  el.style.display = (_bcTransport === 'messengers' && _bcSource === 'list' && t.includes('{bonuses}')) ? '' : 'none';
}

function bcInvalidateList() {
  _bcList = null;
  document.getElementById('bcListReport').style.display = 'none';
  bcUpdateForecast();
}

// multipart: api() умеет только JSON, поэтому свой fetch (как ntUploadAttachment). TOKEN — глобальный из core/api.js.
async function bcUpload(path, file) {
  const fd = new FormData();
  fd.append('file', file);
  const headers = {};
  const tok = (typeof TOKEN !== 'undefined' && TOKEN) || localStorage.getItem('lp_tk');
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(path, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (e) { /* HTML вместо JSON (502/404) */ }
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

async function bcParseList() {
  const btn = document.getElementById('bcListParseBtn');
  const rep = document.getElementById('bcListReport');
  const file = document.getElementById('bcListFile').files[0];
  const text = document.getElementById('bcListText').value;
  if (!file && !text.trim()) { notify('Вставьте список или выберите файл', 'err'); return; }
  btn.disabled = true;
  try {
    const d = file ? await bcUpload('/api/broadcasts/list/parse', file)
                   : await api('POST', '/api/broadcasts/list/parse', { text });
    _bcList = d.rows || [];
    const bad = d.invalid || [];
    rep.style.display = '';
    rep.innerHTML = `Распознано: <b>${_bcList.length}</b>` +
      ` · дубликатов: ${d.duplicates || 0} · в базе клиентов: ${d.inBase || 0} · в чёрном списке: ${d.blacklisted || 0}` +
      ` · битых строк: ${bad.length}` +
      (bad.length ? `<details style="margin-top:6px"><summary>Показать битые строки</summary>${bad.slice(0, 200).map(b => `<div>строка ${esc(String(b.line))}: ${esc(String(b.raw))}</div>`).join('')}</details>` : '');
    bcUpdateForecast();
  } catch (e) {
    _bcList = null;
    rep.style.display = '';
    rep.textContent = 'Ошибка: ' + e.message;
  } finally { btn.disabled = false; }
}

async function bcPickImage() {
  const inp = document.getElementById('bcImageFile');
  const file = inp.files[0];
  if (!file) return;
  _bcImageBusy = true;
  try {
    const d = await bcUpload('/api/broadcasts/image', file);
    _bcImageUrl = d.imageUrl;
    const pv = document.getElementById('bcImagePreview');
    pv.src = d.imageUrl; pv.style.display = '';
    document.getElementById('bcImageClear').style.display = '';
  } catch (e) {
    _bcImageUrl = null;
    inp.value = '';
    notify('Картинка не загружена: ' + e.message, 'err');
  } finally { _bcImageBusy = false; }
}

function bcClearImage() {
  _bcImageUrl = null;
  const inp = document.getElementById('bcImageFile'); if (inp) inp.value = '';
  const pv = document.getElementById('bcImagePreview'); if (pv) { pv.style.display = 'none'; pv.removeAttribute('src'); }
  const bt = document.getElementById('bcImageClear'); if (bt) bt.style.display = 'none';
}

function bcSaveTestPhone() {
  localStorage.setItem('bcTestPhone', document.getElementById('bcTestPhone').value.trim());
}

function bcReadField(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  return el.type === 'checkbox' ? el.checked : el.value;
}

// Тело T для /forecast, /test и POST / (спека §6). textFallback — прогнозу текст не нужен, но сервер
// валидирует тело целиком, поэтому подставляем заглушку.
function bcBuildBody(textFallback) {
  const text = document.getElementById('bcText').value.trim();
  return {
    transport: 'messengers',
    audienceSource: _bcSource,
    filters: _bcSource === 'filters' ? bcCollectFilters() : {},
    list: _bcSource === 'list' ? (_bcList || []).map(r => ({ name: r.name || '', phone: r.phone })) : [],
    messageTemplate: text || textFallback || '',
    imageUrl: _bcImageUrl || null,
    channelSettings: bcCollectChannelSettings(bcReadField),
    onLimit: document.getElementById('bcOnLimit').value,
    cascadeEnabled: document.getElementById('bcCascade').checked,
  };
}

function bcUpdateForecast() {
  if (_bcTransport !== 'messengers') return;
  if (_bcForecastTimer) clearTimeout(_bcForecastTimer);
  const gen = ++_bcForecastGen;
  const el = document.getElementById('bcForecast');
  if (!el) return;
  _bcLastForecast = null;
  if (_bcSource === 'list' && !(_bcList && _bcList.length)) { el.textContent = 'Разберите список — тогда появится прогноз'; return; }
  const cs = bcCollectChannelSettings(bcReadField);
  if (!BC_CHANNELS.some(ch => cs[ch.key].enabled)) { el.textContent = 'Включите хотя бы один мессенджер'; return; }
  el.textContent = 'считаю…';
  _bcForecastTimer = setTimeout(async () => {
    try {
      const r = await api('POST', '/api/broadcasts/forecast', bcBuildBody('.'));
      if (gen !== _bcForecastGen) return;          // пришёл запоздавший ответ — форма уже изменилась
      _bcLastForecast = r;
      el.textContent = bcFormatForecast(r);
    } catch (e) {
      if (gen !== _bcForecastGen) return;
      el.textContent = 'Прогноз недоступен: ' + e.message;
    }
  }, 500);
}

async function bcSendTest() {
  const phone = document.getElementById('bcTestPhone').value.trim();
  if (!phone) { notify('Укажите свой номер для теста', 'err'); return; }
  const errs = bcValidateMessengerForm(bcFormState());
  // Для теста список получателей не нужен
  const rel = errs.filter(e => !e.startsWith('Загрузите список'));
  if (rel.length) { notify(rel[0], 'err'); return; }
  const btn = document.getElementById('bcTestBtn');
  btn.disabled = true;
  try {
    const body = bcBuildBody();
    if (_bcSource === 'list' && !body.list.length) body.list = [{ name: '', phone }];
    const r = await api('POST', '/api/broadcasts/test', { ...body, testPhone: phone });
    notify(r.ok ? `Тест отправлен (${r.channel})` : `Тест не ушёл: ${r.error || 'ошибка'}`, r.ok ? 'ok' : 'err');
  } catch (e) {
    notify('Ошибка теста: ' + e.message, 'err');
  } finally { btn.disabled = false; }
}

function bcFormState() {
  return {
    audienceSource: _bcSource,
    list: _bcList,
    messageTemplate: document.getElementById('bcText').value,
    channelSettings: bcCollectChannelSettings(bcReadField),
    imageUploading: _bcImageBusy,
  };
}

function bcCloseComposer() {
  document.getElementById('bcComposerOv').classList.remove('open');
}

function bcInsertVar(token) {
  const ta = document.getElementById('bcText');
  if (!ta) return;
  const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + token.length;
  ta.focus();
  document.getElementById('bcCharCount').textContent = String(ta.value.length);
}

async function bcSend() {
  if (_bcTransport === 'messengers') return bcSendMessengers();
  const text = document.getElementById('bcText').value.trim();
  if (!text) { notify('Введите текст сообщения', 'err'); return; }

  const filters = bcCollectFilters();
  const previewCount = parseInt(document.getElementById('bcPreviewCount').textContent.replace(/\D/g, ''), 10) || 0;
  if (!previewCount) {
    notify('Нет получателей — уточните фильтры', 'err');
    return;
  }
  if (!confirm(`Отправить сообщение ${previewCount} подписчикам?`)) return;

  const btn = document.getElementById('bcSendBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/broadcasts', { messageTemplate: text, filters });
    notify('Рассылка поставлена в очередь', 'ok');
    bcCloseComposer();
    await bcLoadHistory();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    btn.disabled = false;
  }
}

async function bcSendMessengers() {
  const errs = bcValidateMessengerForm(bcFormState());
  if (errs.length) { notify(errs[0], 'err'); return; }
  const f = _bcLastForecast;
  const n = f ? Math.max(0, (f.total || 0) - (f.skipped || 0)) : null;
  const q = n != null
    ? `Запустить рассылку? Получат сообщение примерно ${n} из ${f.total}.`
    : 'Запустить рассылку? Прогноз ещё не посчитан.';
  if (!confirm(q)) return;
  const btn = document.getElementById('bcSendBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/broadcasts', bcBuildBody());
    notify('Рассылка поставлена в очередь', 'ok');
    bcCloseComposer();
    await bcLoadHistory();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    btn.disabled = false;
  }
}

async function bcLoadHistory() {
  const wrap = document.getElementById('bcHistory');
  if (!wrap) return;
  try {
    const d = await api('GET', '/api/broadcasts?limit=30');
    if (!d.items || !d.items.length) {
      wrap.className = 'empty';
      wrap.innerHTML = 'Пока нет рассылок. Нажмите «+ Новая рассылка», чтобы начать.';
      return;
    }
    wrap.className = '';
    wrap.innerHTML = d.items.map(bcRenderHistoryItem).join('');
  } catch (e) {
    wrap.className = 'empty';
    wrap.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message)}</span>`;
  }
}

function bcRenderHistoryItem(b) {
  const s = BC_STATUS_LBL[b.status] || { lbl: b.status, color: '#9ca3af' };
  const pct = b.total > 0 ? Math.round(((b.sent + b.failed) / b.total) * 100) : 0;
  const created = new Date(b.created_at).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const preview = (b.message_template || '').slice(0, 160) + ((b.message_template || '').length > 160 ? '…' : '');
  const filters = b.filters || {};
  const fParts = [];
  if (filters.phone) fParts.push(`телефон: ${filters.phone}`);
  if (filters.segments && filters.segments.length) fParts.push(`сегменты: ${filters.segments.length}`);
  if (filters.bonusMin != null || filters.bonusMax != null) {
    fParts.push(`бонусы ${filters.bonusMin ?? '0'}–${filters.bonusMax ?? '∞'}`);
  }
  if (filters.lastVisitDays) {
    const lv = filters.lastVisitDays;
    fParts.push(`не был ${lv.gte ?? 0}–${lv.lte ?? '∞'} дн.`);
  }
  if (filters.birthMonth) fParts.push(`ДР: мес ${filters.birthMonth}`);
  if (filters.gender)     fParts.push(`пол: ${filters.gender === 'female' ? 'жен' : 'муж'}`);
  const fLine = fParts.length ? fParts.join(' · ') : 'без фильтров';

  const isMsg = b.transport === 'messengers';
  const canCancel = b.status === 'pending' || b.status === 'in_progress';
  const errLine = (b.errorSamples && b.errorSamples.length)
    ? `<div class="bc-row-errors">Примеры ошибок: ${b.errorSamples.slice(0,3).map(e => esc(e.error || '').slice(0, 60)).join(' / ')}</div>`
    : '';

  return `
    <div class="bc-row" data-id="${b.id}"${isMsg ? ' data-monitor="1" onclick="bcOpenMonitor(' + Number(b.id) + ')" title="Открыть монитор"' : ''}>
      <div class="bc-row-grid">
        <div class="bc-row-left">
          <div class="bc-row-meta">
            <span class="bc-row-chan" title="${isMsg ? 'Мессенджеры клиники' : 'Telegram-бот'}">${isMsg ? '💬' : '🤖'}</span>
            <span class="bc-row-status" style="background:${s.color}22;color:${s.color}">${s.lbl}</span>
            ${esc(b.author_name || '—')} · ${esc(created)}
          </div>
          <div class="bc-row-preview">${esc(preview)}</div>
          <div class="bc-row-filters">${esc(fLine)}</div>
          ${errLine}
        </div>
        <div class="bc-row-right">
          <div class="bc-progress-lbl">Прогресс</div>
          <div class="bc-progress-val">${b.sent.toLocaleString('ru')} / ${b.total.toLocaleString('ru')}
            ${b.failed > 0 ? `<span style="color:var(--danger);font-size:11px">· ${b.failed} ошибок</span>` : ''}
          </div>
          <div class="bc-progress-bar"><i style="width:${pct}%;background:${s.color}"></i></div>
          ${canCancel ? `<button class="btn btn-sec btn-sm" style="margin-top:8px" onclick="event.stopPropagation();bcCancel(${b.id})">Отменить</button>` : ''}
        </div>
      </div>
    </div>`;
}

async function bcCancel(id) {
  if (!confirm('Отменить отправку оставшихся сообщений? Уже отправленные останутся доставленными.')) return;
  try {
    await api('POST', `/api/broadcasts/${id}/cancel`);
    notify('Запрошена отмена', 'ok');
    await bcLoadHistory();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

// Polling статуса активных рассылок — пока на странице есть pending/in_progress,
// обновляем каждые 2.5 сек.
function bcStartPolling() {
  if (_bcPollTimer) clearInterval(_bcPollTimer);
  _bcPollTimer = setInterval(async () => {
    // Опрашиваем только если страница активна
    const page = document.getElementById('page-broadcasts');
    if (!page || !page.classList.contains('active')) return;
    // Проверяем, есть ли активные рассылки в DOM
    const hasActive = Array.from(document.querySelectorAll('.bc-row .bc-row-status')).some(lbl => {
      const txt = (lbl.textContent || '').trim();
      return txt === 'В очереди' || txt === 'Отправляется';
    });
    if (!hasActive) return;
    try { await bcLoadHistory(); } catch (e) { /* мягкая ошибка */ }
  }, 2500);
}
