// Чистые помощники страницы «💰 Экономика» (без document). Тест — economics-table.test.js
// в одном vm-контексте с economics.js: верхнеуровневый const с именем чужой функции
// гасит ВЕСЬ файл (готча проекта, 12.08.2026). Все имена — с префиксом eco/ECO_.

function ecoNum(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = Math.abs(n).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/[\u00a0\u202f]/g, ' ');
  return (n < 0 ? '−' : '') + s;
}
function ecoMoney(v) { return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : ecoNum(Math.round(Number(v))) + ' ₽'; }
function ecoPct(v) { return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : ecoNum(Number(v) * 100, 1) + '%'; }

function ecoSort(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'ru') * sign;
  });
}

const ECO_SUM_KEYS = ['visits', 'revenue', 'discount', 'bonus_redeemed', 'materials_used', 'materials_norm', 'doctor_cost', 'acquiring_cost',
  'contribution', 'overhead', 'equipment_cost', 'operating_profit', 'usn_estimate', 'hours', 'materials_estimated_rows'];
function ecoTotals(groups) {
  const t = {};
  for (const k of ECO_SUM_KEYS) t[k] = groups.reduce((a, g) => a + (Number(g[k]) || 0), 0);
  t.contribution_pct = t.revenue > 0 ? t.contribution / t.revenue : null;
  t.operating_pct = t.revenue > 0 ? t.operating_profit / t.revenue : null;
  t.profit_per_hour = t.hours > 0 ? t.contribution / t.hours : null;
  return t;
}

// Колонки вкладки «Услуги»: key — поле группы, fmt — money|pct|num|hours, title — заголовок.
const ECO_SERVICE_COLS = [
  { key: 'label', title: 'Услуга', fmt: 'text' },
  { key: 'visits', title: 'Визитов', fmt: 'num' },
  { key: 'revenue', title: 'Выручка', fmt: 'money' },
  { key: 'materials_used', title: 'Материалы', fmt: 'money', flag: 'estimated' },
  { key: 'doctor_cost', title: 'Врач', fmt: 'money' },
  { key: 'acquiring_cost', title: 'Эквайринг', fmt: 'money' },
  { key: 'contribution', title: 'Марж. прибыль', fmt: 'money', strong: true },
  { key: 'contribution_pct', title: '%', fmt: 'pct' },
  { key: 'overhead', title: 'Постоянные', fmt: 'money' },
  { key: 'equipment_cost', title: 'Аппарат', fmt: 'money' },
  { key: 'operating_profit', title: 'Прибыль', fmt: 'money', strong: true },
  { key: 'operating_pct', title: '%', fmt: 'pct' },
  { key: 'profit_per_hour', title: '₽/час', fmt: 'money' },
];
function ecoFmt(v, fmt) {
  if (fmt === 'money') return ecoMoney(v);
  if (fmt === 'pct') return ecoPct(v);
  if (fmt === 'num') return ecoNum(v);
  if (fmt === 'hours') return ecoNum(v, 1);
  return v === null || v === undefined ? '' : String(v);
}

/** Бейджи покрытия у строки услуги. */
function ecoFlags(g) {
  const c = g.coverage || {};
  const out = [];
  if (g.materials_estimated_rows > 0) out.push({ key: 'estimated', text: `оценка ${g.materials_estimated_rows}`, title: 'Материалы по норме техкарты, списаний нет', cls: 'eco-badge-warn' });
  if (c.rows && !c.with_tech_card) out.push({ key: 'no_tech_card', text: 'нет техкарты', title: 'Ни одна привязка к техкарте не найдена', cls: 'eco-badge-muted' });
  if (c.no_pay_rule > 0) out.push({ key: 'no_pay_rule', text: `нет правила ${c.no_pay_rule}`, title: 'Строки без правила оплаты врача — оплата 0', cls: 'eco-badge-err' });
  if (c.no_price_goods && c.no_price_goods.length) out.push({ key: 'no_price', text: `товары без цены ${c.no_price_goods.length}`, title: 'Нет ни прихода, ни ручной цены, ни себестоимости YClients', cls: 'eco-badge-err' });
  if (c.rows && c.acquiring_estimated === c.rows) out.push({ key: 'acq_est', text: 'эквайринг оценка', title: 'Нет привязанных оплат — средняя доля периода', cls: 'eco-badge-muted' });
  return out;
}

/** Период по пресету от московской даты today ('YYYY-MM-DD'). */
function ecoPeriodPreset(preset, today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'prev-month') { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` }; }
  if (preset === 'quarter') { const qm = Math.floor((m - 1) / 3) * 3 + 1; return { from: `${y}-${pad(qm)}-01`, to: today }; }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function ecoTodayMsk() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); }
