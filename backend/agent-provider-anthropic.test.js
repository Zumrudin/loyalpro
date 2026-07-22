'use strict';
const anthropic = require('./services/agent/providers/anthropic');

describe('anthropic.createMessage (нормализация)', () => {
  test('зовёт SDK с system/tools/thinking и нормализует ответ в text+toolCalls', async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (p) => {
      calls.push(p);
      return { stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Секунду.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
      ] };
    } } };
    const res = await anthropic.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'привет' }], tools: [{ name: 't', input_schema: {} }] },
      { client: fakeClient, model: 'claude-opus-4-8', maxTokens: 1024 });

    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].system).toBe('ты админ');
    expect(calls[0].thinking).toEqual({ type: 'adaptive' });
    expect(calls[0].tools).toEqual([{ name: 't', input_schema: {} }]);
    expect(res.text).toBe('Секунду.');
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } }]);
    expect(res.assistantMsg).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Секунду.' },
      { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
    ] });
  });
});

describe('anthropic.toolResultMessages', () => {
  test('один user-turn с tool_result-блоками, is_error по флагу', () => {
    const msgs = anthropic.toolResultMessages([
      { id: 'tu_1', name: 'get_available_slots', result: { slots: ['10:00'] }, isError: false },
      { id: 'tu_2', name: 'create_booking', result: { error: 'занято' }, isError: true },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ slots: ['10:00'] }) });
    expect(msgs[0].content[1].is_error).toBe(true);
  });
});

describe('anthropic.createMessage без инструментов', () => {
  test('пустой список инструментов → параметр tools не отправляется', async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (p) => {
      calls.push(p);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Завтра в 16:00.' }] };
    } } };

    const res = await anthropic.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'когда?' }], tools: [] },
      { client: fakeClient });

    expect(calls[0]).not.toHaveProperty('tools');
    expect(res.text).toBe('Завтра в 16:00.');
  });
});
