'use strict';

const claude = require('./services/agent/claude');

describe('splitContent', () => {
  test('делит ответ на текст и tool_use', () => {
    const msg = {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Сейчас проверю слоты.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
      ],
    };
    const out = claude.splitContent(msg);
    expect(out.text).toBe('Сейчас проверю слоты.');
    expect(out.stopReason).toBe('tool_use');
    expect(out.toolUses).toHaveLength(1);
    expect(out.toolUses[0].name).toBe('get_available_slots');
  });

  test('только текст → toolUses пуст', () => {
    const msg = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово.' }] };
    const out = claude.splitContent(msg);
    expect(out.text).toBe('Готово.');
    expect(out.toolUses).toEqual([]);
  });
});

describe('toolResultBlock', () => {
  test('строит tool_result с JSON-содержимым', () => {
    const block = claude.toolResultBlock('tu_1', { slots: ['10:00'] });
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: JSON.stringify({ slots: ['10:00'] }),
    });
  });

  test('is_error помечает ошибку', () => {
    const block = claude.toolResultBlock('tu_2', { error: 'нет слотов' }, true);
    expect(block.is_error).toBe(true);
  });
});

describe('createMessage', () => {
  test('зовёт injected client с model/tools/messages и возвращает ответ', async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (p) => { calls.push(p); return { stop_reason: 'end_turn', content: [] }; } } };
    const res = await claude.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'привет' }], tools: [{ name: 't' }] },
      { client: fakeClient, model: 'claude-opus-4-8', maxTokens: 1024 });
    expect(res.stop_reason).toBe('end_turn');
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].max_tokens).toBe(1024);
    expect(calls[0].system).toBe('ты админ');
    expect(calls[0].tools).toEqual([{ name: 't' }]);
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'привет' }]);
  });
});
