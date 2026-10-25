'use strict';
// Состояния документов и цвет карточки дашборда (services/edocs/board.js — чистый модуль).
const b = require('./services/edocs/board');

const NOW = Date.parse('2026-10-25T10:00:00+03:00');
const TODAY = '2026-10-25';
const at = (s) => new Date(Date.parse(s)).toISOString();

const T = {
  contract: { id: 5, kind: 'contract', title: 'Договор', is_active: true, sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no'] },
  consent: { id: 6, kind: 'consent_pd', title: 'Согласие ПД', is_active: true, sort_order: 1, placeholders: ['fio', 'phone'] },
  act: { id: 7, kind: 'act', title: 'Акт', is_active: true, sort_order: 2, placeholders: ['fio', 'services', 'total_sum'] },
};
const TEMPLATES = [T.contract, T.consent, T.act];
const FULL_ID = { client_id: 52, last_name: 'Иванова', first_name: 'Анна', middle_name: null, phone: '79200255591', contract_no: '1859', secure_fields: ['passport_series', 'passport_number', 'address'] };
const NO_PASSPORT = { ...FULL_ID, secure_fields: [] };

function rec(over = {}) {
  return {
    id: 100, client_id: 52, client_name: 'Иванова Анна Сергеевна', client_phone: '+79200255591', visit_date: TODAY,
    visit_at: at('2026-10-25T10:40:00+03:00'), attendance: '0', paid_full: '0', has_prior_visit: false,
    services: [{ title: 'Биоревитализация' }], staff: { name: 'Гаджиева Пери' }, ...over,
  };
}
function doc(kind, status, over = {}) {
  return { client_id: 52, package_id: over.package_id || `p-${kind}-${status}`, package_status: status, kind, record_id: null,
    created_at: at('2026-10-25T09:00:00+03:00'), sent_at: at('2026-10-25T09:00:00+03:00'), signed_at: null, last_error: null, source: 'manual', ...over };
}
function board(records, { docs = [], identity = null, forms = [], notes = [], templates = TEMPLATES, settings = { actsRequiredFrom: '2026-10-01', autonumber: true } } = {}) {
  const identities = new Map(identity ? [[52, identity]] : []);
  return b.buildBoard({ records, docs, identities, templates, requisites: {}, forms, notes, settings, nowMs: NOW, today: TODAY });
}
const one = (records, opts) => { const r = board(records, opts); expect(r.cards).toHaveLength(1); return r.cards[0]; };

describe('kindState', () => {
  test('нет комплектов — missing; подписанный побеждает более новый неудачный', () => {
    expect(b.kindState([], 'contract', { nowMs: NOW })).toEqual({ state: 'missing' });
    const docs = [
      doc('contract', 'signed', { created_at: at('2026-07-03T12:00:00+03:00'), signed_at: at('2026-07-03T12:05:00+03:00') }),
      doc('contract', 'expired', { created_at: at('2026-10-20T12:00:00+03:00') }),
    ];
    expect(b.kindState(docs, 'contract', { nowMs: NOW })).toMatchObject({ state: 'signed', at: at('2026-07-03T12:05:00+03:00'), paper: false });
    expect(b.kindState([doc('contract', 'paper')], 'contract', { nowMs: NOW })).toMatchObject({ state: 'signed', paper: true });
  });

  test('последний неподписанный решает: sent → pending, error → problem, отказ/срок/аннулирован → lapsed', () => {
    expect(b.kindState([doc('consent_pd', 'sent')], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'pending', packageId: 'p-consent_pd-sent' });
    expect(b.kindState([doc('consent_pd', 'error', { last_error: 'ERROR_SIGN' })], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'fdoc_error' });
    for (const st of ['declined', 'expired', 'annulled']) {
      expect(b.kindState([doc('consent_pd', st)], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'lapsed', reason: st });
    }
    const older = doc('consent_pd', 'expired', { created_at: at('2026-10-20T09:00:00+03:00') });
    expect(b.kindState([older, doc('consent_pd', 'sent')], 'consent_pd', { nowMs: NOW }).state).toBe('pending');
  });

  test('черновик: моложе 5 минут без ошибки — отправка идёт; с ошибкой или старше — не ушло', () => {
    const young = doc('contract', 'draft', { created_at: new Date(NOW - 60000).toISOString(), sent_at: null });
    expect(b.kindState([young], 'contract', { nowMs: NOW }).state).toBe('pending');
    expect(b.kindState([{ ...young, last_error: 'F.Doc 400' }], 'contract', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'not_sent', error: 'F.Doc 400' });
    const stale = { ...young, created_at: new Date(NOW - 10 * 60000).toISOString() };
    expect(b.kindState([stale], 'contract', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'not_sent' });
  });

  test('акт считается только по своей записи', () => {
    const docs = [doc('act', 'signed', { record_id: 100 }), doc('act', 'sent', { record_id: 101 })];
    expect(b.kindState(docs, 'act', { recordId: 100, nowMs: NOW }).state).toBe('signed');
    expect(b.kindState(docs, 'act', { recordId: 101, nowMs: NOW }).state).toBe('pending');
    expect(b.kindState(docs, 'act', { recordId: 102, nowMs: NOW }).state).toBe('missing');
  });
});

test('actPhase: не пришёл — later; пришёл и оплатил — required; не оплатил — unpaid; до старта актов — before_start', () => {
  expect(b.actPhase({ attendance: '0', paid_full: '1', visit_date: TODAY }, '2026-10-01')).toBe('later');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: TODAY }, '2026-10-01')).toBe('required');
  expect(b.actPhase({ attendance: '1', paid_full: '0', visit_date: TODAY }, '2026-10-01')).toBe('unpaid');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: '2026-09-30' }, '2026-10-01')).toBe('before_start');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: '2026-09-30' }, null)).toBe('required');
});

describe('цвет, подпись, действие', () => {
  test('первичный через 40 минут без документов и паспорта — красный «Нужно до визита», «Заполнить данные»', () => {
    const c = one([rec()], { identity: NO_PASSPORT });
    expect(c).toMatchObject({ color: 'red', label: 'Нужно до визита', time: '10:40', firstVisit: true });
    expect(c.action).toEqual({ type: 'fill', label: 'Заполнить данные', form: true });
    expect(c.tiles).toEqual({ contract: { text: 'нет', tone: 'no' }, consent_pd: { text: 'нет', tone: 'no' }, act: { text: 'после визита', tone: 'na' } });
    expect(c.data.complete).toBe(false);
    expect(c.data.missing.map((x) => x.key)).toEqual(['address', 'passport_number', 'passport_series']);
    expect(c.warnings[0]).toBe('⏱ Первичный · через 40 мин');
    expect(c.warnings[1]).toBe('Нет данных: адрес регистрации, номер паспорта, серия паспорта');
    expect(c.hint).toBe('Данные неполные');
    expect(c.tags).toEqual(['no_contract', 'no_consent']);
  });

  test('данные есть — «Отправить 2 док.» с видами; один вид — его название', () => {
    expect(one([rec()], { identity: FULL_ID }).action).toEqual({ type: 'send', kinds: ['contract', 'consent_pd'], recordId: null, label: 'Отправить 2 док.' });
    const c = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'signed')] });
    expect(c.action).toEqual({ type: 'send', kinds: ['consent_pd'], recordId: null, label: 'Отправить согласие' });
  });

  test('визит позже сегодня — оранжевый «Нужно до 16:30», завтра — «Нужно до 26.10»', () => {
    const later = one([rec({ visit_at: at('2026-10-25T16:30:00+03:00') })], { identity: FULL_ID });
    expect(later).toMatchObject({ color: 'amber', label: 'Нужно до 16:30' });
    expect(later.tiles.contract).toEqual({ text: 'нет', tone: 'soon' });
    const tomorrow = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: FULL_ID });
    expect(tomorrow).toMatchObject({ color: 'amber', label: 'Нужно до 26.10' });
  });

  test('ровно 2 часа до начала — уже срочно', () => {
    expect(one([rec({ visit_at: at('2026-10-25T12:00:00+03:00') })], { identity: FULL_ID }).color).toBe('red');
    expect(one([rec({ visit_at: at('2026-10-25T12:01:00+03:00') })], { identity: FULL_ID }).color).toBe('amber');
  });

  test('пришёл и оплатил, договор и согласие есть, акта нет — «Акт не подписан», отправка акта по записи', () => {
    const docs = [doc('contract', 'signed', { signed_at: at('2025-07-03T12:00:00+03:00') }), doc('consent_pd', 'signed', { signed_at: at('2026-09-12T12:00:00+03:00') })];
    const c = one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'red', label: 'Акт не подписан', hint: 'Визит оплачен в YClients', tags: ['act'] });
    expect(c.action).toEqual({ type: 'send', kinds: ['act'], recordId: 100, label: 'Отправить акт' });
    expect(c.tiles).toEqual({ contract: { text: '✓ 2025', tone: 'ok' }, consent_pd: { text: '✓ 12.09', tone: 'ok' }, act: { text: 'нет', tone: 'no' } });
  });

  test('пришёл, не оплатил — акт «ждём оплату», карточка зелёная «Документы готовы»', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed')];
    const c = one([rec({ attendance: '1', paid_full: '0', has_prior_visit: true })], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'green', label: 'Документы готовы', hint: 'Акт — после оплаты визита', action: null, tags: ['ready'] });
    expect(c.tiles.act).toEqual({ text: 'ждём оплату', tone: 'na' });
    expect(c.tiles.contract).toEqual({ text: '✓ 09:00', tone: 'ok' });
  });

  test('всё подписано, включая акт — «Всё подписано», «Визит закрыт»', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed'), doc('act', 'signed', { record_id: 100 })];
    expect(one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID, docs }))
      .toMatchObject({ color: 'green', label: 'Всё подписано', hint: 'Визит закрыт' });
  });

  test('ждёт подписи — синий, «Повторить ссылку» не раньше 15 минут после отправки', () => {
    const sent = at('2026-10-25T09:50:00+03:00');
    const docs = [doc('contract', 'sent', { sent_at: sent, package_id: 'P1' }), doc('consent_pd', 'sent', { sent_at: sent, package_id: 'P1' })];
    const c = one([rec()], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'blue', label: 'Ждём подпись', tags: ['waiting'] });
    expect(c.action).toEqual({ type: 'remind', label: 'Повторить ссылку', packageId: 'P1', ghost: true, availableAt: at('2026-10-25T10:05:00+03:00') });
    expect(c.tiles.contract).toEqual({ text: 'отправлен 10 мин', tone: 'wait' });
  });

  test('анкета у пациента: завтра — синий «Ждём анкету»; срочно — красный и «Заполнить данные»', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-25T09:00:00+03:00'), delivered_via: 'whatsapp',
      delivered_at: at('2026-10-25T09:00:00+03:00'), opened_at: null, submitted_at: null, expires_at: at('2026-11-01T09:00:00+03:00') };
    const tomorrow = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: NO_PASSPORT, forms: [form] });
    expect(tomorrow).toMatchObject({ color: 'blue', label: 'Ждём анкету', hint: 'Ждём, пока пациент заполнит анкету' });
    expect(tomorrow.action).toEqual({ type: 'form_remind', label: 'Повторить анкету', formId: 'F1', ghost: true });
    expect(tomorrow.warnings).toContain('Анкета отправлена 09:00 в WhatsApp');
    const soon = one([rec()], { identity: NO_PASSPORT, forms: [form] });
    expect(soon).toMatchObject({ color: 'red', label: 'Нужно до визита' });
    expect(soon.action.type).toBe('fill');
  });

  test('просроченная анкета — не «ждём», а снова «нужно» с предупреждением', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-17T09:00:00+03:00'), expires_at: at('2026-10-24T09:00:00+03:00') };
    const c = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: NO_PASSPORT, forms: [form] });
    expect(c.color).toBe('amber');
    expect(c.form.status).toBe('expired');
    expect(c.warnings).toContain('Анкета не заполнена — ссылка устарела');
  });

  test('срочная ссылка истекла — «Ссылка истекла», «Отправить снова»; отказ — «Пациент отказался»', () => {
    const exp = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'expired'), doc('consent_pd', 'expired')] });
    expect(exp).toMatchObject({ color: 'red', label: 'Ссылка истекла' });
    expect(exp.action).toMatchObject({ type: 'send', label: 'Отправить снова' });
    expect(exp.tiles.contract).toEqual({ text: 'срок истёк', tone: 'no' });
    expect(one([rec()], { identity: FULL_ID, docs: [doc('contract', 'declined'), doc('consent_pd', 'signed')] }).label).toBe('Пациент отказался');
  });

  test('ошибка F.Doc — «Не ушло в F.Doc» и текст ошибки в предупреждениях', () => {
    const c = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'draft', { last_error: 'F.Doc 400: файл', created_at: at('2026-10-25T08:00:00+03:00') }), doc('consent_pd', 'signed')] });
    expect(c).toMatchObject({ color: 'red', label: 'Не ушло в F.Doc' });
    expect(c.warnings).toContain('Ошибка отправки: F.Doc 400: файл');
  });

  test('пришёл без договора и согласия, акта тоже нет — «Нет договора, согласия и акта», три вида одной отправкой', () => {
    const c = one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID });
    expect(c).toMatchObject({ color: 'red', label: 'Нет договора, согласия и акта' });
    expect(c.action).toEqual({ type: 'send', kinds: ['contract', 'consent_pd', 'act'], recordId: 100, label: 'Отправить 3 док.' });
  });

  test('прошлый день без договора — красный (визит прошёл без документа)', () => {
    const c = one([rec({ visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00'), attendance: '1', paid_full: '1' })],
      { identity: FULL_ID, docs: [doc('act', 'signed', { record_id: 100 })] });
    expect(c).toMatchObject({ color: 'red', label: 'Нет договора и согласия' });
  });

  test('нет ни одного шаблона — серая «Шаблоны не настроены»; нет шаблона акта — акт не учитывается', () => {
    expect(one([rec()], { templates: [] })).toMatchObject({ color: 'grey', label: 'Шаблоны не настроены', action: null });
    const noAct = one([rec({ attendance: '1', paid_full: '1' })], { templates: [T.contract, T.consent], identity: FULL_ID,
      docs: [doc('contract', 'signed'), doc('consent_pd', 'signed')] });
    expect(noAct).toMatchObject({ color: 'green' });
    expect(noAct.tiles.act).toEqual({ text: '—', tone: 'na' });
  });

  test('визит до acts_required_from — акт не требуется', () => {
    const c = one([rec({ visit_date: '2026-09-20', visit_at: at('2026-09-20T11:00:00+03:00'), attendance: '1', paid_full: '1' })],
      { identity: FULL_ID, docs: [doc('contract', 'signed'), doc('consent_pd', 'signed')] });
    expect(c.color).toBe('green');
    expect(c.docs.act).toEqual({ state: 'off', reason: 'before_start' });
  });

  test('две записи в день — одна карточка, худший акт, отправка акта по неподписанной записи', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed'), doc('act', 'signed', { record_id: 100 })];
    const c = one([
      rec({ id: 100, attendance: '1', paid_full: '1', visit_at: at('2026-10-25T09:00:00+03:00'), has_prior_visit: true }),
      rec({ id: 101, attendance: '1', paid_full: '1', visit_at: at('2026-10-25T09:30:00+03:00'), services: [{ title: 'Мезотерапия' }], has_prior_visit: true }),
    ], { identity: FULL_ID, docs });
    expect(c.visits.map((v) => [v.recordId, v.act.state])).toEqual([[100, 'signed'], [101, 'missing']]);
    expect(c).toMatchObject({ color: 'red', label: 'Акт не подписан', time: '09:00', services: ['Биоревитализация', 'Мезотерапия'] });
    expect(c.action).toMatchObject({ kinds: ['act'], recordId: 101 });
  });

  test('автонумерация: номер договора не считается недостающим', () => {
    const noNumber = { ...FULL_ID, contract_no: null };
    expect(one([rec()], { identity: noNumber }).data.complete).toBe(true);
    const c = one([rec()], { identity: noNumber, settings: { actsRequiredFrom: '2026-10-01', autonumber: false } });
    expect(c.data.missing.map((x) => x.key)).toEqual(['contract_no']);
  });

  test('заметка автоматики попадает в предупреждения', () => {
    const notes = [{ client_id: 52, record_id: 100, kind: 'previsit', status: 'failed', reason: 'нет учётки F.Doc', created_at: at('2026-10-25T09:00:00+03:00') }];
    expect(one([rec()], { identity: FULL_ID, notes }).warnings).toContain('Автоматика не отправила: нет учётки F.Doc');
  });
});

describe('периоды и сводка', () => {
  test('границы периодов; «Незакрытые» не раньше acts_required_from', () => {
    expect(b.rangeBounds('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(b.rangeBounds('tomorrow', TODAY)).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(b.rangeBounds('week', TODAY)).toEqual({ from: TODAY, to: '2026-10-31' });
    expect(b.rangeBounds('open', TODAY, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-24' });
    expect(b.rangeBounds('open', TODAY, '2026-01-01')).toEqual({ from: '2026-09-25', to: '2026-10-24' });
    expect(b.windowBounds(TODAY, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  test('срезы, счётчики и чипы', () => {
    const records = [
      rec({ id: 1, client_id: 1, visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00'), attendance: '1', paid_full: '1' }),
      rec({ id: 2, client_id: 2, visit_date: '2026-10-21', visit_at: at('2026-10-21T11:00:00+03:00'), attendance: '1', paid_full: '1' }),
      rec({ id: 3, client_id: 3 }),
      rec({ id: 4, client_id: 4, visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') }),
    ];
    const docs = ['contract', 'consent_pd'].map((k) => doc(k, 'signed', { client_id: 2 })).concat(doc('act', 'signed', { client_id: 2, record_id: 2 }));
    const { cards } = board(records, { docs });
    expect(b.sliceRange(cards, 'open', TODAY, '2026-10-01').map((c) => c.clientId)).toEqual([1]);
    expect(b.sliceRange(cards, 'today', TODAY).map((c) => c.clientId)).toEqual([3]);
    expect(b.rangeCounts(cards, TODAY, '2026-10-01')).toEqual({ today: 1, tomorrow: 1, week: 2, open: 1 });
    const { summary, chips } = b.summarize(b.sliceRange(cards, 'week', TODAY));
    expect(summary).toEqual({ total: 2, red: 1, amber: 1, blue: 0, green: 0, grey: 0 });
    expect(chips).toEqual({ all: 2, no_contract: 2, no_consent: 2, act: 0, waiting: 0, ready: 0 });
  });

  test('порядок: по дню, затем красные → оранжевые → синие → зелёные, затем по времени', () => {
    const records = [
      rec({ id: 1, client_id: 1, visit_at: at('2026-10-25T18:00:00+03:00') }),
      rec({ id: 2, client_id: 2, visit_at: at('2026-10-25T10:30:00+03:00') }),
      rec({ id: 3, client_id: 3, visit_at: at('2026-10-25T09:00:00+03:00'), attendance: '1', paid_full: '0' }),
    ];
    const docs = ['contract', 'consent_pd'].map((k) => doc(k, 'signed', { client_id: 3 }));
    expect(board(records, { docs }).cards.map((c) => [c.clientId, c.color])).toEqual([[2, 'red'], [1, 'amber'], [3, 'green']]);
  });
});

describe('страница пациента', () => {
  const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591' };
  const page = (records, opts = {}) => b.buildClientPage({ client: CLIENT, identity: opts.identity || null, records, docs: opts.docs || [],
    templates: opts.templates || TEMPLATES, requisites: {}, forms: opts.forms || [], notes: [], settings: { actsRequiredFrom: '2026-10-01', autonumber: true },
    nowMs: NOW, today: TODAY, focusRecordId: opts.focus || null });

  test('сегодняшний визит без документов и данных: шапка красная, шаги, недостающие и обязательные поля', () => {
    const p = page([rec()]);
    expect(p.client).toEqual({ id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', initials: 'ИА' });
    expect(p.header).toMatchObject({ color: 'red', label: 'Нужно до визита', day: TODAY, time: '10:40', firstVisit: true });
    expect(p.header.steps).toEqual([{ key: 'data', tone: 'no' }, { key: 'contract', tone: 'no' }, { key: 'consent_pd', tone: 'no' }, { key: 'act', tone: 'none' }]);
    expect(p.data.complete).toBe(false);
    expect(p.data.missing.map((x) => x.key)).toEqual(['address', 'first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
    expect(p.data.required.sort()).toEqual(['address', 'first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
    expect(p.docs.contract).toMatchObject({ state: 'missing', tile: { text: 'нет', tone: 'no' } });
    expect(p.visits.map((v) => [v.recordId, v.day, v.act.state])).toEqual([[100, TODAY, 'later']]);
    expect(p.focusRecordId).toBeNull();
    expect(p.kinds.contract).toEqual({ id: 5, title: 'Договор' });
  });

  test('оплаченный визит без акта: он в фокусе, шаг «Акт» красный, данные считаются и для акта', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed')];
    const p = page([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { docs, identity: FULL_ID });
    expect(p.focusRecordId).toBe(100);
    expect(p.header).toMatchObject({ color: 'red', label: 'Акт не подписан' });
    expect(p.header.steps.map((s) => s.tone)).toEqual(['ok', 'ok', 'ok', 'no']);
    expect(p.data.complete).toBe(true);
  });

  test('визитов в окне нет: шапка по документам; выбранный визит из адреса', () => {
    expect(page([]).header).toMatchObject({ color: 'amber', label: 'Нет договора и согласия', day: null });
    expect(page([], { docs: [doc('contract', 'signed'), doc('consent_pd', 'sent')] }).header).toMatchObject({ color: 'blue', label: 'Ждём подпись' });
    const recs = [
      rec({ id: 100, attendance: '1', paid_full: '1', visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00') }),
      rec({ id: 101, attendance: '1', paid_full: '1', visit_date: '2026-10-22', visit_at: at('2026-10-22T11:00:00+03:00') }),
    ];
    expect(page(recs).focusRecordId).toBe(101);
    expect(page(recs, { focus: 100 }).focusRecordId).toBe(100);
    expect(page(recs).visits.map((v) => v.recordId)).toEqual([101, 100]);
  });

  test('анкета: просроченная активная показывается как expired', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-10T09:00:00+03:00'), expires_at: at('2026-10-17T09:00:00+03:00') };
    expect(page([], { forms: [form] }).form).toMatchObject({ id: 'F1', status: 'expired' });
  });
});
