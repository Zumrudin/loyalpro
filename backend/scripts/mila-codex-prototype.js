'use strict';

// Synthetic smoke only: no dotenv, DB, CRM, dispatcher, or message transport.
const assert = require('node:assert/strict');
const provider = require('../services/agent/providers/codex');

async function main() {
  const system = 'Ты Мила, администратор тестового салона. Отвечай кратко и дружелюбно. '
    + 'Режим работы узнавай только через get_test_hours. Не придумывай расписание. '
    + 'Тестовые часы не являются свободными слотами для записи.';
  const tools = [{ name: 'get_test_hours', description: 'Часы работы вымышленного салона.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
  const messages = [{ role: 'user', content: 'Здравствуйте! Во сколько открывается ваш салон?' }];
  const started = Date.now();
  const call = await provider.createMessage({ system, messages, tools });
  assert.equal(call.toolCalls.length, 1);
  assert.equal(call.toolCalls[0].name, 'get_test_hours');
  assert.deepEqual(call.toolCalls[0].input, {});
  console.log(JSON.stringify({ stage: 'tool_request', model: provider.MODEL, passed: true, ms: Date.now() - started }));
  messages.push(call.assistantMsg, ...provider.toolResultMessages([{
    id: call.toolCalls[0].id, result: { opens: '10:30', closes: '19:30', synthetic: true },
  }]));
  const finish = Date.now();
  const reply = await provider.createMessage({ system, messages, tools: [] });
  assert.equal(reply.toolCalls.length, 0);
  assert.match(reply.text, /10:30/);
  // Do not print message content; only non-sensitive verification metadata.
  console.log(JSON.stringify({ stage: 'final_answer', passed: true,
    ms: Date.now() - finish, characters: reply.text.length, totalMs: Date.now() - started }));
}

main().catch(e => {
  const code = /^CODEX_[A-Z_]+$/.test(e.code || '') ? e.code : 'PROTOTYPE_CHECK_FAILED';
  console.error(JSON.stringify({ passed: false, code }));
  process.exitCode = 1;
});
