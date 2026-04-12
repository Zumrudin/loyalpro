// ── RECORDS PAGE ───────────────────────────────────────────────
// Зависимости: api(), notify()

let recordsPage = 1;
const RECORDS_PER_PAGE = 50;

function setDefDates() {
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  document.getElementById('rFrom').value = fmt(new Date(Date.now() - 30 * 864e5));
  document.getElementById('rTo').value   = fmt(new Date());
}

function formatVisitDate(raw) {
  if (!raw) return '—';
  const s = String(raw);
  let ymd = s;
  if (s.includes('T')) ymd = s.split('T')[0];
  const parts = ymd.split('-');
  if (parts.length !== 3) return s;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

async function loadRecords(page) {
  if (page !== undefined) recordsPage = page;
  try {
    const q = new URLSearchParams({
      dateFrom: document.getElementById('rFrom')?.value || '',
      dateTo:   document.getElementById('rTo')?.value   || '',
      status:   document.getElementById('rStat')?.value || '',
      page:     recordsPage,
      limit:    RECORDS_PER_PAGE
    });
    const d = await api('GET', '/api/records?' + q);
    const SL = {
      completed:'Оказана', arrived:'Пришёл', confirmed:'Подтверждена',
      waiting:'Ожидание', pending:'Ожидание', cancelled:'Отменена',
      no_show:'Не пришёл', deleted:'Удалена'
    };
    const SStyle = {
      completed: 'background:rgba(0,200,150,.15);color:#007a5a',
      arrived:   'background:rgba(245,158,11,.15);color:#b45309',
      confirmed: 'background:rgba(59,130,246,.12);color:#1d4ed8',
      waiting:   'background:rgba(59,130,246,.12);color:#1d4ed8',
      pending:   'background:rgba(59,130,246,.12);color:#1d4ed8',
      cancelled: 'background:rgba(232,84,84,.12);color:#c53030',
      no_show:   'background:rgba(232,84,84,.12);color:#c53030',
      deleted:   'background:rgba(232,84,84,.12);color:#c53030',
    };
    const tb = document.getElementById('rBody');
    if (!d.records?.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">Записей нет</td></tr>'; renderRecordsPager(d); return; }
    tb.innerHTML = d.records.map(r => {
      let services = r.services;
      if (typeof services === 'string') try { services = JSON.parse(services); } catch { services = []; }
      const svc = Array.isArray(services) ? services.map(s => s.title || s.name || s).filter(Boolean).join(', ') || '—' : '—';
      let staff = r.staff;
      if (typeof staff === 'string') try { staff = JSON.parse(staff); } catch { staff = []; }
      const st = Array.isArray(staff) ? staff.map(s => s.name || s).filter(Boolean).join(', ') || '—' : (staff?.name || '—');

      const amt      = parseFloat(r.real_amount || r.amount || 0);
      const accrued  = parseFloat(r.bonus_accrued || r.real_bonus_accrued || 0);
      const redeemed = parseFloat(r.bonus_redeemed || r.real_bonus_redeemed || 0);
      const status   = r.yclients_status || r.status || 'pending';

      let timeStr = '';
      if (r.visit_datetime) {
        const dt = new Date(r.visit_datetime);
        if (!isNaN(dt)) timeStr = dt.toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow'});
      }

      let displayStatus = status;
      if (status === 'arrived' && r.is_paid_full) displayStatus = 'completed';
      const badgeStyle = SStyle[displayStatus] || SStyle['pending'];
      const paidMark = r.is_paid_full
        ? `<span title="Оплачен" style="color:#00c896;margin-left:5px;font-size:14px">✓</span>`
        : '';

      return `<tr>
        <td style="color:var(--t2);white-space:nowrap">
          ${formatVisitDate(r.visit_date_msk || r.visit_date)}
          ${timeStr ? `<br><span style="font-size:11px;color:var(--t3)">${timeStr}</span>` : ''}
        </td>
        <td><strong>${esc(r.client_name || '—')}</strong><br><span style="font-size:11px;color:var(--t3)">${esc(r.client_phone || '')}</span></td>
        <td style="color:var(--t2);font-size:12px">${esc(svc)}</td>
        <td style="color:var(--t2);font-size:12px">${esc(st)}</td>
        <td style="font-weight:600;text-align:right">${amt > 0 ? amt.toLocaleString('ru') + ' ₽' : '—'}</td>
        <td style="color:var(--a);font-weight:600;text-align:right">${accrued > 0 ? '+' + accrued.toLocaleString('ru') : '—'}</td>
        <td style="color:var(--danger);font-weight:600;text-align:right">${redeemed > 0 ? '-' + redeemed.toLocaleString('ru') : '—'}</td>
        <td style="white-space:nowrap"><span class="badge" style="${badgeStyle}">${esc(SL[displayStatus] || SL[status] || status)}</span>${paidMark}</td>
        <td><span class="badge bgr" style="font-size:10px">${esc({sync:'Синхр.',webhook:'Hook'}[r.source] || r.source || '—')}</span></td>
      </tr>`;
    }).join('');
    renderRecordsPager(d);
  } catch(e) { notify(e.message, 'err'); }
}

function renderRecordsPager(d) {
  const el = document.getElementById('rPager');
  const total = d.total || 0;
  const totalPages = d.totalPages || 1;
  const curPage = d.page || recordsPage;
  if (total === 0) { el.innerHTML = ''; return; }
  let html = `<span>Записей: ${total}</span>`;
  if (totalPages > 1) {
    html += ` &nbsp;|&nbsp; Стр. ${curPage} из ${totalPages} &nbsp;`;
    html += `<button class="btn btn-sec" style="padding:2px 10px;font-size:12px;margin:0 3px" ${curPage <= 1 ? 'disabled' : ''} onclick="loadRecords(${curPage - 1})">←</button>`;
    let start = Math.max(1, curPage - 3);
    let end   = Math.min(totalPages, start + 6);
    start = Math.max(1, end - 6);
    for (let p = start; p <= end; p++) {
      if (p === curPage) html += `<button class="btn" style="padding:2px 10px;font-size:12px;margin:0 2px">${p}</button>`;
      else html += `<button class="btn btn-sec" style="padding:2px 10px;font-size:12px;margin:0 2px" onclick="loadRecords(${p})">${p}</button>`;
    }
    html += `<button class="btn btn-sec" style="padding:2px 10px;font-size:12px;margin:0 3px" ${curPage >= totalPages ? 'disabled' : ''} onclick="loadRecords(${curPage + 1})">→</button>`;
  }
  el.innerHTML = html;
}
