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
/**
 * Московская дата ДД.ММ.ГГГГ из TIMESTAMPTZ (сервер отдаёт UTC ISO): .slice(0,10)
 * давал UTC-дату, и приход в 01:30 мск показывался вчерашним. Голая YYYY-MM-DD —
 * как есть (это уже календарная дата). Мусор/пусто → ''.
 */
function ecoMskDate(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  let iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  else {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  }
  const [y, m, dd] = iso.split('-');
  return `${dd}.${m}.${y}`;
}
/** Справочник можно кэшировать, только если он полный: degraded (YClients не ответил) или пустой — нет. */
function ecoDictsCacheable(d) {
  return !!(d && !d.degraded && Array.isArray(d.services) && d.services.length > 0);
}

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

/** Количество без хвостовых нулей (до 2 знаков). */
function ecoQty(v) { return ecoNum(v, Math.abs(Number(v) * 100 % 100) < 1e-9 ? 0 : (Math.abs(Number(v) * 100 % 10) < 1e-9 ? 1 : 2)); }

/** Единица списания товара + подпись пересчёта упаковки: {main, sub}. */
function ecoGoodsUnit(g) {
  const main = g.service_unit || g.unit || '';
  const eq = Number(g.unit_equals);
  const sub = g.unit && Number.isFinite(eq) && eq > 0 && eq !== 1 ? `1 ${g.unit} = ${ecoQty(eq)} ${g.service_unit || ''}`.trim() : '';
  return { main, sub };
}

/** Состав техкарты одной строкой (текст, без HTML). */
function ecoCardItemsText(items) {
  return (items || []).map(i => `${i.title || ('товар ' + i.good_id)} × ${ecoQty(i.amount)}${i.unit ? ' ' + i.unit : ''}`).join('; ');
}

function ecoCoverageHint(s) { return `${ecoNum(s.visits)} визитов · списания у ${ecoPct(s.consumables_share)}`; }

function ecoParseNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v === null || v === undefined ? '' : v).trim().replace(',', '.');
  return s === '' || !Number.isFinite(Number(s)) ? NaN : Number(s);
}

/** Ручная цена единицы: пусто → снять (null), число > 0 → value, иначе error. */
function ecoPriceValue(raw) {
  if (String(raw === null || raw === undefined ? '' : raw).trim() === '') return { value: null };
  const n = ecoParseNumber(raw);
  if (!(n > 0) || n > 1e7) return { error: 'Цена — число больше 0 (пусто — снять)' };
  return { value: n };
}

/** Проверка формы ручной нормы до отправки. rows: [{goodId, amount, unit}] из полей. */
function ecoParseManualItems(title, rows) {
  const t = String(title || '').trim();
  if (!t) return { error: 'Укажите название нормы' };
  if (!rows || !rows.length) return { error: 'Добавьте хотя бы одну позицию' };
  const items = [];
  for (const [i, r] of rows.entries()) {
    const gid = ecoParseNumber(r.goodId);
    const amount = ecoParseNumber(r.amount);
    if (!Number.isInteger(gid) || gid <= 0) return { error: `Позиция ${i + 1}: выберите товар` };
    if (!(amount > 0)) return { error: `Позиция ${i + 1}: количество больше 0` };
    items.push({ goodId: gid, amount, unit: String(r.unit || '').trim() });
  }
  return { value: { title: t, items } };
}

/** Реальная календарная дата 'YYYY-MM-DD'. */
function ecoIsDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** Строгое число из поля формы: «12», «12,5», «-3»; пусто/мусор/0x10/1e3 → NaN. */
function ecoStrictNumber(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return /^-?\d+([.,]\d+)?$/.test(s) ? Number(s.replace(',', '.')) : NaN;
}
function ecoOptId(v, label) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (s === '') return { value: null };
  if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) return { error: `${label}: некорректный идентификатор` };
  return { value: Number(s) };
}

/** Форма правила оплаты → тело POST/PUT /pay-rules (то, что принимает parsePayRule). f — строки из полей. */
function ecoParseRuleForm(f) {
  const staff = ecoOptId(f.staff, 'Сотрудник'), service = ecoOptId(f.service, 'Услуга'), cat = ecoOptId(f.category, 'Категория');
  for (const x of [staff, service, cat]) if (x.error) return { error: x.error };
  if (service.value !== null && cat.value !== null) return { error: 'Правило либо на услугу, либо на категорию — не на обе сразу' };
  const percent = ecoStrictNumber(f.percent);
  if (!(percent >= 0 && percent <= 100)) return { error: 'Процент — число от 0 до 100' };
  if (f.base !== 'gross' && f.base !== 'net_of_materials') return { error: 'Выберите базу процента' };
  const fixedRaw = String(f.fixed === null || f.fixed === undefined ? '' : f.fixed).trim();
  const fixed = fixedRaw === '' ? 0 : ecoStrictNumber(fixedRaw);
  if (!(fixed >= 0 && fixed <= 1e7)) return { error: 'Фикс за визит — число от 0' };
  const from = String(f.from || '').trim() || null, to = String(f.to || '').trim() || null;
  if ((from && !ecoIsDate(from)) || (to && !ecoIsDate(to))) return { error: 'Неверная дата' };
  if (from && to && from > to) return { error: 'Период: начало позже конца' };
  const note = String(f.note || '').trim();
  if (note.length > 500) return { error: 'Заметка — не длиннее 500 символов' };
  return { value: { staffYcId: staff.value, serviceYcId: service.value, categoryYcId: cat.value, percent, base: f.base, fixedPerVisit: fixed, validFrom: from, validTo: to, note } };
}

/** Область правила как пары [тип, id] для подписи (имена подставляет страница). Пусто — «салон по умолчанию». */
function ecoRuleScopeParts(r) {
  const out = [];
  if (r.staff_yc_id) out.push(['сотрудник', r.staff_yc_id]);
  if (r.service_yc_id) out.push(['услуга', r.service_yc_id]);
  if (r.category_yc_id) out.push(['категория', r.category_yc_id]);
  return out;
}

/** Форма настроек → тело PUT /settings. f: {mult, base:'0'|'1', driver, usn, acquiring:[{account, value}]}. */
function ecoParseSettingsForm(f) {
  const mult = ecoStrictNumber(f.mult);
  if (!(mult >= 1 && mult <= 3)) return { error: 'Множитель налогов на ФОТ — от 1 до 3' };
  if (f.driver !== 'minutes' && f.driver !== 'visits') return { error: 'Выберите драйвер постоянных расходов' };
  const usn = ecoStrictNumber(f.usn);
  if (!(usn >= 0 && usn <= 50)) return { error: 'Ставка УСН — от 0 до 50 %' };
  const rows = f.acquiring || [];
  if (rows.length > 50) return { error: 'Слишком много касс (не больше 50)' };
  const acquiring = {};
  for (const r of rows) {
    const key = String(r.account || '').slice(0, 128);
    if (!key || key === '__proto__') return { error: 'Недопустимое название кассы' };
    const raw = String(r.value === null || r.value === undefined ? '' : r.value).trim();
    const pct = raw === '' ? 0 : ecoStrictNumber(raw);
    if (!(pct >= 0 && pct <= 10)) return { error: `Эквайринг «${key}»: процент от 0 до 10` };
    acquiring[key] = pct;
  }
  return { value: { payrollMultiplier: mult, payBaseIncludesBonuses: f.base === '1', allocationDriver: f.driver, usnRate: usn, acquiring } };
}

// ── Постоянные расходы и аппараты (task 20) ──
// Список статей совпадает с backend/services/economics/fixed-categories.js (тест паритета).
const ECO_FIXED_CATS = { rent: 'Аренда', admin: 'Администраторы (с налогами)', cleaning: 'Уборка', utilities: 'Коммунальные', software: 'ПО и подписки', marketing: 'Маркетинг', accounting: 'Бухгалтерия', medwaste: 'Медотходы и стерилизация', other: 'Прочее' };

/** 'YYYY-MM' → следующий месяц 'YYYY-MM'. */
function ecoNextMonth(m) {
  const [y, mo] = String(m).split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}
function ecoIsMonth(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }

/** Строки бюджета, действующие в месяце m ('YYYY-MM'): month_from ≤ m ≤ month_to (пусто = бессрочно). */
function ecoFixedForMonth(rows, m) {
  return (rows || []).filter(x => x.month_from.slice(0, 7) <= m && (!x.month_to || x.month_to.slice(0, 7) >= m));
}
/** Месяцы для блоков: все начала статей + текущий, новые сверху. Бессрочные статьи видны в блоках от начала. */
function ecoFixedMonths(rows, today) {
  const set = new Set((rows || []).map(x => x.month_from.slice(0, 7)));
  set.add(String(today).slice(0, 7));
  return [...set].sort().reverse();
}
function ecoFixedTotal(rows) { return rows.reduce((a, x) => a + Number(x.amount_month), 0); }

/** Форма статьи → тело POST/PUT /fixed-costs (как parseFixedCost). f — строки из полей. */
function ecoParseFixedForm(f) {
  if (!Object.prototype.hasOwnProperty.call(ECO_FIXED_CATS, f.category)) return { error: 'Выберите статью расходов' };
  const amount = ecoStrictNumber(f.amount);
  if (!(amount >= 0 && amount <= 1e9)) return { error: 'Сумма в месяц — число от 0' };
  const from = String(f.from || '').trim(), to = String(f.to || '').trim();
  if (!ecoIsMonth(from)) return { error: 'Укажите месяц начала' };
  if (to && !ecoIsMonth(to)) return { error: 'Неверный месяц окончания' };
  if (to && to < from) return { error: 'Период: конец раньше начала' };
  const title = String(f.title || '').trim();
  if (title.length > 255) return { error: 'Название — не длиннее 255 символов' };
  const note = String(f.note || '').trim();
  if (note.length > 500) return { error: 'Заметка — не длиннее 500 символов' };
  return { value: { category: f.category, title, amountMonth: amount, monthFrom: from, monthTo: to || null, note } };
}

/** Форма аппарата → тело POST/PUT /equipment (как parseEquipment). serviceIds — массив строк/чисел. */
function ecoParseEquipmentForm(f) {
  const name = String(f.name || '').trim();
  if (!name || name.length > 255) return { error: 'Название — от 1 до 255 символов' };
  const price = ecoStrictNumber(f.price);
  if (!(price >= 0 && price <= 1e9)) return { error: 'Цена покупки — число от 0' };
  const date = String(f.date || '').trim() || null;
  if (date && !ecoIsDate(date)) return { error: 'Неверная дата покупки' };
  const life = ecoStrictNumber(f.life);
  if (!Number.isInteger(life) || life < 1 || life > 240) return { error: 'Срок службы — целое число месяцев от 1 до 240' };
  const resRaw = String(f.residual === null || f.residual === undefined ? '' : f.residual).trim();
  const residual = resRaw === '' ? 0 : ecoStrictNumber(resRaw);
  if (!(residual >= 0 && residual <= 100)) return { error: 'Остаточная стоимость — от 0 до 100 %' };
  const mRaw = String(f.maint === null || f.maint === undefined ? '' : f.maint).trim();
  const maint = mRaw === '' ? 0 : ecoStrictNumber(mRaw);
  if (!(maint >= 0 && maint <= 1e9)) return { error: 'ТО в месяц — число от 0' };
  const ids = [];
  for (const s of (f.serviceIds || [])) {
    const id = Number(s);
    if (!Number.isInteger(id) || id <= 0) return { error: 'Некорректная услуга в привязке' };
    if (!ids.includes(id)) ids.push(id);
  }
  const note = String(f.note || '').trim();
  if (note.length > 500) return { error: 'Заметка — не длиннее 500 символов' };
  return { value: { name, purchasePrice: price, purchaseDate: date, usefulLifeMonths: life, residualPct: residual, maintenanceMonthly: maint, serviceIds: ids, isActive: f.active !== false && f.active !== '0', note } };
}
/** Строка сида → тело POST /equipment. */
function ecoSeedBody(s) {
  return { name: s.name, purchasePrice: s.purchase_price, usefulLifeMonths: s.useful_life_months, note: s.note || '', serviceIds: [] };
}
