'use strict';
const { anonymizer, buildCases, testBookingArgs } = require('./scripts/mila-codex-production-replay');

test('booking always uses the authorized number and preserves its existing card name', () => {
  const phone = '7' + '0'.repeat(10);
  const result = testBookingArgs({ client_phone: '7' + '1'.repeat(10), client_name: 'Чужое имя',
    datetime: '2026-10-01T18:00:00+03:00', staff_yc_id: 1 }, phone, 'Тестовый Владелец');
  expect(result).toMatchObject({ client_phone: phone, client_name: 'Тестовый Владелец', staff_yc_id: 1 });
  expect(() => testBookingArgs({}, '', 'Тест')).toThrow('EVAL_TEST_CLIENT_REQUIRED');
});

test('anonymizes names, contacts, handles and links before replay', () => {
  const clean = anonymizer(['Тестовая Анна']);
  const phone = '7' + '0'.repeat(10);
  expect(clean(`Анна, ${phone}, sample@example.test, @sample_name, https://example.test/private`))
    .toBe('[клиент], [номер скрыт], [email скрыт], [аккаунт скрыт], [ссылка скрыта]');
  expect(clean('Стоимость 6500 ₽, завтра в 18:30')).toBe('Стоимость 6500 ₽, завтра в 18:30');
});

test('uses only preceding history, merges a debounce burst, counts media', () => {
  const row = (id, msg_ts, direction, text, extra = {}) => ({
    id, msg_ts, direction, text, dialog_key: 'synthetic', msg_type: 'text', ...extra,
  });
  const rows = [row(1, 90, 'outgoing', 'Контекст', { authored_by: 'operator' }),
    row(2, 101, 'incoming', 'Добрый день'), row(3, 104, 'incoming', 'Сколько стоит?'),
    row(4, 110, 'outgoing', 'Будущий ответ', { authored_by: 'agent' }),
    row(5, 120, 'incoming', 'Спасибо'), row(6, 121, 'incoming', '', { msg_type: 'messagePhoto' })];
  const result = buildCases(rows, 100, 200, x => x);
  expect(result.metadata).toMatchObject({ inputCount: 3, mediaSkipped: 1, turns: 2 });
  expect(result.cases[0].question).toBe('Добрый день\nСколько стоит?');
  expect(JSON.stringify(result.cases[0].messages)).not.toContain('Будущий ответ');
  expect(result.cases[1].messages.some(m => m.content === 'Будущий ответ')).toBe(true);
  expect(result.cases[0].messages[0].content).toContain('[сообщение администратора клиники]');
  expect(result.cases[0].lastOutgoing).toEqual({ author: 'operator', text: 'Контекст' });
  expect(result.cases[1].lastOutgoing).toEqual({ author: 'agent', text: 'Будущий ответ' });
});

test('excludes inputs outside the exact day and separates dialogs', () => {
  const rows = [
    { dialog_key: 'A', msg_ts: 99, direction: 'incoming', msg_type: 'text', text: 'До дня' },
    { dialog_key: 'A', msg_ts: 100, direction: 'incoming', msg_type: 'text', text: 'Первый' },
    { dialog_key: 'B', msg_ts: 199, direction: 'incoming', msg_type: 'text', text: 'Второй' },
    { dialog_key: 'B', msg_ts: 200, direction: 'incoming', msg_type: 'text', text: 'После дня' },
  ];
  const result = buildCases(rows, 100, 200, x => x);
  expect(result.cases).toHaveLength(2);
  expect(result.cases[0].dialog).not.toBe(result.cases[1].dialog);
  expect(JSON.stringify(result.cases[1].messages)).not.toContain('Первый');
  expect(result.metadata.inputCount).toBe(2);
});
