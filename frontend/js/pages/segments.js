// ── SEGMENTS PAGE ──────────────────────────────────────────────
// Зависимости: api(), notify(), esc()

const ZONE_ORDER = ['waiting','post_visit','active','risk','sleeping','no_visit','blacklist'];
const ZONE_LABELS = {
  waiting:    'Зона ожидания — запись на будущее',
  post_visit: 'Сразу после визита',
  active:     'Горячие клиенты — активная база',
  risk:       'Зона риска — начинают остывать',
  sleeping:   'Спящие клиенты',
  no_visit:   'Без визитов',
  blacklist:  'Чёрный список',
};
const SEG_HINTS = {
  blacklist:          'Клиенты, помеченные как нежелательные. Исключены из всех акций.',
  waiting_champion:   '5+ визитов. Записался на будущий визит. Ваши лучшие клиенты — в ожидании.',
  waiting_growing:    '3–4 визита. Есть предстоящая запись. Формирует постоянную привычку.',
  waiting_newcomer:   '1–2 визита. Записался снова — хороший знак для удержания.',
  post_visit:         'Был в салоне в последние 7 дней. Самый горячий момент для обратной связи.',
  champion:           '5+ визитов. Пришёл в пределах окна возврата. Ядро клиентской базы.',
  growing:            '3–4 визита. Активен в пределах окна возврата. Формирует привычку.',
  newcomer:           '1–2 визита. Новый, но вернулся в срок. Важно удержать на этом этапе.',
  champion_risk:      '5+ визитов, но прошло больше окна возврата. Риск потерять чемпиона.',
  growing_risk:       '3–4 визита. Давно не был — есть риск уйти до того, как стал постоянным.',
  newcomer_risk:      '1–2 визита. Попробовал, но затянул. Нужен стимул вернуться.',
  sleeping_champion:  '5+ визитов, но прошло более 2.5× окна. Когда-то был лучшим — стоит реактивировать.',
  sleeping_growing:   '3–4 визита. Давно не появлялся. Ещё помнит салон — можно вернуть.',
  sleeping_newcomer:  '1–2 визита. Попробовал и пропал. Самая большая группа потерь.',
  no_visit:           'Зарегистрирован, но ни разу не пришёл. Потенциальные клиенты.',
};

let _segData = null;
let segDrawerKey = null, segDrawerPage = 1, segDrawerQ = '';
let _segYcCompanyId = null;

async function loadSegments() {
  document.getElementById('segBody').innerHTML = '<div class="empty">Загрузка сегментов...</div>';
  try {
    const d = await api('GET', '/api/segments');
    _segData = d;
    _segYcCompanyId = d.totals?.yclients_company_id || null;
    renderSegments(d);
  } catch(e) {
    document.getElementById('segBody').innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

function renderSegments(d) {
  document.getElementById('segTotalAll').textContent     = d.totals.all_clients.toLocaleString('ru');
  document.getElementById('segTotalVisits').textContent  = d.totals.with_visits.toLocaleString('ru');
  document.getElementById('segTotalRevenue').textContent = d.totals.total_revenue.toLocaleString('ru') + ' ₽';
  document.getElementById('segReturnWindow').textContent = d.totals.return_window;
  if (d.totals.last_updated) {
    const dt = new Date(d.totals.last_updated);
    document.getElementById('segMeta').textContent = 'Обновлено: ' + dt.toLocaleString('ru', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  }

  const byZone = {};
  for (const s of d.segments) {
    if (!byZone[s.zone]) byZone[s.zone] = [];
    byZone[s.zone].push(s);
  }

  let html = '';
  for (const zone of ZONE_ORDER) {
    const segs = byZone[zone];
    if (!segs) continue;
    const hasAny = segs.some(s => s.client_count > 0);
    if (!hasAny && !['active','risk','sleeping'].includes(zone)) continue;

    html += `<div class="seg-zone-label">${ZONE_LABELS[zone] || zone}</div>`;
    html += '<div class="seg-grid">';
    for (const s of segs) {
      const empty = s.client_count === 0;
      const hint = SEG_HINTS[s.key] || '';
      html += `
        <div class="seg-card ${empty ? 'seg-empty-card' : ''}"
             style="--seg-color:${s.color};border-color:${empty ? 'var(--bd)' : s.color + '44'}"
             onclick="${empty ? '' : `segOpenDrawer('${s.key}')`}">
          <div class="seg-card-bar" style="background:${s.color}"></div>
          ${hint ? `<div class="seg-tooltip">${esc(hint)}</div>` : ''}
          <div class="seg-card-top">
            <span class="seg-card-emoji">${s.emoji}</span>
            ${s.client_count > 0 ? `<span class="seg-card-pct">${s.pct}%</span>` : ''}
          </div>
          <div class="seg-card-label">${esc(s.label)}</div>
          <div class="seg-card-count">${s.client_count.toLocaleString('ru')}</div>
          ${s.client_count > 0 ? `
          <div class="seg-card-stats">
            ${s.avg_check > 0 ? `<div class="seg-card-stat">Ср. чек <b>${s.avg_check.toLocaleString('ru')} ₽</b></div>` : ''}
            ${s.avg_visits > 0 ? `<div class="seg-card-stat">Визитов <b>${s.avg_visits}</b></div>` : ''}
          </div>` : '<div style="font-size:11px;color:var(--t3)">нет клиентов</div>'}
        </div>`;
    }
    html += '</div>';
  }

  document.getElementById('segBody').innerHTML = html || '<div class="empty">Нет данных</div>';
}

async function refreshSegments() {
  document.getElementById('segMeta').textContent = 'Обновление...';
  try {
    await api('POST', '/api/segments/refresh');
    await loadSegments();
  } catch(e) { alert('Ошибка: ' + e.message); }
}

// ── Segment drawer ─────────────────────────────────────────────
function segOpenDrawer(key) {
  segDrawerKey = key;
  segDrawerPage = 1;
  segDrawerQ = '';
  document.getElementById('segDrawerSearchInp').value = '';
  const seg = _segData?.segments?.find(s => s.key === key);
  document.getElementById('segDrawerEmoji').textContent = seg?.emoji || '';
  document.getElementById('segDrawerTitle').textContent = (seg?.label || key) + ' · ' + (seg?.client_count || 0).toLocaleString('ru');
  document.getElementById('segDrawerOv').classList.add('open');
  loadSegDrawer();
}

function segDrawerClose() {
  document.getElementById('segDrawerOv').classList.remove('open');
  segDrawerKey = null;
}

function segDrawerSearch(q) {
  segDrawerQ = q;
  segDrawerPage = 1;
  loadSegDrawer();
}

async function loadSegDrawer() {
  if (!segDrawerKey) return;
  document.getElementById('segDrawerList').innerHTML = '<div class="empty">Загрузка...</div>';
  try {
    const d = await api('GET', `/api/segments/${segDrawerKey}/clients?page=${segDrawerPage}&limit=30&search=${encodeURIComponent(segDrawerQ)}`);
    const el = document.getElementById('segDrawerList');
    if (!d.clients.length) { el.innerHTML = '<div class="empty">Нет клиентов</div>'; return; }

    el.innerHTML = d.clients.map(c => {
      const initials = (c.name || '?').split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
      const daysAgo = c.days_since_visit != null ? `${Math.round(c.days_since_visit)} дн. назад` : '—';
      const ycUrl = (_segYcCompanyId && c.phone)
        ? `https://yclients.com/clients/${_segYcCompanyId}/base/?fields%5B0%5D=name&fields%5B1%5D=phone&fields%5B2%5D=visits_count&fields%5B3%5D=sold_amount&fields%5B4%5D=last_visit_date&order_by=id&order_by_direction=desc&page=1&page_size=25&filters%5B0%5D%5Boperation%5D=OR&filters%5B0%5D%5Bfilters%5D%5B0%5D%5Boperation%5D=AND&filters%5B0%5D%5Bfilters%5D%5B0%5D%5Bfilters%5D%5B0%5D%5Boperation%5D=AND&filters%5B1%5D%5Btype%5D=quick_search&filters%5B1%5D%5Bstate%5D%5Bvalue%5D=${encodeURIComponent(c.phone)}`
        : null;
      return `
        <div class="seg-client-row">
          <div class="seg-client-avatar" style="background:var(--a);cursor:default">${esc(initials)}</div>
          <div style="flex:1;min-width:0">
            <div class="seg-client-name">${esc(c.name || '—')}</div>
            <div class="seg-client-phone">${esc(c.phone || '')} · ${daysAgo}</div>
          </div>
          <div class="seg-client-info" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <div class="seg-client-spent">${Math.round(parseFloat(c.total_spent || 0)).toLocaleString('ru')} ₽</div>
            <div class="seg-client-visits">${c.visits_count} визит.</div>
            ${ycUrl ? `<a href="${ycUrl}" target="_blank" rel="noopener"
              onclick="event.stopPropagation()"
              style="font-size:10px;color:var(--a);text-decoration:none;white-space:nowrap" title="Открыть в YClients">↗ YClients</a>` : ''}
          </div>
        </div>`;
    }).join('');

    const total = d.total, pages = Math.ceil(total / 30);
    const pg = document.getElementById('segDrawerPager');
    if (pages > 1) {
      pg.innerHTML = `
        <span style="font-size:12px;color:var(--t3)">${d.page} / ${pages} стр. · ${total} клиентов</span><br>
        ${d.page > 1 ? `<button class="btn btn-sec btn-sm" style="margin:4px" onclick="segDrawerGo(${d.page - 1})">← Назад</button>` : ''}
        ${d.page < pages ? `<button class="btn btn-sec btn-sm" style="margin:4px" onclick="segDrawerGo(${d.page + 1})">Вперёд →</button>` : ''}`;
    } else {
      pg.innerHTML = `<span style="font-size:12px;color:var(--t3)">${total} клиентов</span>`;
    }
  } catch(e) {
    document.getElementById('segDrawerList').innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

function segDrawerGo(p) { segDrawerPage = p; loadSegDrawer(); }

function segExport() {
  if (!segDrawerKey) return;
  const search = segDrawerQ ? `&search=${encodeURIComponent(segDrawerQ)}` : '';
  const tok = localStorage.getItem('lp_tk');
  const url = `/api/segments/${segDrawerKey}/export?token=${encodeURIComponent(tok)}${search}`;
  const a = document.createElement('a');
  a.href = url; a.download = ''; a.click();
}
