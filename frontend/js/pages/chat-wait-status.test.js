const { test } = require('node:test');
const assert = require('node:assert');
const { chatWaitStatus, chatWaitMatches, CHAT_WAIT_FILTERS } = require('./chat-wait-status');

test('оператор перекрывает любой статус ожидания', () => {
  const d = { agentStatus: 'escalated', followupStatus: 'scheduled', followupStage: 1 };
  const st = chatWaitStatus(d);
  assert.strictEqual(st.key, 'operator');
  assert.strictEqual(st.label, '👤 Оператор');
});

test('scheduled, stage 0 → «ждём ответа»', () => {
  const st = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 });
  assert.strictEqual(st.key, 'waiting');
});

test('scheduled, stage null трактуется как 0 → «ждём ответа»', () => {
  const st = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: null });
  assert.strictEqual(st.key, 'waiting');
});

test('scheduled, stage >= 1 → «напомнили»', () => {
  const st1 = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 1 });
  assert.strictEqual(st1.key, 'nudged');
  const st2 = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 2 });
  assert.strictEqual(st2.key, 'nudged');
});

test('done → «не ответил»', () => {
  const st = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'done' });
  assert.strictEqual(st.key, 'no_response');
});

test('expired → «не напомнили»', () => {
  const st = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'expired' });
  assert.strictEqual(st.key, 'expired');
});

test('answered / cancelled / failed / без строки / пустой d — чипа нет', () => {
  assert.strictEqual(chatWaitStatus({ agentStatus: 'bot', followupStatus: 'answered' }), null);
  assert.strictEqual(chatWaitStatus({ agentStatus: 'bot', followupStatus: 'cancelled' }), null);
  assert.strictEqual(chatWaitStatus({ agentStatus: 'bot', followupStatus: 'failed' }), null);
  assert.strictEqual(chatWaitStatus({ agentStatus: 'bot', followupStatus: null }), null);
  assert.strictEqual(chatWaitStatus({}), null);
  assert.strictEqual(chatWaitStatus(null), null);
  assert.strictEqual(chatWaitStatus(undefined), null);
});

test('каждый чип несёт title (подсказку)', () => {
  const cases = [
    { agentStatus: 'escalated' },
    { agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 },
    { agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 1 },
    { agentStatus: 'bot', followupStatus: 'done' },
    { agentStatus: 'bot', followupStatus: 'expired' },
  ];
  for (const d of cases) {
    const st = chatWaitStatus(d);
    assert.ok(st.title && st.title.length > 0, JSON.stringify(d));
    assert.ok(st.cls && st.cls.length > 0, JSON.stringify(d));
  }
});

test('chatWaitMatches: waiting ловит обе стадии ожидания', () => {
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 }, 'waiting'), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 1 }, 'waiting'), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'done' }, 'waiting'), false);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'escalated' }, 'waiting'), false);
});

test('chatWaitMatches: operator — только оператор', () => {
  assert.strictEqual(chatWaitMatches({ agentStatus: 'escalated' }, 'operator'), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 }, 'operator'), false);
  assert.strictEqual(chatWaitMatches({}, 'operator'), false);
});

test('chatWaitMatches: no_response ловит и no_response, и expired', () => {
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'done' }, 'no_response'), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'expired' }, 'no_response'), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 }, 'no_response'), false);
});

test('chatWaitMatches: all и незнакомый фильтр не фильтруют', () => {
  const anyDialog = { agentStatus: 'bot', followupStatus: 'answered' };
  assert.strictEqual(chatWaitMatches(anyDialog, 'all'), true);
  assert.strictEqual(chatWaitMatches(anyDialog, 'garbage'), true);
  assert.strictEqual(chatWaitMatches(anyDialog, undefined), true);
  assert.strictEqual(chatWaitMatches(anyDialog, null), true);
  assert.strictEqual(chatWaitMatches({ agentStatus: 'escalated' }, 'garbage'), true);
});

test('CHAT_WAIT_FILTERS — порядок all, waiting, operator, no_response', () => {
  assert.deepStrictEqual(CHAT_WAIT_FILTERS.map(f => f.key),
    ['all', 'waiting', 'operator', 'no_response']);
  for (const f of CHAT_WAIT_FILTERS) {
    assert.ok(typeof f.label === 'string' && f.label.length > 0);
  }
});
