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

// Оба файла подключены в index.html обычными <script> без type="module" и делят
// ОДНУ глобальную лексическую область. Верхнеуровневый `const chatIsEscalated`
// здесь сталкивался бы с `function chatIsEscalated` из chat-dialog-sort.js —
// SyntaxError гасил ВЕСЬ файл, chat.js не находил chatWaitMatches, и список
// диалогов переставал рендериться (регрессия поймана только живым прогоном
// страницы, 12.08.2026). Обычный `require` этого не ловит: он грузит каждый
// модуль в своей области, а браузер — в общей. Поэтому грузим их так же, как
// браузер: подряд, в один контекст.
test('оба скрипта грузятся в ОДНУ глобальную область, как в браузере', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ctx = vm.createContext({ console });
  ctx.window = ctx;                       // в браузере window и есть глобаль
  for (const f of ['chat-dialog-sort.js', 'chat-wait-status.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: f }),
      `${f} не загрузился в общей области — проверь редекларацию имён`);
  }
  // Файл, упавший на парсинге, не дошёл бы до экспорта в window.
  assert.strictEqual(typeof ctx.chatWaitStatus, 'function');
  assert.strictEqual(typeof ctx.chatWaitMatches, 'function');
  assert.ok(Array.isArray(ctx.CHAT_WAIT_FILTERS));
  // И предикат эскалации реально резолвится из соседнего файла.
  assert.strictEqual(
    ctx.chatWaitStatus({ agentStatus: 'escalated', followupStatus: 'scheduled', followupStage: 0 }).key,
    'operator');
});
