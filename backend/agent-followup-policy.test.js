'use strict';
const queue = require('./services/agent/followup-queue');
const incoming = (text, msg_ts = 1000) => ({ direction: 'incoming', text, msg_ts });
const outgoing = (text, msg_ts = 1010) => ({ direction: 'outgoing', authored_by: 'agent', text, msg_ts });
// Invented wording, same structure as the observed incident: no CRM write,
// patient is unavailable, assistant asks a clarification, patient is silent.
const sickExchange = () => [
  incoming('Простудилась и не смогу приехать. Снимите мою запись, пожалуйста.'),
  outgoing('Уточните, пожалуйста, какую запись отменить?'),
];

test('illness cancellation request must not start a followup before CRM cancellation', async () => {
  const db = { any: async () => sickExchange().reverse(), query: jest.fn(async () => ({ rowCount: 1 })) };
  expect(await queue.schedule(17, 'synthetic-dialog', {}, {
    followupDelay1Min: 20, followupDelay2Min: 60,
  }, { db })).toBe(false);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO agent_followups/.test(sql))).toBe(false);
  expect(db.query.mock.calls[0][1]).toEqual([17, 'synthetic-dialog', 'cancelled', 'client_unavailable']);
});

const policy = require('./services/agent/followup-policy');
test.each([
  'Заболела. Отмените запись.',
  'Болею, не приду.',
  'Приболел, не смогу к вам приехать.',
  'У меня температура, не получится прийти.',
  'Простудился. Сам вам напишу.',
])('unavailable patient is not nudged: %s', text => {
  expect(policy.stopReason([incoming(text)])).toBe('client_unavailable');
});
test.each([
  'Я не заболела, отмените запись по другой причине.',
  'Если заболела, можно отменить запись?',
  'Болит спина, хочу записаться.',
  'Какая температура в кабинете?',
  'Может ли после процедуры подняться температура?',
  'Отмените запись, поменялись планы.',
  'Я выздоровела, запишите меня на пятницу.',
])('does not infer illness unavailability from unrelated context: %s', text => {
  expect(policy.stopReason([incoming(text)])).toBe(null);
});
test('combines illness and cancellation across a short incoming burst', () => {
  expect(policy.stopReason([
    incoming('Заболела'), incoming('Отмените запись', 1030), outgoing('Уточните время?', 1040),
  ])).toBe('client_unavailable');
});
test('does not combine unrelated illness and cancellation days apart', () => {
  expect(policy.stopReason([incoming('Болею'), incoming('Отмените запись', 1000 + 86400)])).toBe(null);
});
test('thanks, an agent suggestion and a CRM notification do not restart reminders', () => {
  const rows = sickExchange();
  rows.push(incoming('Спасибо!', 1050), outgoing('Может быть, выберем другую дату?', 1060),
    { direction: 'outgoing', authored_by: 'system', text: 'Запись отменена.', msg_ts: 1070 });
  expect(policy.stopReason(rows)).toBe('client_unavailable');
});
test('a new informational question does not automatically end the pause', () => {
  expect(policy.stopReason([...sickExchange(), incoming('А сколько стоит другая услуга?', 2000)]))
    .toBe('client_unavailable');
});
test.each([
  'Я выздоровела. Запишите меня на следующую неделю.',
  'Хочу снова записаться.',
  'Подберите время на четверг.',
])('explicit new booking request resumes normal followup rules: %s', text => {
  expect(policy.stopReason([...sickExchange(), incoming(text, 2000), outgoing('Какое время удобнее?', 2010)]))
    .toBe(null);
});
test.each([
  'Когда выздоровею, запишите меня.',
  'Пока не хочу записаться.',
  'Если станет лучше, запишите меня.',
  'Ещё болею, запишите меня потом.',
])('conditional future booking does not restart reminders: %s', text => {
  expect(policy.stopReason([...sickExchange(), incoming(text, 2000)])).toBe('client_unavailable');
});
test('assistant illness text alone cannot put the patient on pause', () => {
  expect(policy.stopReason([incoming('Спасибо'), outgoing('Если заболеете, отмените запись.')])).toBe(null);
});
test('policy read is tenant-scoped and propagates DB failures to the safe caller', async () => {
  const db = { any: jest.fn(async (sql, params) => params[0] === 17 ? sickExchange().reverse() : []) };
  expect(await policy.loadStopReason(db, 17, 'synthetic-dialog')).toBe('client_unavailable');
  expect(await policy.loadStopReason(db, 18, 'synthetic-dialog')).toBe(null);
  expect(db.any.mock.calls[0][0]).toContain('salon_id=$1');
  expect(db.any.mock.calls[0][1]).toEqual([17, 'synthetic-dialog']);
  await expect(policy.loadStopReason({ any: async () => { throw new Error('unavailable'); } }, 17, 'k'))
    .rejects.toThrow('unavailable');
});
