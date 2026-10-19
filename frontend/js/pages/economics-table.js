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

/** Следующее состояние сортировки по клику на заголовок. Новая колонка — desc (крупные сверху), «Услуга» — asc. */
function ecoSortNext(state, key) {
  if (!ECO_SERVICE_COLS.some(c => c.key === key)) return { sortKey: state.sortKey, sortDir: state.sortDir };
  if (state.sortKey === key) return { sortKey: key, sortDir: state.sortDir === 'desc' ? 'asc' : 'desc' };
  return { sortKey: key, sortDir: key === 'label' ? 'asc' : 'desc' };
}

/** Плитки сводки периода: {kpi, title, sub} — строки уже отформатированы, без HTML. */
function ecoSummaryTiles(s) {
  const c = s.coverage || {};
  const bonus = Number(s.bonus_redeemed) > 0 ? ` · бонусов списано ${ecoMoney(s.bonus_redeemed)}` : '';
  return [
    { kpi: ecoMoney(s.revenue), title: 'Выручка', sub: `${ecoNum(s.visits)} визитов · ${ecoNum(s.hours, 0)} ч${bonus}` },
    { kpi: ecoMoney(s.contribution), title: 'Маржинальная прибыль', sub: ecoPct(s.contribution_pct) },
    { kpi: ecoMoney(s.operating_profit), title: 'Операционная прибыль', sub: `${ecoPct(s.operating_pct)} · УСН ≈ ${ecoMoney(s.usn_estimate)}` },
    { kpi: `${ecoNum(s.rate_minute_fact, 1)} ₽`, title: 'Ставка минуты (факт)',
      sub: Number(s.rate_minute_capacity) > 0 ? `при полной загрузке ${ecoNum(s.rate_minute_capacity, 1)} ₽ · простой ${ecoMoney(s.idle_cost)}` : 'график сотрудников не загружен' },
    { kpi: ecoPct(c.consumables_share), title: 'Визитов со списаниями', sub: `${ecoNum(c.services_without_tech_card)} из ${ecoNum(c.services_total)} услуг без техкарты` },
    { kpi: ecoNum((c.goods_without_price || []).length), title: 'Товаров без цены', sub: `${ecoNum(c.staff_without_pay_rule)} сотрудников без правила оплаты` },
  ];
}

/**
 * Статьи детализации услуги (сверху вниз). price — сумма к оплате после скидок (cost_to_pay);
 * часть списанных бонусов YClients уже вычел в ней, поэтому из выручки вычитается только
 * bonus_in_revenue, а bonus_redeemed (всё списанное) — справочно в примечании.
 * {label, value, note, total} — строки без HTML.
 */
function ecoDetailLines(s, settings) {
  const st = settings || {};
  const cov = s.coverage || {};
  const redeemed = Number(s.bonus_redeemed) || 0, inRev = Number(s.bonus_in_revenue) || 0;
  const bonusNote = redeemed > 0
    ? `списано ${ecoMoney(redeemed)}${redeemed - inRev > 0 ? `, из них ${ecoMoney(redeemed - inRev)} уже учтено YClients в сумме к оплате` : ''}`
    : 'бонусы не списывались';
  const L = (label, value, note, total) => ({ label, value, note: note || '', total: !!total });
  return [
    L('Стоимость услуг (к оплате, после скидок)', ecoMoney(s.price), `скидки ${ecoMoney(s.discount)} — справочно`),
    L('− бонусы, не учтённые в сумме к оплате', ecoMoney(inRev), bonusNote),
    L('= Выручка', ecoMoney(s.revenue), '', true),
    L('− Материалы', ecoMoney(s.materials_used), `факт ${ecoMoney(s.materials_fact)} · норма ${ecoMoney(s.materials_norm)} · строк по норме: ${ecoNum(s.materials_estimated_rows)}`),
    L('− Оплата врача', ecoMoney(s.doctor_cost), `на руки ${ecoMoney(s.doctor_pay)} × множитель ФОТ ${ecoNum(st.payroll_multiplier, 3)}`),
    L('− Эквайринг', ecoMoney(s.acquiring_cost), `строк по средней доле: ${ecoNum(cov.acquiring_estimated)}`),
    L('= Маржинальная прибыль', ecoMoney(s.contribution), ecoPct(s.contribution_pct), true),
    L('− Постоянные расходы', ecoMoney(s.overhead), `драйвер: ${st.allocation_driver === 'visits' ? 'поровну на визит' : 'по минутам'}`),
    L('− Аппараты', ecoMoney(s.equipment_cost), ''),
    L('= Операционная прибыль', ecoMoney(s.operating_profit), `${ecoPct(s.operating_pct)} · УСН ≈ ${ecoMoney(s.usn_estimate)} · марж. прибыль ${ecoMoney(s.profit_per_hour)}/час`, true),
  ];
}

/** Флаги визита в детализации — короткие подписи. */
function ecoVisitFlags(v) {
  const out = [];
  if (v.materials_estimated) out.push('оценка материалов');
  if (v.no_materials_data) out.push('нет данных о материалах');
  if (v.no_price_goods && v.no_price_goods.length) out.push(`без цены: ${v.no_price_goods.length}`);
  if (v.no_pay_rule) out.push('нет правила оплаты');
  if (v.acquiring_estimated) out.push('нет оплат');
  return out;
}
