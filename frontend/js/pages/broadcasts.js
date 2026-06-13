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
  ['bcBonusMin', 'bcBonusMax', 'bcDaysGte', 'bcDaysLte'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('bcBirthMonth').value = '';
  document.getElementById('bcGender').value = '';
  document.getElementById('bcText').value = '';
  document.getElementById('bcCharCount').textContent = '0';
  document.getElementById('bcSendBtn').disabled = false;
  document.getElementById('bcComposerOv').classList.add('open');
  bcUpdatePreview();
  // counter
  const ta = document.getElementById('bcText');
  ta.oninput = () => { document.getElementById('bcCharCount').textContent = String(ta.value.length); };
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

  const canCancel = b.status === 'pending' || b.status === 'in_progress';
  const errLine = (b.errorSamples && b.errorSamples.length)
    ? `<div class="bc-row-errors">Примеры ошибок: ${b.errorSamples.slice(0,3).map(e => esc(e.error || '').slice(0, 60)).join(' / ')}</div>`
    : '';

  return `
    <div class="bc-row" data-id="${b.id}">
      <div class="bc-row-grid">
        <div class="bc-row-left">
          <div class="bc-row-meta">
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
          ${canCancel ? `<button class="btn btn-sec btn-sm" style="margin-top:8px" onclick="bcCancel(${b.id})">Отменить</button>` : ''}
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
