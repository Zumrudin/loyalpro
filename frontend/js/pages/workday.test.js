'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wdTodayMsk, wdRecordView, wdSummarize, wdEscalated, wdReasonText, wdFmtAgo } = require('./workday.js');

test('сегодня считается по Москве, а не по часам устройства', () => {
  // 21:30 UTC 06.11 = 00:30 МСК 07.11
  assert.equal(wdTodayMsk(new Date('2026-11-06T21:30:00Z')), '2026-11-07');
});

test('статус записи — правило страницы «Записи»: пришёл + оплачен = оказана', () => {
  const v = wdRecordView({ id: 1, status: 'arrived', is_paid_full: true, visit_datetime: '2026-11-06T09:00:00Z',
    client_name: 'Анна', services: '[{"title":"Чистка"}]', staff: [{ name: 'Юлия' }] });
  assert.equal(v.status, 'completed'); assert.equal(v.label, 'Оказана'); assert.equal(v.bucket, 'came');
  assert.equal(v.time, '12:00'); assert.equal(v.services, 'Чистка'); assert.equal(v.staff, 'Юлия');
  assert.equal(wdRecordView({ status: 'arrived' }).status, 'arrived');
  assert.equal(wdRecordView({ yclients_status: 'no_show', status: 'pending' }).bucket, 'lost');
  assert.equal(wdRecordView({}).bucket, 'expected');          // без статуса — ожидание
  assert.equal(wdRecordView({ services: 'не json' }).services, '—');
});

test('сводка не считает удалённые записи', () => {
  const s = wdSummarize(['completed', 'arrived', 'confirmed', 'waiting', 'cancelled', 'no_show', 'deleted']
    .map(status => wdRecordView({ status })));
  assert.deepEqual(s, { total: 6, came: 2, expected: 2, lost: 2 });
});

test('ждут человека — только эскалированные личные диалоги', () => {
  const list = wdEscalated([{ key: 'a', agentStatus: 'escalated' }, { key: 'b', agentStatus: 'bot' },
    { key: 'g', agentStatus: 'escalated', isGroup: true }, null]);
  assert.deepEqual(list.map(x => x.key), ['a']);
  assert.deepEqual(wdEscalated(undefined), []);
});

test('причина передачи и давность — человеческим языком', () => {
  assert.equal(wdReasonText('operator_reply'), 'администратор ответил сам');
  assert.equal(wdReasonText(null), 'передан администратору');
  const now = new Date('2026-11-06T12:00:00Z');
  assert.equal(wdFmtAgo('2026-11-06T11:45:00Z', now), '15 мин назад');
  assert.equal(wdFmtAgo('2026-11-06T09:00:00Z', now), '3 ч назад');
  assert.equal(wdFmtAgo('мусор', now), '');
});
