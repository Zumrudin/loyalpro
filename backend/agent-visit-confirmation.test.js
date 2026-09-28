'use strict';
const { conversationComplete, loadConversationComplete } = require('./services/agent/visit-confirmation');
const queue = require('./services/agent/followup-queue');
function exchange() {
  return [
    { direction: 'outgoing', authored_by: 'system', text: 'Напоминаем о записи. Для подтверждения отправьте +.', msg_ts: 1000 },
    { direction: 'incoming', text: '+', msg_ts: 1020 },
    { direction: 'outgoing', authored_by: 'system', text: 'Ваша запись подтверждена. Спасибо!', msg_ts: 1030 },
    { direction: 'outgoing', authored_by: 'agent', text: 'Ждём вас завтра!', msg_ts: 1040 },
  ];
}

test('system confirmation plus agent closing completes the exchange', () => {
  expect(conversationComplete(exchange())).toBe(true);
});
test.each(['Да, а как подготовиться?', 'Перенесите запись', 'Хочу ещё записаться', 'Спасибо, во сколько?', ''])('substantive/unknown reply stays active: %s', text => {
  const rows = exchange(); rows[1].text = text;
  expect(conversationComplete(rows)).toBe(false);
});
test('a new topic after confirmation reopens conversation', () => {
  expect(conversationComplete([...exchange(), { direction: 'incoming', text: 'Расскажите о другой услуге', msg_ts: 1050 }])).toBe(false);
});
test('a pure yes must not swallow an earlier question in the same burst', () => {
  const rows = exchange(); rows.splice(1, 0, { direction: 'incoming', text: 'Можно перенести?', msg_ts: 1010 });
  expect(conversationComplete(rows)).toBe(false);
});
test.each(['agent', 'operator', null])('acknowledgement must be system-authored, not %s', authored_by => {
  const rows = exchange(); rows[2].authored_by = authored_by;
  expect(conversationComplete(rows)).toBe(false);
});
test.each(['Ваша запись не подтверждена.', 'Запись подтверждена?', 'Не удалось: запись подтверждена неверно.'])('negative/uncertain acknowledgement does not close: %s', text => {
  const rows = exchange(); rows[2].text = text;
  expect(conversationComplete(rows)).toBe(false);
});
test('missing, stale or preceding acknowledgement cannot complete a new reply', () => {
  const rows = exchange();
  expect(conversationComplete(rows.filter((_, i) => i !== 2))).toBe(false);
  rows[2].msg_ts = 999;
  expect(conversationComplete(rows)).toBe(false);
  rows[2].msg_ts = 9000;
  expect(conversationComplete(rows)).toBe(false);
});
test('a promotional message or agent question is not a visit reminder', () => {
  const rows = exchange(); rows[0].text = 'Хотите узнать об акции? Отправьте +';
  expect(conversationComplete(rows)).toBe(false);
  rows[0] = { ...exchange()[0], authored_by: 'agent' };
  expect(conversationComplete(rows)).toBe(false);
});
test('an intervening agent question prevents closing the exchange', () => {
  const rows = exchange(); rows.splice(1, 0, { direction: 'outgoing', authored_by: 'agent', text: 'Подтверждаете перенос?', msg_ts: 1010 });
  expect(conversationComplete(rows)).toBe(false);
});
test('duplicate system acknowledgement is harmless', () => {
  const rows = exchange(); rows.push({ ...rows[2], msg_ts: 1045 });
  expect(conversationComplete(rows)).toBe(true);
});
test('reader scopes the same dialog key to the supplied salon', async () => {
  const db = { any: jest.fn(async (sql, params) => params[0] === 17 ? exchange().reverse() : []) };
  expect(await loadConversationComplete(db, 17, 'synthetic-dialog')).toBe(true);
  expect(await loadConversationComplete(db, 18, 'synthetic-dialog')).toBe(false);
  expect(db.any.mock.calls[0][0]).toContain('salon_id=$1');
  expect(db.any.mock.calls[0][1]).toEqual([17, 'synthetic-dialog']);
});
test('regression: delivered closing does not create another waiting cycle', async () => {
  const db = { any: async () => exchange().reverse(), query: jest.fn(async () => ({ rowCount: 1 })) };
  expect(await queue.schedule(17, 'synthetic-dialog', {}, { followupDelay1Min: 20, followupDelay2Min: 60 }, { db })).toBe(false);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls[0][0]).toContain('UPDATE agent_followups');
  expect(db.query.mock.calls[0][1]).toEqual([17, 'synthetic-dialog', 'cancelled', 'visit_confirmed']);
  expect(queue.shouldAwaitReply({ delivered: true, conversationComplete: true })).toBe(false);
});
test('failed context read does not schedule a speculative followup', async () => {
  const db = { any: async () => { throw new Error('test failure'); }, query: jest.fn() };
  expect(await queue.schedule(17, 'synthetic-dialog', {}, { followupDelay1Min: 20, followupDelay2Min: 60 }, { db })).toBe(false);
  expect(db.query).not.toHaveBeenCalled();
});


test('a patient may confirm hours after the reminder, but not weeks later', () => {
  const rows = exchange();
  rows.slice(1).forEach(r => { r.msg_ts += 6 * 3600; });
  expect(conversationComplete(rows)).toBe(true);
  rows.slice(1).forEach(r => { r.msg_ts += 49 * 3600; });
  expect(conversationComplete(rows)).toBe(false);
});

// Scenarios derived from the day's message shapes, with invented wording.
test.each([
  'Добрый вечер! Подтверждаю запись, спасибо!',
  'Доброе утро! Я обязательно приду.',
  'Здравствуйте! Дааа!',
  'Добрый день! Потверждаю визит.',
  'Подверждаю прием, спасибо!',
])('polite confirmation remains terminal: %s', text => {
  const rows = exchange(); rows[1].text = text;
  expect(conversationComplete(rows)).toBe(true);
});
test.each([
  'Добрый вечер! Да, но можно позже?',
  'Здравствуйте! Не приду.',
  'Доброе утро, подтверждаю, перенесите на другой день',
  'Спасибо, да. Расскажите про подготовку',
  'Да, запишите ещё на другую услугу',
  'Да? Подтверждаю?',
  'Здравствуйте!',
  'Спасибо!',
  'Буду думать',
])('politeness must not hide a new request or uncertainty: %s', text => {
  const rows = exchange(); rows[1].text = text;
  expect(conversationComplete(rows)).toBe(false);
});
