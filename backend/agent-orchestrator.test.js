'use strict';

// Оркестратор провайдер-агностичен: мокаем provider.createMessage, реальный
// toolResultMessages берём из aitunnel-провайдера (формат {role:'tool'}).
const realProvider = require('./services/agent/providers/aitunnel');
const orchestrator = require('./services/agent/orchestrator');

function makeDeps(overrides = {}) {
  return {
    provider: {
      createMessage: jest.fn(),
      toolResultMessages: realProvider.toolResultMessages,
      ...overrides.provider,
    },
    registry: {
      schemas: [{ name: 'get_available_slots' }, { name: 'escalate_to_operator' }, { name: 'create_booking' }],
      handlers: {
        get_available_slots: jest.fn(async () => ({ slots: [{ time: '10:00' }] })),
        escalate_to_operator: jest.fn(async () => ({ escalated: true, reason: 'жалоба' })),
        create_booking: jest.fn(async () => ({ created: true, record_id: 999 })),
        ...(overrides.handlers || {}),
      },
    },
    history: {
      loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: 'привет' }], watermark: 100 })),
      hasIncomingAfter: jest.fn(async () => false),
      ...overrides.history,
    },
    state: {
      getOrCreate: jest.fn(async () => ({ status: 'bot' })),
      setWatermark: jest.fn(async () => {}),
      ...overrides.state,
    },
  };
}

// Нормализованные ответы провайдера (не сырой формат SDK).
const textResp = (t) => ({ text: t, toolCalls: [], stopReason: 'stop', assistantMsg: { role: 'assistant', content: t } });
const toolResp = (name, input, id = 'c1', text = '') => ({
  text,
  toolCalls: [{ id, name, input }],
  stopReason: 'tool_calls',
  assistantMsg: { role: 'assistant', content: text || null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
});

describe('runDialog', () => {
  test('только текст → возвращает реплику, инструменты не звались', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-18' });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(false);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('tool_call → выполняет инструмент с ctx.dialogKey, скармливает результат, финализирует', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }, { dialogKey: 'k', clientPhone: '79001112233' });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    expect(out.sideEffect).toBe(false);
    const secondCallMessages = deps.provider.createMessage.mock.calls[1][0].messages;
    const toolTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolTurn.role).toBe('tool');
    expect(toolTurn.tool_call_id).toBe('c1');
  });

  test('escalate_to_operator → escalated:true и цикл останавливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(toolResp('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.sideEffect).toBe(true);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });

  test('диалог уже escalated → ничего не делаем', async () => {
    const deps = makeDeps({ state: { getOrCreate: jest.fn(async () => ({ status: 'escalated' })) } });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
  });

  test('новое входящее во время прогона без side-effect → черновик выброшен, перегенерация', async () => {
    let calls = 0;
    const deps = makeDeps({ history: { hasIncomingAfter: jest.fn(async () => (++calls === 1)) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('ответ про маникюр'))
      .mockResolvedValueOnce(textResp('ответ про педикюр'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ответ про педикюр']);
    expect(deps.history.loadTranscript).toHaveBeenCalledTimes(2);
  });

  test('защитный лимит итераций: бесконечный tool_call не зацикливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValue(
      toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS);
  });
});
