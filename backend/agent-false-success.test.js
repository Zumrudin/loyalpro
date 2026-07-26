'use strict';

// Guard: модель НЕ должна отрапортовать о переносе/отмене/записи, если пишущий
// инструмент не вызывался (Haiko-пилот 2026-07-22: claude-haiku заявил «готово,
// перенесла на 14:00», НЕ вызвав reschedule_booking → клиенту ушла ложь).

jest.mock('./db', () => ({ db: {}, pool: {} }));

const { runDialog } = require('./services/agent/orchestrator');

// Мок-провайдер: отдаёт заранее заготовленную очередь ответов по одному на вызов.
function providerOf(responses) {
  let i = 0;
  return {
    createMessage: async () => responses[Math.min(i++, responses.length - 1)],
    toolResultMessages: (results) => results.map(r => ({ role: 'tool', content: JSON.stringify(r.result) })),
  };
}
const historyOf = (userText) => ({
  loadTranscript: async () => ({ messages: [{ role: 'user', content: userText }], watermark: 1 }),
  hasIncomingAfter: async () => false,
});
const state = { getOrCreate: async () => ({ status: 'bot', escalated_reason: null }), setWatermark: async () => {} };
const identity = { resolveClient: async () => null };
const baseDeps = (provider, registry) => ({ provider, registry, history: null, state, identity });

const run = (provider, registry, userText) =>
  runDialog(1, '79000000000', { ctx: { phone: '79000000000' }, deps: { ...baseDeps(provider, registry), history: historyOf(userText) } });

describe('false-success guard', () => {
  test('заявлен перенос без вызова reschedule_booking → falseSuccess', async () => {
    const provider = providerOf([{ text: 'Готово, перенесла вашу запись на 14:00 🤍', toolCalls: [], assistantMsg: {} }]);
    const registry = { schemas: [], handlers: {} };
    const res = await run(provider, registry, 'перенеси на 14');
    expect(res.falseSuccess).toBe(true);
    expect(res.escalated).toBe(false);
  });

  test('перенос реально выполнен (reschedule_booking ok) → НЕ falseSuccess', async () => {
    const provider = providerOf([
      { text: '', toolCalls: [{ id: 't1', name: 'reschedule_booking', input: {} }], assistantMsg: {} },
      { text: 'Готово, перенесла вашу запись на 14:00 🤍', toolCalls: [], assistantMsg: {} },
    ]);
    const registry = { schemas: [], handlers: { reschedule_booking: async () => ({ rescheduled: true }) } };
    const res = await run(provider, registry, 'перенеси на 14');
    expect(res.falseSuccess).toBe(false);
  });

  test('намерение (инфинитив «перенести»), без утверждения о выполнении → НЕ falseSuccess', async () => {
    const provider = providerOf([{ text: 'Понимаю, вы хотите перенести запись? Уточните дату 🌸', toolCalls: [], assistantMsg: {} }]);
    const registry = { schemas: [], handlers: {} };
    const res = await run(provider, registry, 'хочу перенести');
    expect(res.falseSuccess).toBe(false);
  });

  // «Вы записаны…» двусмысленно: после успешного list_client_bookings это честный
  // ответ про существующую запись (polza-пилот gemini-2.5-pro 2026-07-26 уходил
  // в эскалацию на вопросе «когда я записан?»), без чтения записей — ложь.
  test('«вы записаны» после успешного list_client_bookings → НЕ falseSuccess', async () => {
    const provider = providerOf([
      { text: '', toolCalls: [{ id: 't1', name: 'list_client_bookings', input: {} }], assistantMsg: {} },
      { text: 'Вы записаны на 27 июля в 11:00 к Астемиру 🌸', toolCalls: [], assistantMsg: {} },
    ]);
    const registry = { schemas: [], handlers: { list_client_bookings: async () => ({ bookings: [{ id: 1 }] }) } };
    const res = await run(provider, registry, 'когда я записан?');
    expect(res.falseSuccess).toBe(false);
  });

  test('«вы записаны» БЕЗ чтения записей и без create_booking → falseSuccess', async () => {
    const provider = providerOf([{ text: 'Отлично, вы записаны на завтра! 🤍', toolCalls: [], assistantMsg: {} }]);
    const registry = { schemas: [], handlers: {} };
    const res = await run(provider, registry, 'запишите на завтра');
    expect(res.falseSuccess).toBe(true);
  });
});
