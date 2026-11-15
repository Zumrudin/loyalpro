'use strict';
// Immutable, allow-listed audit snapshot captured when a local-first package is
// accepted. It deliberately contains no phone, raw record or upstream payload.
const m = require('./model');

const STATUS = { '-1': 'Не пришёл', 0: 'Ожидание', 1: 'Пришёл', 2: 'Подтвердил' };
const rub = v => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(v) || 0)} ₽`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const change = (field, label, from, to) => same(from, to) ? null : { field, label, from: from ?? null, to: to ?? null };
const compact = list => list.filter(Boolean);
const dateTime = v => {
  const p = m.moscowParts(v);
  if (!p) return null;
  const local = new Date(p.ms + 3 * 3600000).toISOString();
  return `${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} ${local.slice(11, 19)}`;
};
const duration = v => Number(v) >= 0 ? `${Math.round(Number(v) / 60)} мин` : null;
const labels = v => (Array.isArray(v) ? v : []).map(x => String(x?.title || x?.name || x?.id || x)).sort().join(', ') || null;
const services = v => (Array.isArray(v) ? v : []).map(s => {
  const qty = Number(s.amount) || 1;
  const unit = Number(s.cost_per_unit);
  const total = Number(s.cost) || 0;
  const discount = Number(s.discount) || 0;
  return `${String(s.title || 'Услуга')} ×${qty}`
    + (Number.isFinite(unit) ? `, ${rub(unit)} за ед.` : '')
    + (discount ? `, скидка ${discount}%` : '') + `, итого ${rub(total)}`;
}).sort().join('; ') || null;
const serviceSummary = record => {
  const list = Array.isArray(record?.services) ? record.services : [];
  let total = 0, gross = 0;
  for (const s of list) {
    const qty = Number(s.amount) || 1;
    const net = Number(s.cost) || 0;
    const first = Number(s.first_cost);
    const unit = Number(s.cost_per_unit);
    const before = Number.isFinite(first) && first > 0 ? first : Number.isFinite(unit) ? unit * qty : net;
    total += net; gross += Math.max(net, before);
  }
  return { total, discount: Math.max(0, gross - total) };
};
const read = {
  datetime: r => dateTime(r?.datetime),
  staff: r => r?.staff?.name && Number(r.staff.id) === Number(r.staff_id) ? String(r.staff.name) : r?.staff_id != null ? `#${Number(r.staff_id)}` : null,
  services: r => services(r?.services),
  total: r => rub(serviceSummary(r).total),
  discount: r => rub(serviceSummary(r).discount),
  duration: r => duration(r?.seance_length),
  technical_break: r => duration(r?.technical_break_duration || 0),
  attendance: r => STATUS[Number(r?.attendance) || 0] || null,
  comment: r => String(r?.comment || '').trim() || null,
  client: r => String(r?.client?.name || '').trim() || null,
  color: r => String(r?.custom_color || '').replace(/^#/, '') || null,
  labels: r => labels(r?.record_labels),
  notify: r => r?.notify_client === false ? 'выключены' : r?.notify_client === true ? 'включены' : null,
  deleted: r => r?.deleted ? 'да' : 'нет',
};
const FIELD = {
  datetime: ['Время', read.datetime], staff: ['Специалист', read.staff], services: ['Услуги, количество, цена и скидка', read.services],
  total: ['Итог визита', read.total], discount: ['Скидка', read.discount], duration: ['Длительность', read.duration],
  technical_break: ['Технический перерыв', read.technical_break], attendance: ['Статус', read.attendance], comment: ['Комментарий', read.comment],
  client: ['Клиент', read.client], color: ['Цвет', read.color], labels: ['Метки', read.labels], notify: ['Уведомления клиенту', read.notify], deleted: ['Удалена', read.deleted],
};
function fields(before, after, names, includeUnchanged = false) {
  return compact(names.map(field => {
    const [label, fn] = FIELD[field];
    const from = before ? fn(before) : null, to = fn(after);
    return includeUnchanged ? { field, label, from, to } : change(field, label, from, to);
  }));
}
function recordAfter(before, overlay, session) {
  if (overlay.kind === 'create') {
    const quoted = session?.create?.lines;
    const recordServices = (overlay.services || []).map(s => {
      const line = Array.isArray(quoted) ? quoted.find(x => Number(x.serviceId) === Number(s.id)) : null;
      return line ? { ...s, amount: line.quantity, cost_per_unit: line.unitPrice, first_cost: line.gross,
        discount: line.discount, cost: line.total } : s;
    });
    return {
    datetime: `${overlay.date}T${overlay.time}:00+03:00`, staff_id: overlay.staffId,
    services: recordServices, seance_length: Number(overlay.duration) * 60,
    attendance: overlay.attendance ?? 0, comment: overlay.comment || '', client: { name: overlay.client?.name || '' },
    notify_client: session?.create?.notifyClient !== false,
    };
  }
  const after = { ...(before || {}), ...(overlay.patch || {}) };
  if (overlay.patch?.cancel || session.status === 'cancel') after.attendance = -1;
  if (session.status === 'delete') after.deleted = true;
  return after;
}
const paymentDetails = (p, extra = {}) => ({ method: p.method, methodId: Number(p.methodId), amount: Number(p.amount),
  ...(p.methodTitle ? { methodTitle: String(p.methodTitle) } : {}), ...extra });
const paymentEvent = (action, p, extra = {}) => {
  const bonus = p.method === 'loyalty_card';
  const removing = action !== 'payment';
  const label = bonus ? (removing ? 'Возврат бонусов' : 'Списание бонусов') : (removing ? 'Удаление оплаты' : 'Оплата');
  return { action, changes: [{ field: bonus ? 'bonus_payment' : 'payment', label,
    from: removing ? rub(p.amount) : null, to: removing ? 'удалена' : rub(p.amount) }], details: paymentDetails(p, extra) };
};
function build({ session, overlay, beforeRecord, droppedPayments = [], accounts = [], steps = [] }) {
  const after = recordAfter(beforeRecord, overlay, session), events = [];
  const used = new Set();
  const stepFor = (kind, predicate = () => true) => {
    const found = (steps || []).find(s => s && !used.has(s) && s.kind === kind && predicate(s.params || {}));
    if (found) used.add(found);
    return found?.opId ? String(found.opId) : null;
  };
  const withStep = (event, opId) => opId ? { ...event, details: { ...(event.details || {}), stepOpId: opId } } : event;
  const titled = p => ({ ...p, methodTitle: p.method === 'loyalty_card' ? 'Бонусы'
    : String(accounts.find(a => Number(a.id) === Number(p.methodId))?.title || `Касса #${Number(p.methodId)}`) });
  if (session.create) events.push(withStep({ action: 'create', changes: fields(null, after,
    ['datetime', 'staff', 'services', 'total', 'discount', 'duration', 'attendance', 'comment', 'client', 'notify'], true) }, stepFor('create')));
  if (session.move) events.push(withStep({ action: 'move', changes: fields(beforeRecord, after, ['datetime', 'staff', 'duration', 'technical_break']) }, stepFor('move')));
  if (session.edit) {
    const selected = [];
    if (session.edit.attendance !== undefined) selected.push('attendance');
    if (session.edit.lines) selected.push('services', 'total', 'discount');
    if (session.edit.comment !== undefined) selected.push('comment');
    if (session.edit.seanceLength !== undefined) selected.push('duration');
    if (session.edit.client) selected.push('client');
    if (session.edit.customColor !== undefined) selected.push('color');
    if (session.edit.labelIds !== undefined) selected.push('labels');
    if (session.edit.technicalBreak !== undefined) selected.push('technical_break');
    if (session.edit.notifyClient !== undefined) selected.push('notify');
    const changes = fields(beforeRecord, after, selected);
    // A client can be replaced with another card carrying the same display
    // name. Record the fact without retaining either phone number.
    if (session.edit.client && !changes.some(c => c.field === 'client')) changes.push({ field: 'client', label: 'Клиент',
      from: read.client(beforeRecord), to: 'карточка клиента заменена (имя без изменений)' });
    if (changes.length) events.push(withStep({ action: 'edit', changes }, stepFor('edit')));
  }
  if (session.status) {
    const names = session.status === 'delete' ? ['deleted'] : ['attendance'];
    events.push(withStep({ action: session.status, changes: fields(beforeRecord, after, names, true) }, stepFor(session.status)));
  }
  if ((session.payments || []).some(p => p.confirmArrival) && Number(beforeRecord?.attendance) === 0 && Number(after.attendance) === 1) {
    const arrival = (steps || []).find(s => s?.kind === 'pay' && s.params?.confirmArrival === true);
    events.push(withStep({ action: 'edit', changes: fields(beforeRecord, after, ['attendance']) }, arrival?.opId));
  }
  const ordered = [...(session.payments || []).filter(p => p.method === 'loyalty_card'), ...(session.payments || []).filter(p => p.method === 'account')];
  for (const p of ordered) {
    const opId = stepFor('pay', x => x.method === p.method && Number(x.methodId) === Number(p.methodId) && Number(x.amount) === Number(p.amount));
    events.push(withStep(paymentEvent('payment', titled(p)), opId));
  }
  for (const p of session.removePayments || []) {
    const opId = stepFor('remove_payment', x => Number(x.transactionId) === Number(p.transactionId) && x.method === p.method);
    events.push(withStep(paymentEvent('remove_payment', titled(p), { transactionId: Number(p.transactionId) }), opId));
  }
  for (const p of droppedPayments) events.push(paymentEvent('drop_payment', titled(p), { outboxId: Number(p.outboxId), opId: String(p.opId), stepOpId: String(p.opId) }));
  return { version: 1, events };
}
function attach(overlay, draft, actor) {
  return { ...overlay, audit: { ...draft, actor: { userId: actor.userId ?? null, name: String(actor.name || 'Неизвестный сотрудник') } } };
}
// Compatibility routes still write straight through to YClients. Persist the
// same allow-listed shape in journal_operations.result, while callers continue
// receiving the original result without this private field.
function direct(draft, body, beforeRecord) {
  let session, overlay;
  if (draft.action === 'create') {
    const p = m.moscowParts(body.datetime);
    session = { create: { lines: draft.lines || [], notifyClient: draft.notifyClient }, payments: [], removePayments: [] };
    overlay = { kind: 'create', date: p?.date, time: p?.time, staffId: body.staff_id,
      duration: Number(body.seance_length) / 60, services: body.services || [], client: { name: body.client?.name || '' },
      comment: body.comment || '', attendance: body.attendance || 0 };
  } else if (draft.action === 'move') {
    session = { move: { date: draft.date, time: draft.time, staffId: draft.staffId }, payments: [], removePayments: [] };
    overlay = { kind: 'patch', patch: { datetime: body.datetime, staff_id: body.staff_id, seance_length: body.seance_length,
      ...(body.technical_break_duration !== undefined ? { technical_break_duration: body.technical_break_duration } : {}) } };
  } else if (draft.action === 'edit') {
    session = { edit: draft.edit, payments: [], removePayments: [] };
    overlay = { kind: 'patch', patch: body };
  } else {
    session = { status: draft.action, payments: [], removePayments: [] };
    overlay = { kind: 'patch', patch: draft.action === 'delete' ? { deleted: true }
      : { attendance: draft.action === 'confirm' ? 2 : -1 } };
  }
  return build({ session, overlay, beforeRecord });
}
module.exports = { build, attach, direct, recordAfter, services, serviceSummary };
