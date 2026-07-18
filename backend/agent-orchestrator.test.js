'use strict';

// Реальный claude нужен только для splitContent/toolResultBlock; createMessage мокаем.
const realClaude = require('./services/agent/claude');

const orchestrator = require('./services/agent/orchestrator');

function makeDeps(overrides = {}) {
  return {
    claude: {
      splitContent: realClaude.splitContent,
      toolResultBlock: realClaude.toolResultBlock,
      createMessage: jest.fn(),
      ...overrides.claude,
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

const textMsg = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const toolMsg = (name, input, id = 'tu_1', text = '') => ({
  stop_reason: 'tool_use',
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }],
});

describe('runDialog', () => {
  test('только текст → возвращает реплику, инструменты не звались', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValueOnce(textMsg('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-18' });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(false);
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('tool_use → выполняет инструмент с ctx.dialogKey, скармливает результат, финализирует', async () => {
    const deps = makeDeps();
    deps.claude.createMessage
      .mockResolvedValueOnce(toolMsg('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textMsg('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }, { dialogKey: 'k', clientPhone: '79001112233' });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    expect(out.sideEffect).toBe(false);
    // второй вызов Claude получил tool_result
    const secondCallMessages = deps.claude.createMessage.mock.calls[1][0].messages;
    const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResultTurn.role).toBe('user');
    expect(toolResultTurn.content[0].type).toBe('tool_result');
  });

  test('escalate_to_operator → escalated:true и цикл останавливается', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValueOnce(toolMsg('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.sideEffect).toBe(true);
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(1);
  });

  test('диалог уже escalated → ничего не делаем', async () => {
    const deps = makeDeps({ state: { getOrCreate: jest.fn(async () => ({ status: 'escalated' })) } });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(deps.claude.createMessage).not.toHaveBeenCalled();
  });

  test('новое входящее во время прогона без side-effect → черновик выброшен, перегенерация', async () => {
    let calls = 0;
    const deps = makeDeps({ history: { hasIncomingAfter: jest.fn(async () => (++calls === 1)) } });
    deps.claude.createMessage
      .mockResolvedValueOnce(textMsg('ответ про маникюр'))   // 1-й прогон — выбрасывается
      .mockResolvedValueOnce(textMsg('ответ про педикюр'));  // 2-й прогон — отдаётся
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ответ про педикюр']);
    expect(deps.history.loadTranscript).toHaveBeenCalledTimes(2);
  });

  test('защитный лимит итераций: бесконечный tool_use не зацикливается', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValue(
      toolMsg('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS);
  });
});
