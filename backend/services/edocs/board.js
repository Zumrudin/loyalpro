'use strict';
// Дашборд «Документов»: состояние документов пациента и цвет карточки. ЧИСТЫЙ модуль — без БД
// и сети; единственное место правил (спека docs/superpowers/specs/2026-10-25-edocs-board-design.md
// §3): фронт ничего не вычисляет, только рисует ответ — иначе цвет и подпись разъехались бы.
//   Карточка = пациент × день. Договор и согласие ПД — до визита, один раз на пациента;
//   акт — после оплаченного визита, по каждой записи (с acts_required_from).
const { missingFor, FIELDS } = require('./placeholders');
const { doctorOf } = require('./act-lines');

const PRE_KINDS = ['contract', 'consent_pd'];
const ACT = 'act';
const KINDS = [...PRE_KINDS, ACT];
const URGENT_MS = 2 * 3600 * 1000;          // «визит скоро»: до начала меньше 2 часов
const FIRST_VISIT_SOON_MS = 3 * 3600 * 1000; // «через 40 мин» у первичного — в пределах 3 часов
const DRAFT_SENDING_MS = 5 * 60 * 1000;     // черновик без ошибки моложе 5 минут — отправка ещё идёт
const REMIND_AFTER_MS = 15 * 60 * 1000;     // «Повторить ссылку» — не раньше 15 минут после отправки
const OPEN_DAYS = 30;                       // «Незакрытые»: прошлые 30 дней
const WEEK_DAYS = 7;
const BAD = new Set(['missing', 'lapsed', 'problem']);
const COLOR_ORDER = { red: 0, amber: 1, blue: 2, green: 3, grey: 4 };
const GENITIVE = { contract: 'договора', consent_pd: 'согласия', act: 'акта' };
const SEND_LABEL = { contract: 'Отправить договор', consent_pd: 'Отправить согласие', act: 'Отправить акт' };
const LAPSED_LABEL = { expired: 'Ссылка истекла', declined: 'Пациент отказался', annulled: 'Аннулировано' };
const LAPSED_TILE = { expired: 'срок истёк', declined: 'отказ', annulled: 'аннулирован' };
const VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
// Худший акт среди записей дня — для плитки карточки: «плохие» впереди, «нет шаблона» в конце.
const ACT_RANK = { lapsed: 0, problem: 1, missing: 2, pending: 3, unpaid: 4, later: 5, signed: 6, off: 7 };

const ms = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
const MSK_HM = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const MSK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «09:05» по Москве или ''. */
function hm(v) { const t = ms(v); return t === null ? '' : MSK_HM.format(new Date(t)); }
/** 'YYYY-MM-DD' по Москве. */
function mskDay(v) { const t = ms(v); return t === null ? '' : MSK_DAY.format(new Date(t)); }
/** 'YYYY-MM-DD' ± n дней (календарь, без часовых поясов). */
function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
function dm(day) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '')); return m ? `${m[3]}.${m[2]}` : ''; }
/** «12 мин» / «3 ч» / «2 дн» — сколько прошло. */
function ago(atMs, nowMs) {
  const m = Math.max(0, Math.round((nowMs - atMs) / 60000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн`;
}
/** «через 40 мин» / «через 1 ч 20 мин». */
function until(atMs, nowMs) {
  const m = Math.max(0, Math.round((atMs - nowMs) / 60000));
  if (m < 60) return `через ${m} мин`;
  const h = Math.floor(m / 60), rest = m % 60;
  return `через ${h} ч${rest ? ` ${rest} мин` : ''}`;
}
function joinRu(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} и ${words[words.length - 1]}`;
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;

/**
 * Состояние вида документа у пациента (спека §3.2). docs — строки «документ × комплект» пациента:
 * { package_id, package_status, record_id, kind, created_at, sent_at, signed_at, last_error, source }.
 * Для акта учитываются только комплекты записи recordId. Подписанный когда-то документ побеждает
 * любой новый неудачный комплект; иначе решает последний по времени создания.
 */
function kindState(docs, kind, { recordId = null, nowMs = Date.now() } = {}) {
  // Снятая отметка «на бумаге» — ошибка администратора: в состоянии её нет вовсе (документ снова «нет»,
  // а не «аннулирован»); след остаётся в журнале и в списке комплектов.
  const own = (docs || []).filter((d) => d && d.kind === kind && (kind !== ACT || Number(d.record_id) === Number(recordId))
    && !(d.source === 'paper' && d.package_status === 'annulled'));
  const signed = own.filter((d) => d.package_status === 'signed' || d.package_status === 'paper')
    .sort((a, b) => (ms(b.signed_at) || ms(b.created_at) || 0) - (ms(a.signed_at) || ms(a.created_at) || 0))[0];
  if (signed) return { state: 'signed', at: iso(signed.signed_at || signed.created_at), paper: signed.package_status === 'paper', packageId: signed.package_id };
  const last = own.slice().sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0))[0];
  if (!last) return { state: 'missing' };
  const base = { packageId: last.package_id, at: iso(last.sent_at || last.created_at), source: last.source || 'manual' };
  switch (last.package_status) {
    case 'sent': return { ...base, state: 'pending' };
    case 'draft': {
      const young = nowMs - (ms(last.created_at) || 0) < DRAFT_SENDING_MS;
      if (!last.last_error && young) return { ...base, state: 'pending' };
      return { ...base, state: 'problem', reason: 'not_sent', error: last.last_error || null };
    }
    case 'error': return { ...base, state: 'problem', reason: 'fdoc_error', error: last.last_error || null };
    case 'declined': case 'expired': case 'annulled': return { ...base, state: 'lapsed', reason: last.package_status };
    default: return { ...base, state: 'pending' };   // незнакомый статус — как ждущий: не терять из виду
  }
}

/** Нужен ли акт по записи: later — визит не состоялся; unpaid — пришёл, не оплачен; before_start — до acts_required_from. */
function actPhase(r, actsFrom) {
  if (String(r.attendance) !== '1') return 'later';
  if (actsFrom && String(r.visit_date) < String(actsFrom)) return 'before_start';
  return String(r.paid_full) === '1' ? 'required' : 'unpaid';
}

/** Текст и тон плитки документа. tone: ok | wait | no | soon | na. */
function tile(st, { urgent = true, nowMs, today }) {
  const at = ms(st.at);
  switch (st.state) {
    case 'signed': {
      if (st.paper) return { text: '✓ бумага', tone: 'ok' };
      const day = mskDay(at);
      const text = day === today ? hm(at) : day.slice(0, 4) === String(today).slice(0, 4) ? dm(day) : day.slice(0, 4);
      return { text: `✓ ${text}`, tone: 'ok' };
    }
    case 'pending': return { text: at === null ? 'отправлен' : `отправлен ${ago(at, nowMs)}`, tone: 'wait' };
    case 'problem': return { text: st.reason === 'fdoc_error' ? 'ошибка F.Doc' : 'не ушло', tone: urgent ? 'no' : 'soon' };
    case 'lapsed': return { text: LAPSED_TILE[st.reason] || 'срок истёк', tone: urgent ? 'no' : 'soon' };
    case 'missing': return { text: 'нет', tone: urgent ? 'no' : 'soon' };
    case 'later': return { text: 'после визита', tone: 'na' };
    case 'unpaid': return { text: 'ждём оплату', tone: 'na' };
    default: return { text: '—', tone: 'na' };
  }
}

function titlesOf(services) {
  return (Array.isArray(services) ? services : []).map((s) => String((s && s.title) || '').trim()).filter(Boolean);
}

/**
 * Одна карточка из записей пациента за день.
 * ctx: { docs, identity, form, notes, tplByKind, enabledKinds, requisites, settings, nowMs, today }
 */
function buildCard(recs, ctx) {
  const { tplByKind, nowMs, today, settings } = ctx;
  const r0 = recs[0];
  const day = String(r0.visit_date);
  const pre = {};
  for (const k of PRE_KINDS) pre[k] = tplByKind[k].length ? kindState(ctx.docs, k, { nowMs }) : { state: 'off' };
  const visits = recs.map((r) => {
    const phase = actPhase(r, settings.actsRequiredFrom);
    let act;
    if (!tplByKind[ACT].length) act = { state: 'off' };
    else if (phase === 'later') act = { state: 'later' };
    else if (phase === 'unpaid') act = { state: 'unpaid' };
    else if (phase === 'before_start') act = { state: 'off', reason: 'before_start' };
    else act = kindState(ctx.docs, ACT, { recordId: r.id, nowMs });
    return {
      recordId: r.id, time: hm(r.visit_at), visitAt: iso(r.visit_at), services: titlesOf(r.services),
      staffName: doctorOf(r.staff).name || '', arrived: String(r.attendance) === '1', paid: String(r.paid_full) === '1', act,
    };
  });
  const actWorst = visits.map((v) => v.act).sort((a, b) => ACT_RANK[a.state] - ACT_RANK[b.state])[0];
  const actBadVisits = visits.filter((v) => BAD.has(v.act.state));
  const preBad = PRE_KINDS.filter((k) => BAD.has(pre[k].state));
  const anyArrived = visits.some((v) => v.arrived);
  const startMs = ms(visits[0].visitAt);
  const past = day < today;
  const urgent = past || anyArrived || (day === today && startMs !== null && startMs - nowMs <= URGENT_MS);

  // Данные: хватает ли их на документы, которые сейчас «плохие» (§3.3). Реквизиты клиники — не про пациента.
  const needKinds = [...preBad, ...(actBadVisits.length ? [ACT] : [])];
  const needTemplates = needKinds.map((k) => tplByKind[k][0]).filter(Boolean);
  const missing = needTemplates.length
    ? missingFor(ctx.identity, needTemplates, ctx.requisites, { autoContractNo: !!settings.autonumber }).identity : [];
  const data = { exists: !!ctx.identity, complete: missing.length === 0, missing };

  let form = null;
  if (ctx.form) {
    const f = ctx.form;
    const status = f.status === 'active' && ms(f.expires_at) !== null && ms(f.expires_at) <= nowMs ? 'expired' : f.status;
    form = {
      id: f.id, status, createdAt: iso(f.created_at), deliveredVia: f.delivered_via || null, deliveredAt: iso(f.delivered_at),
      openedAt: iso(f.opened_at), submittedAt: iso(f.submitted_at), packageId: f.package_id || null, error: f.last_error || null,
    };
  }
  // Анкета у пациента, а данных ещё нет — договор и согласие ждём от него, а не от администратора.
  const formWaiting = !!(form && form.status === 'active' && !data.complete && preBad.length);
  const pendingStates = [...PRE_KINDS.map((k) => pre[k]), ...visits.map((v) => v.act)].filter((s) => s.state === 'pending');

  let color;
  if (!ctx.enabledKinds.length) color = 'grey';
  else if (actBadVisits.length || (preBad.length && urgent)) color = 'red';
  else if (preBad.length && !formWaiting) color = 'amber';
  else if (pendingStates.length || formWaiting) color = 'blue';
  else color = 'green';

  let label;
  if (color === 'grey') label = 'Шаблоны не настроены';
  else if (color === 'red') {
    const urgentBad = [...(urgent ? preBad.map((k) => pre[k]) : []), ...actBadVisits.map((v) => v.act)];
    const lapsed = urgentBad.find((s) => s.state === 'lapsed');
    if (lapsed) label = LAPSED_LABEL[lapsed.reason] || 'Ссылка истекла';
    else if (urgentBad.some((s) => s.state === 'problem')) label = 'Не ушло в F.Doc';
    else if (preBad.length && urgent && !anyArrived && !past) label = 'Нужно до визита';
    else if (preBad.length && urgent) label = `Нет ${joinRu([...preBad, ...(actBadVisits.length ? [ACT] : [])].map((k) => GENITIVE[k]))}`;
    else label = 'Акт не подписан';
  } else if (color === 'amber') label = day === today ? `Нужно до ${visits[0].time || 'визита'}` : `Нужно до ${dm(day)}`;
  else if (color === 'blue') label = formWaiting && !pendingStates.length ? 'Ждём анкету' : 'Ждём подпись';
  else label = visits.some((v) => v.act.state === 'signed') ? 'Всё подписано' : 'Документы готовы';

  // Главное действие (§3.5). Кнопки, которым нужен F.Doc, фронт сам заменит на «Открыть», если отправка
  // сейчас невозможна (модуль выключен, нет своей учётки) — это состояние пользователя, не пациента.
  let action = null;
  const sendAction = (kinds, recordId) => {
    const states = kinds.map((k) => (k === ACT ? (actBadVisits[0] || {}).act : pre[k])).filter(Boolean);
    const allLapsed = states.length && states.every((s) => s.state === 'lapsed');
    return {
      type: 'send', kinds, recordId: recordId || null,
      label: allLapsed ? 'Отправить снова' : kinds.length === 1 ? SEND_LABEL[kinds[0]] : `Отправить ${kinds.length} док.`,
    };
  };
  if (color !== 'grey' && color !== 'green') {
    if (preBad.length && !(formWaiting && !urgent)) {
      if (data.complete) action = sendAction([...preBad, ...(actBadVisits.length ? [ACT] : [])], actBadVisits.length ? actBadVisits[0].recordId : null);
      else action = { type: 'fill', label: 'Заполнить данные', form: true };
    } else if (actBadVisits.length) {
      action = data.complete ? sendAction([ACT], actBadVisits[0].recordId) : { type: 'fill', label: 'Заполнить данные', form: true };
    } else if (formWaiting) {
      action = { type: 'form_remind', label: 'Повторить анкету', formId: form.id, ghost: true };
    } else if (pendingStates.length) {
      const latest = pendingStates.slice().sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0))[0];
      const at = ms(latest.at);
      action = { type: 'remind', label: 'Повторить ссылку', packageId: latest.packageId, ghost: true,
        availableAt: at === null ? null : new Date(at + REMIND_AFTER_MS).toISOString() };
    }
  }

  const warnings = [];
  if (!anyArrived && !past && !r0.has_prior_visit) {
    const soon = day === today && startMs !== null && startMs > nowMs && startMs - nowMs <= FIRST_VISIT_SOON_MS;
    warnings.push(`⏱ Первичный${soon ? ` · ${until(startMs, nowMs)}` : ''}`);
  }
  if (needKinds.length && !data.complete) {
    const labels = missing.map((x) => x.label.toLowerCase());
    warnings.push(`Нет данных: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` и ещё ${labels.length - 3}` : ''}`);
  }
  for (const s of [...PRE_KINDS.map((k) => pre[k]), ...visits.map((v) => v.act)]) {
    if (s.state === 'problem' && s.error) { warnings.push(`Ошибка отправки: ${String(s.error).slice(0, 80)}`); break; }
  }
  if (form) {
    if (form.status === 'active' && !data.complete) {
      warnings.push(`Анкета отправлена ${hm(form.deliveredAt || form.createdAt)}${form.deliveredVia ? ` в ${VIA[form.deliveredVia] || form.deliveredVia}` : ''}${form.openedAt ? ', пациент открыл' : ''}`);
    } else if (form.status === 'submitted' && form.error && !form.packageId) {
      warnings.push(`Анкета заполнена, документы не ушли: ${String(form.error).slice(0, 80)}`);
    } else if (form.status === 'expired' && !data.complete) {
      warnings.push('Анкета не заполнена — ссылка устарела');
    }
  }
  const note = (ctx.notes || []).slice().sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0))[0];
  if (note) {
    if (note.status === 'done') warnings.push(`Автоматика ${hm(note.created_at)}: ${note.reason || 'отправлено'}`);
    else if (note.status === 'failed' || note.status === 'skipped') warnings.push(`Автоматика не отправила: ${note.reason || 'причина не записана'}`);
  }

  let hint = '';
  if (color === 'green') hint = visits.some((v) => v.act.state === 'signed') ? 'Визит закрыт' : visits.some((v) => v.act.state === 'unpaid') ? 'Акт — после оплаты визита' : 'Акт — после визита';
  else if (actBadVisits.length) hint = 'Визит оплачен в YClients';
  else if (formWaiting) hint = form.openedAt ? 'Пациент открыл анкету' : 'Ждём, пока пациент заполнит анкету';
  else if (pendingStates.length && color === 'blue') hint = 'Ждём подпись пациента';
  else if (needKinds.length && !data.complete) hint = 'Данные неполные';
  else if (needKinds.length) hint = 'Данные полные';

  const tiles = {};
  for (const k of PRE_KINDS) tiles[k] = tile(pre[k], { urgent, nowMs, today });
  tiles[ACT] = tile(actWorst || { state: 'off' }, { urgent: true, nowMs, today });

  const tags = [];
  if (BAD.has(pre.contract.state)) tags.push('no_contract');
  if (BAD.has(pre.consent_pd.state)) tags.push('no_consent');
  if (actBadVisits.length) tags.push('act');
  if (color === 'blue') tags.push('waiting');
  if (color === 'green') tags.push('ready');

  const services = [...new Set(visits.flatMap((v) => v.services))];
  return {
    key: `${r0.client_id}:${day}`, clientId: r0.client_id, name: r0.client_name || '—', initials: initials(r0.client_name), phone: r0.client_phone || null,
    day, time: visits[0].time, visitAt: visits[0].visitAt, services, staffName: visits[0].staffName, visits,
    docs: { contract: pre.contract, consent_pd: pre.consent_pd, act: actWorst || { state: 'off' } }, tiles,
    color, label, data, form, action, warnings, hint, tags, firstVisit: !r0.has_prior_visit, arrived: anyArrived,
  };
}

/**
 * Карточки по записям. input:
 *   records    — записи окна: { id, client_id, client_name, client_phone, visit_date 'YYYY-MM-DD', visit_at,
 *                attendance, paid_full, services, staff, has_prior_visit } (удалённые и неявки отсечены SQL);
 *   docs       — документы комплектов этих пациентов (kindState), с client_id;
 *   identities — Map client_id → строка client_identity без расшифровки (secure_fields — что заполнено);
 *   templates  — шаблоны салона; requisites — реквизиты клиники;
 *   forms      — последняя анкета пациента; notes — свежие строки edoc_auto_jobs;
 *   settings   — { actsRequiredFrom 'YYYY-MM-DD'|null, autonumber bool }; nowMs; today ('YYYY-MM-DD' по Москве).
 */
function buildBoard(input) {
  const { records = [], docs = [], identities = new Map(), templates = [], requisites = {}, forms = [], notes = [],
    settings = {}, nowMs = Date.now() } = input || {};
  const today = (input && input.today) || mskDay(nowMs);
  const active = (templates || []).filter((t) => t && t.is_active !== false);
  const tplByKind = {};
  for (const k of KINDS) tplByKind[k] = active.filter((t) => t.kind === k).sort(bySort);
  const enabledKinds = KINDS.filter((k) => tplByKind[k].length);
  const group = (list, key) => { const m = new Map(); for (const x of list || []) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const docsBy = group(docs, (d) => Number(d.client_id));
  const formsBy = new Map((forms || []).map((f) => [Number(f.client_id), f]));
  const notesBy = group(notes, (n) => Number(n.client_id));
  const days = group(records, (r) => `${r.client_id}:${r.visit_date}`);
  const cards = [];
  for (const recs of days.values()) {
    recs.sort((a, b) => (ms(a.visit_at) || 0) - (ms(b.visit_at) || 0) || a.id - b.id);
    const cid = Number(recs[0].client_id);
    const recIds = new Set(recs.map((r) => Number(r.id)));
    cards.push(buildCard(recs, {
      docs: docsBy.get(cid) || [], identity: identities.get(cid) || null, form: formsBy.get(cid) || null,
      notes: (notesBy.get(cid) || []).filter((n) => !n.record_id || recIds.has(Number(n.record_id))),
      tplByKind, enabledKinds, requisites, settings, nowMs, today,
    }));
  }
  cards.sort((a, b) => a.day.localeCompare(b.day) || COLOR_ORDER[a.color] - COLOR_ORDER[b.color]
    || (ms(a.visitAt) || 0) - (ms(b.visitAt) || 0) || String(a.name).localeCompare(String(b.name), 'ru'));
  const kinds = {};
  for (const k of KINDS) kinds[k] = tplByKind[k][0] ? { id: tplByKind[k][0].id, title: tplByKind[k][0].title } : null;
  return { cards, kinds, enabledKinds, today };
}

const STEP_TONE = { signed: 'ok', pending: 'wait', missing: 'no', lapsed: 'no', problem: 'no' };
/**
 * Страница пациента (спека §5): шапка (цвет, подпись, четыре шага), полнота данных, состояния
 * договора и согласия, визиты с актами, анкета. Те же правила, что у карточек, — через buildBoard.
 * input: { client, identity (строка client_identity без расшифровки), records, docs, templates, requisites,
 *          forms, notes, settings { actsRequiredFrom, autonumber }, nowMs, today, focusRecordId }
 */
function buildClientPage(input) {
  const { client, identity = null, records = [], docs = [], templates = [], requisites = {}, forms = [], notes = [], settings = {}, nowMs = Date.now() } = input;
  const today = input.today || mskDay(nowMs);
  const recs = records.map((r) => ({ ...r, client_id: client.id, client_name: client.name, client_phone: client.phone }));
  const built = buildBoard({ records: recs, docs, identities: new Map(identity ? [[client.id, identity]] : []), templates, requisites,
    forms, notes, settings, nowMs, today });
  const active = templates.filter((t) => t && t.is_active !== false);
  const tplOf = (k) => active.filter((t) => t.kind === k).sort(bySort)[0] || null;
  const pre = {};
  for (const k of PRE_KINDS) pre[k] = tplOf(k) ? kindState(docs, k, { nowMs }) : { state: 'off' };
  const visits = [];
  for (const c of built.cards) for (const v of c.visits) visits.push({ ...v, day: c.day, tile: tile(v.act, { urgent: true, nowMs, today }) });
  visits.sort((a, b) => (ms(b.visitAt) || 0) - (ms(a.visitAt) || 0) || b.recordId - a.recordId);
  const focusId = Number(input.focusRecordId) || null;
  const focus = (focusId && visits.find((v) => v.recordId === focusId))
    || visits.find((v) => BAD.has(v.act.state)) || visits.find((v) => v.arrived) || null;
  // Шапка — карточка сегодняшнего дня, иначе ближайшего будущего, иначе последнего прошлого.
  const cards = built.cards;
  const headCard = cards.find((c) => c.day === today) || cards.filter((c) => c.day > today).sort((a, b) => a.day.localeCompare(b.day))[0]
    || cards.filter((c) => c.day < today).sort((a, b) => b.day.localeCompare(a.day))[0] || null;
  // Данные: чего не хватает для документов, которые ещё не подписаны (и для акта выбранного визита).
  const needKinds = PRE_KINDS.filter((k) => pre[k].state !== 'signed' && pre[k].state !== 'off');
  if (focus && BAD.has(focus.act.state)) needKinds.push(ACT);
  const autoContractNo = !!settings.autonumber;
  const needTpl = needKinds.map(tplOf).filter(Boolean);
  const missing = needTpl.length ? missingFor(identity, needTpl, requisites, { autoContractNo }).identity : [];
  const allTpl = KINDS.map(tplOf).filter(Boolean);
  const required = new Set(allTpl.length ? ['last_name', 'first_name', 'phone'] : []);
  for (const t of allTpl) for (const name of t.placeholders || []) { const f = FIELDS[name]; if (f) for (const r of f.requires) required.add(r); }
  if (autoContractNo) required.delete('contract_no');
  let header;
  if (headCard) {
    header = { color: headCard.color, label: headCard.label, day: headCard.day, time: headCard.time, services: headCard.services,
      staffName: headCard.staffName, firstVisit: headCard.firstVisit, arrived: headCard.arrived };
  } else {
    const bad = PRE_KINDS.filter((k) => BAD.has(pre[k].state));
    const pending = PRE_KINDS.some((k) => pre[k].state === 'pending');
    header = { color: !built.enabledKinds.length ? 'grey' : bad.length ? 'amber' : pending ? 'blue' : 'green',
      label: !built.enabledKinds.length ? 'Шаблоны не настроены' : bad.length ? `Нет ${joinRu(bad.map((k) => GENITIVE[k]))}` : pending ? 'Ждём подпись' : 'Документы готовы',
      day: null, time: '', services: [], staffName: '', firstVisit: false, arrived: false };
  }
  header.steps = [
    { key: 'data', tone: missing.length ? 'no' : 'ok' },
    ...PRE_KINDS.map((k) => ({ key: k, tone: STEP_TONE[pre[k].state] || 'none' })),
    { key: ACT, tone: focus ? (STEP_TONE[focus.act.state] || 'none') : 'none' },
  ];
  const docsOut = {};
  for (const k of PRE_KINDS) docsOut[k] = { ...pre[k], tile: tile(pre[k], { urgent: headCard ? headCard.color === 'red' : false, nowMs, today }) };
  const f = forms[0] || null;
  return {
    client: { id: client.id, name: client.name, phone: client.phone || null, initials: initials(client.name) },
    header, data: { exists: !!identity, complete: !missing.length, missing, required: [...required] }, docs: docsOut, visits,
    focusRecordId: focus ? focus.recordId : null,
    form: f ? { id: f.id, status: f.status === 'active' && ms(f.expires_at) !== null && ms(f.expires_at) <= nowMs ? 'expired' : f.status,
      createdAt: iso(f.created_at), deliveredVia: f.delivered_via || null, deliveredAt: iso(f.delivered_at), openedAt: iso(f.opened_at),
      submittedAt: iso(f.submitted_at), expiresAt: iso(f.expires_at), packageId: f.package_id || null, error: f.last_error || null } : null,
    warnings: headCard ? headCard.warnings : [], kinds: built.kinds,
  };
}

/** Границы дней периода. open — прошлые 30 дней, не раньше acts_required_from. */
function rangeBounds(range, today, actsFrom) {
  if (range === 'tomorrow') return { from: addDays(today, 1), to: addDays(today, 1) };
  if (range === 'week') return { from: today, to: addDays(today, WEEK_DAYS - 1) };
  if (range === 'open') {
    const from = addDays(today, -OPEN_DAYS);
    return { from: actsFrom && actsFrom > from ? actsFrom : from, to: addDays(today, -1) };
  }
  return { from: today, to: today };
}
/** Окно выборки записей — все периоды сразу: счётчики периодов считаются тем же правилом. */
function windowBounds(today, actsFrom) {
  return { from: rangeBounds('open', today, actsFrom).from, to: addDays(today, WEEK_DAYS - 1) };
}
const inRange = (card, b) => card.day >= b.from && card.day <= b.to;
/** «Незакрытые» — только не зелёные (и не серые) карточки прошлых дней. */
function sliceRange(cards, range, today, actsFrom) {
  const b = rangeBounds(range, today, actsFrom);
  return cards.filter((c) => inRange(c, b) && (range !== 'open' || (c.color !== 'green' && c.color !== 'grey')));
}
function rangeCounts(cards, today, actsFrom) {
  const out = {};
  for (const r of ['today', 'tomorrow', 'week', 'open']) out[r] = sliceRange(cards, r, today, actsFrom).length;
  return out;
}
function summarize(cards) {
  const s = { total: cards.length, red: 0, amber: 0, blue: 0, green: 0, grey: 0 };
  const chips = { all: cards.length, no_contract: 0, no_consent: 0, act: 0, waiting: 0, ready: 0 };
  for (const c of cards) {
    s[c.color]++;
    for (const t of c.tags) chips[t]++;
  }
  return { summary: s, chips };
}

module.exports = {
  PRE_KINDS, ACT, KINDS, URGENT_MS, REMIND_AFTER_MS, OPEN_DAYS, BAD,
  kindState, actPhase, buildBoard, buildCard, buildClientPage, rangeBounds, windowBounds, sliceRange, rangeCounts, summarize, joinRu,
  addDays, mskDay, hm,
};
