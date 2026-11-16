// ── PAGE-LEVEL STATE ──
// dashRange, rCh, bfCh, lvlCh → js/pages/dashboard.js
// cPage_, cSortCol, cSortDir, bonusTarget → js/pages/clients.js
let lsData = {}, ycSvcs = [];
const LVL_L = {bronze:'🥉 Бронза',silver:'🥈 Серебро',gold:'🥇 Золото',platinum:'💎 Платина'};
const LVL_B = {bronze:'bgr',silver:'bb',gold:'bo',platinum:'bg'};

async function loadCardTypes() {
  const sel = document.getElementById('st-card-type');
  if (!sel) return;
  sel.innerHTML = '<option value="">Загрузка...</option>';
  try {
    const types = await api('GET', '/api/yclients/card-types');
    if (!types?.length) {
      sel.innerHTML = '<option value="">Типы карт не найдены</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Выберите карту —</option>';
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.title} (ID: ${t.id})`;
      sel.appendChild(opt);
    });
    notify(`Загружено ${types.length} типов карт`, 'ok');
  } catch(e) { notify('Ошибка загрузки карт: '+e.message, 'err'); }
}

function onCardTypeChange(sel) {
  const info = document.getElementById('cardTypeInfo');
  if (!info) return;
  if (sel.value) {
    const name = sel.options[sel.selectedIndex]?.textContent || '';
    info.style.display = 'block';
    info.textContent = `Выбрана: ${name}. Нажмите «Сохранить».`;
    info.style.color = 'var(--a)';
  } else {
    info.style.display = 'none';
  }
}

// syncClientCard → js/pages/clients.js

// ── BULK IMPORT ──────────────────────────────────────────────
let bulkPollInterval = null;

async function startBulkImport() {
  const btn = document.getElementById('bulkImportBtn');
  const statusEl = document.getElementById('bulkImportStatus');
  const resultEl = document.getElementById('bulkImportResult');

  // Сброс UI
  resultEl.style.display = 'none';
  statusEl.style.display = 'block';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Импорт идёт...';
  document.getElementById('bulkSpinner').style.display = 'inline-block';
  document.getElementById('bulkStatusText').textContent = 'Запуск...';

  try {
    await api('POST', '/api/bulk-import-card-history');
    notify('Импорт запущен! Прогресс отображается ниже.', 'ok');
    // Начать polling статуса каждые 2 сек
    bulkPollInterval = setInterval(pollBulkStatus, 2000);
    pollBulkStatus();
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '📥 Запустить импорт истории';
    statusEl.style.display = 'none';
    notify('Ошибка: ' + e.message, 'err');
  }
}

async function pollBulkStatus() {
  try {
    const s = await api('GET', '/api/bulk-import-card-history/status');
    const statusEl  = document.getElementById('bulkImportStatus');
    const resultEl  = document.getElementById('bulkImportResult');
    const btn       = document.getElementById('bulkImportBtn');

    if (s.notStarted) return;

    // Обновить прогресс
    document.getElementById('bulkDone').textContent     = s.done || 0;
    document.getElementById('bulkTotal').textContent    = s.total || 0;
    document.getElementById('bulkImported').textContent = s.imported || 0;
    document.getElementById('bulkErrors').textContent   = s.errors || 0;
    document.getElementById('bulkCurrent').textContent  = s.currentClient || '—';

    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    document.getElementById('bulkProgress').style.width = pct + '%';
    document.getElementById('bulkStatusText').textContent =
      s.running ? `Обрабатывается ${s.done} из ${s.total} клиентов...` : 'Завершено!';

    if (!s.running) {
      clearInterval(bulkPollInterval);
      bulkPollInterval = null;

      // Скрыть спиннер
      document.getElementById('bulkSpinner').style.display = 'none';
      btn.disabled = false;
      btn.innerHTML = '✅ Импорт завершён (повторить)';

      // Показать итог
      resultEl.style.display = 'block';
      if (s.error) {
        resultEl.style.background = '#fef2f2';
        resultEl.style.color = 'var(--danger)';
        resultEl.innerHTML = `❌ Ошибка: ${s.error}`;
      } else {
        resultEl.style.background = '#f0fdf4';
        resultEl.style.color = '#166534';
        resultEl.innerHTML = `
          ✅ <strong>Импорт завершён!</strong><br>
          Клиентов обработано: <strong>${s.done}</strong> ·
          Транзакций загружено: <strong>${s.imported}</strong> ·
          Ошибок: <strong>${s.errors}</strong>
        `;
      }
      notify(`Импорт завершён! Загружено ${s.imported} транзакций`, 'ok');
    }
  } catch(e) {
    console.error('Poll error:', e.message);
  }
}

async function saveWebCookie() {
  const val = document.getElementById('st-web-cookie')?.value?.trim();
  const el  = document.getElementById('cookieSt');
  if (!val) { el.innerHTML='<span style="color:var(--danger)">Вставьте куки</span>'; return; }
  el.innerHTML = '<span class="spinner"></span> Сохранение...';
  try {
    await api('PUT', '/api/salon', {
      name:                document.getElementById('st-name')?.value,
      city:                document.getElementById('st-city')?.value,
      timezone:            document.getElementById('st-tz')?.value,
      yclients_company_id: document.getElementById('st-yid')?.value,
      yclients_web_cookie: val,
    });
    el.innerHTML = '<span style="color:var(--a)">✓ Куки сохранены! Теперь запустите импорт истории.</span>';
    notify('Куки YClients сохранены!', 'ok');
  } catch(e) {
    el.innerHTML = `<span style="color:var(--danger)">Ошибка: ${e.message}</span>`;
  }
}

async function startXlsImport() {
  const fileInput = document.getElementById('xlsFile');
  const btn       = document.getElementById('xlsImportBtn');
  const progress  = document.getElementById('xlsImportProgress');
  const result    = document.getElementById('xlsImportResult');

  if (!fileInput.files.length) { notify('Выберите XLS файл', 'err'); return; }

  const file = fileInput.files[0];
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Обработка...';
  progress.textContent = `Загружаем ${file.name}...`;
  result.style.display = 'none';

  try {
    // Читаем файл как бинарные данные и отправляем напрямую
    const arrayBuffer = await file.arrayBuffer();

    const resp = await fetch('/api/import/csv-transactions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + localStorage.getItem('lp_tk'),
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
      body: arrayBuffer,
    });
    const data = await resp.json();

    if (data.ok) {
      result.style.display = 'block';
      result.style.background = '#f0fdf4';
      result.style.color = '#166534';
      result.innerHTML = `
        ✅ <strong>Файл импортирован!</strong><br>
        Строк в файле: <strong>${data.totalRows}</strong> ·
        Загружено: <strong>${data.imported}</strong> ·
        Пропущено (дубли/не найден клиент): <strong>${data.skipped}</strong> ·
        Ошибок: <strong>${data.errors}</strong>
      `;
      notify(`Импортировано ${data.imported} транзакций из ${file.name}`, 'ok');
      fileInput.value = '';
    } else {
      throw new Error(data.error || 'Ошибка импорта');
    }
  } catch(e) {
    result.style.display = 'block';
    result.style.background = '#fef2f2';
    result.style.color = 'var(--danger)';
    result.innerHTML = `❌ Ошибка: ${e.message}`;
    notify('Ошибка импорта: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📊 Импортировать CSV';
    progress.textContent = '';
  }
}

// doLogout, launchApp, showLogin, navStg → js/core/nav.js + js/core/auth.js

// setPeriod, buildRevChart, buildRecentTx, buildTopSvc → js/pages/dashboard.js

// cPage…quickB, openCD, doSyncCard, loadCardTxns → js/pages/clients.js

// loadSegments…segExport → js/pages/segments.js
// loadRecords, renderRecordsPager, setDefDates, formatVisitDate → js/pages/records.js
// loadLs…previewTemplateSettings → js/pages/settings.js

// ── SETTINGS ──
async function loadSettings() {
  try {
    const salon=await api('GET','/api/salon');
    const s=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v||'';};
    s('st-name',salon.name); s('st-city',salon.city); s('st-yid',salon.yclients_company_id);
    s('st-pt','');
    const tz=document.getElementById('st-tz'); if(tz)tz.value=salon.timezone||'Europe/Moscow';
    const wh=`${window.location.origin}/api/webhook/yclients/${salon.yclients_company_id||'YOUR_ID'}`;
    const we=document.getElementById('whUrl'); if(we)we.value=wh;
    // Показать сохранённую карту лояльности
    if (salon.yclients_card_type_id) {
      const sel = document.getElementById('st-card-type');
      if (sel) {
        const exists = Array.from(sel.options).some(o=>String(o.value)===String(salon.yclients_card_type_id));
        if (!exists) {
          const opt=document.createElement('option');
          opt.value=salon.yclients_card_type_id;
          opt.textContent=salon.yclients_card_type_name||`Карта ID ${salon.yclients_card_type_id}`;
          opt.selected=true;
          sel.appendChild(opt);
        } else { sel.value=String(salon.yclients_card_type_id); }
        const info=document.getElementById('cardTypeInfo');
        if(info){info.style.display='block';info.style.color='var(--a)';
          info.textContent=`✓ Активна: ${salon.yclients_card_type_name||salon.yclients_card_type_id}`;}
      }
    }
    const ci = document.getElementById('st-chain-id');
    if (ci) ci.value = salon.yclients_chain_id || '';
    renderSalonLogo(salon.logo_url);
    // Показать статус куки
    const cookieSt = document.getElementById('cookieSt');
    if (cookieSt && salon.yclients_web_session_configured) {
      cookieSt.textContent = '✓ Куки сохранены';
    }
    loadLs();
    loadSyncLogs();
    loadTemplateSettings();
  } catch(e){notify(e.message,'err');}
}
async function saveSalon() {
  try {
    const sel = document.getElementById('st-card-type');
    const selOpt = sel?.options[sel.selectedIndex];
    await api('PUT','/api/salon',{
      name:                 document.getElementById('st-name')?.value,
      city:                 document.getElementById('st-city')?.value,
      timezone:             document.getElementById('st-tz')?.value,
      yclients_company_id:  document.getElementById('st-yid')?.value,
      yclients_card_type_id:   sel?.value ? parseInt(sel.value) : null,
      yclients_card_type_name: selOpt?.value ? (selOpt.textContent || null) : null,
    });
    notify('Сохранено!','ok');
  } catch(e){notify(e.message,'err');}
}
async function connectYC() {
  const el=document.getElementById('ycSt');

  // Валидация полей
  const pt = document.getElementById('st-pt')?.value?.trim();
  const login = document.getElementById('st-login')?.value?.trim();
  const pass = document.getElementById('st-pass')?.value?.trim();
  const yid = document.getElementById('st-yid')?.value?.trim();

  if (!pt || !login || !pass || !yid) {
    el.innerHTML='<span style="color:var(--danger)">❌ Заполните все поля: ID компании, Partner Token, Email, Пароль</span>';
    return;
  }

  el.innerHTML='<span class="spinner"></span> Подключение к YClients (может занять до 10 сек)...';
  try {
    console.log('📡 Отправка данных на сервер...');
    const res = await api('POST','/api/salon/yclients-auth',{
      partnerToken: pt,
      login: login,
      password: pass,
      yclients_company_id: yid,
      chainId: document.getElementById('st-chain-id')?.value || null,
    });

    el.innerHTML=`
      <div style="background:#ecfdf5;border:1px solid #86efac;border-radius:6px;padding:12px;color:#15803d">
        <div style="font-weight:600;margin-bottom:6px">✅ YClients успешно подключен!</div>
        <div style="font-size:12px;line-height:1.5">
          • Partner Token: сохранён<br>
          • User Token: получен и сохранён<br>
          • Теперь вы можете запустить синхронизацию
        </div>
      </div>
    `;
    notify('YClients подключён!','ok');

    // Автоматически загрузить типы карт
    setTimeout(() => { loadCardTypes(); }, 500);
  } catch(e){
    let errorMsg = e.message;
    let helpText = '';

    // Подробная справка для разных ошибок
    if (errorMsg.includes('Неверный логин или пароль')) {
      helpText = '<br><strong>Совет:</strong> Проверьте email и пароль вашего профиля YClients';
    } else if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
      helpText = '<br><strong>Совет:</strong> Partner Token неверный или истёк. Обновите его в YClients → Настройки → API';
    } else if (errorMsg.includes('404')) {
      helpText = '<br><strong>Совет:</strong> ID компании неверный. Проверьте в URL: yclients.com/cabinet/**ID**/...';
    } else if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      helpText = '<br><strong>Совет:</strong> Сервер YClients не отвечает. Попробуйте ещё раз через минуту.';
    }

    el.innerHTML=`
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px;color:#991b1b">
        <div style="font-weight:600;margin-bottom:6px">❌ Ошибка подключения</div>
        <div style="font-size:12px;line-height:1.5;margin-bottom:8px">
          ${esc(errorMsg)}${helpText}
        </div>
        <div style="font-size:11px;color:#7f1d1d;margin-top:8px">
          Если проблема не решена, используйте скрипт восстановления (см. RECOVERY_GUIDE.md)
        </div>
      </div>
    `;
  }
}
function copyWh() { const v=document.getElementById('whUrl')?.value; navigator.clipboard.writeText(v).then(()=>notify('Скопировано!','ok')); }
async function loadSyncLogs() {
  try {
    const logs=await api('GET','/api/sync/logs');
    const el=document.getElementById('syncLogs'); if(!el)return;
    if(!logs?.length){el.innerHTML='<div class="empty">Нет логов</div>';return;}
    const si={success:'✅',error:'❌',running:'⏳'};
    el.innerHTML=`<table><thead><tr><th>Тип</th><th>Статус</th><th>Клиентов</th><th>Записей</th><th>Бонусов</th><th>Время</th></tr></thead><tbody>
      ${logs.map(l=>`<tr><td>${l.sync_type}</td><td>${si[l.status]||'?'} ${l.status}</td><td>${l.clients_synced||0}</td><td>${l.records_synced||0}</td><td style="color:var(--a)">${l.bonuses_accrued||0}</td><td style="color:var(--t3);font-size:12px">${new Date(l.started_at).toLocaleString('ru')}</td></tr>`).join('')}
    </tbody></table>`;
  } catch{}
}

// ── SYNC ──
async function triggerSync() {
  const banner=document.getElementById('syncBanner');
  if(banner){banner.style.display='flex';document.getElementById('syncBannerText').textContent='Синхронизация запущена...';}
  try {
    await api('POST','/api/sync');
    notify('Синхронизация запущена! Данные обновятся через несколько минут.','ok');
    setTimeout(()=>{loadDashboard();if(banner)banner.style.display='none';},6000);
  } catch(e){notify(e.message,'err');if(banner)banner.style.display='none';}
}

// searchBonusC, selBC → js/pages/clients.js

// ── UTILS ──
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
// notify, showLbar → js/core/utils.js
function avc(n=''){const c=['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#ef4444','#84cc16'];return c[(n||'').charCodeAt(0)%c.length];}
function avi(n='?'){return(n||'?').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase();}
function timeSince(d){const s=Math.floor((Date.now()-new Date(d))/1000);if(s<60)return s+'с';if(s<3600)return Math.floor(s/60)+'м';if(s<86400)return Math.floor(s/3600)+'ч';return Math.floor(s/86400)+'д';}
const _dbc={};
function dbc(fn,ms){return function(...a){clearTimeout(_dbc[fn]);_dbc[fn]=setTimeout(()=>fn(...a),ms);};}

// loadStaffAnalytics…saExportPDF → js/pages/staff.js

// loadHomeCare…hcOpenPrintWindow → js/pages/home-care.js

// loadUsers, renderUsers, usersShowModal, etc. → js/pages/users.js

// ══════════════════════════════════════════════════════════════
// ── VISUAL ENHANCEMENTS ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// initDarkMode, toggleDarkMode, updateDmLabel → js/core/theme.js
// animateCount, cascadeCards → js/core/utils.js

// buildLvlDash, showDashSkeleton → js/pages/dashboard.js

// nav → js/core/nav.js

// ── Confetti ──────────────────────────────────────────────────
function fireConfetti() {
  if (typeof confetti !== 'function') return;
  confetti({
    particleCount: 90,
    spread: 75,
    origin: { y: 0.55 },
    colors: ['#00c896','#0080ff','#f59e0b','#ec4899','#8b5cf6'],
    startVelocity: 30,
    gravity: 0.9,
    ticks: 200,
    scalar: 0.9,
  });
}

// ── 3D Hover on stat cards ────────────────────────────────────
(function setup3DHover(){
  let currentCard = null;

  function attachTilt(card) {
    if (card._tiltBound) return;
    card._tiltBound = true;

    card.addEventListener('mousemove', function(e) {
      const r = card.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width  - 0.5) * 14;
      const y = ((e.clientY - r.top)  / r.height - 0.5) * 14;
      card.style.transition = 'transform .08s ease, box-shadow .15s';
      card.style.transform = `perspective(600px) rotateY(${x}deg) rotateX(${-y}deg) translateY(-4px) scale(1.02)`;
      card.style.boxShadow = '0 12px 32px rgba(0,0,0,.14)';
    });

    card.addEventListener('mouseleave', function() {
      card.style.transition = 'transform .35s cubic-bezier(.22,.68,0,1.2), box-shadow .25s';
      card.style.transform = '';
      card.style.boxShadow = '';
    });
  }

  // Attach to all current .sc cards and observe new ones
  function attachAll() {
    document.querySelectorAll('.sc').forEach(attachTilt);
  }

  attachAll();

  // Re-attach when dashboard re-renders cards
  const obs = new MutationObserver(attachAll);
  obs.observe(document.body, { childList: true, subtree: true });
})();

// ── Sync button pulse ─────────────────────────────────────────
// Patching showLbar via original reference at init time
(function patchShowLbar(){
  const orig = showLbar;
  window.showLbar = function(on){
    document.getElementById('lbar').style.display = on ? 'block' : 'none';
    const btn = document.getElementById('syncBtn');
    if (btn) btn.classList.toggle('sync-active', !!on);
  };
})();

// loadDashboard → js/pages/dashboard.js

// submitBonus → js/pages/clients.js
