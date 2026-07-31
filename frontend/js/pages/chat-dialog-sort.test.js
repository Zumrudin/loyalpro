const { test } = require('node:test');
const assert = require('node:assert');
const { chatIsEscalated, chatSortDialogs } = require('./chat-dialog-sort');

const d = (key, lastTs, agentStatus) => ({ key, lastTs, agentStatus });
const keys = (list) => chatSortDialogs(list).map(x => x.key);

test('эскалированные диалоги идут перед обычными', () => {
  // У обычного диалога сообщение свежее — он всё равно ниже красного.
  assert.deepStrictEqual(
    keys([d('обычный', 200, 'bot'), d('красный', 100, 'escalated')]),
    ['красный', 'обычный']);
});

test('внутри каждой группы — по свежести сообщения', () => {
  assert.deepStrictEqual(
    keys([
      d('крас-старый', 10, 'escalated'),
      d('об-старый', 20, 'bot'),
      d('крас-новый', 30, 'escalated'),
      d('об-новый', 40, 'bot'),
    ]),
    ['крас-новый', 'крас-старый', 'об-новый', 'об-старый']);
});

test('возврат боту опускает диалог на место по времени', () => {
  const list = [d('a', 100, 'escalated'), d('b', 200, 'bot'), d('c', 150, 'bot')];
  assert.deepStrictEqual(keys(list), ['a', 'b', 'c']);
  list[0].agentStatus = 'bot';
  assert.deepStrictEqual(keys(list), ['b', 'c', 'a']);
});

test('ручная пауза оператора тоже красная (любой escalated)', () => {
  const list = [d('обычный', 300, 'bot'),
    { key: 'пауза', lastTs: 100, agentStatus: 'escalated', escalatedReason: 'operator_reply' }];
  assert.strictEqual(chatIsEscalated(list[1]), true);
  assert.deepStrictEqual(keys(list), ['пауза', 'обычный']);
});

test('closed и отсутствующий статус — не красные', () => {
  assert.strictEqual(chatIsEscalated({ agentStatus: 'closed' }), false);
  assert.strictEqual(chatIsEscalated({ agentStatus: 'bot' }), false);
  assert.strictEqual(chatIsEscalated({}), false);
  assert.strictEqual(chatIsEscalated(null), false);
});

test('исходный массив не мутируется, пустой список безопасен', () => {
  const list = [d('a', 100, 'bot'), d('b', 200, 'escalated')];
  chatSortDialogs(list);
  assert.deepStrictEqual(list.map(x => x.key), ['a', 'b']);
  assert.deepStrictEqual(chatSortDialogs([]), []);
});

test('битые/отсутствующие lastTs не ломают порядок', () => {
  assert.deepStrictEqual(
    keys([d('без-времени', null, 'bot'), d('со-временем', 5, 'bot')]),
    ['со-временем', 'без-времени']);
});
