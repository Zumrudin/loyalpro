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

// Сверка записей с CRM (блок «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА») идёт КАЖДЫЙ ход при
// известном номере. Стабим её всегда: без стаба тест лез бы в YClients, а
// главное — именно её результат теперь решает, ложь реплика или пересказ факта.
const FUTURE_BOOKING = {
  record_id: 111, datetime: '2099-08-12T16:00:00+03:00',
  services: ['Тотальное бикини и подмышки'], staff_name: 'Татьяна', attendance: 0,
};
const run = (provider, registry, userText, bookings = []) =>
  runDialog(1, '79000000000', {
    ctx: { phone: '79000000000' },
    deps: {
      ...baseDeps(provider, registry),
      history: historyOf(userText),
      listBookings: { run: async () => ({ bookings }) },
    },
  });

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

// ── Пересказ СВЕРЕННОГО состояния записи ≠ ложный успех ─────────────────────
//
// 26.07 (0fc2296) «вы записаны» вывели из-под безусловной защиты, потому что это
// двусмысленно; глаголы «записала вас / отменила» тогда осознанно оставили
// безусловными — источником фактов о записи мог быть ТОЛЬКО вызов инструмента.
// 04.08 предпосылка сломалась: оркестратор сам сверяется с CRM каждый ход и
// кладёт результат в промпт блоком «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА», то есть модель
// получила легальный источник тех же фактов БЕЗ инструмента. Гейт остался
// прежним и стал глушить честные ответы (прод 04.08, 79200255591: пациент
// «ту запись уже удалили» → ответ Милы про отменённую запись → эскалация).
describe('false-success guard: сверенное состояние записей', () => {
  test('«мы записали вас на 16:00» при ЖИВОЙ записи в CRM → НЕ falseSuccess', async () => {
    const provider = providerOf([{ text: 'Мы записали вас на 16:00. Подойдите за 5–10 минут 🤍', toolCalls: [], assistantMsg: {} }]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'а во сколько подойти?', [FUTURE_BOOKING]);
    expect(res.falseSuccess).toBe(false);
  });

  test('«мы записали вас на 16:00», а записей в CRM НЕТ → falseSuccess (выдумка)', async () => {
    const provider = providerOf([{ text: 'Мы записали вас на 16:00. Подойдите за 5–10 минут 🤍', toolCalls: [], assistantMsg: {} }]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'а во сколько подойти?', []);
    expect(res.falseSuccess).toBe(true);
  });

  test('«вашу запись отменили» при пустом списке в CRM → НЕ falseSuccess', async () => {
    const provider = providerOf([{ text: 'Да, вашу запись отменили. Давайте подберём новое время 🌸', toolCalls: [], assistantMsg: {} }]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'ту запись уже удалили ((', []);
    expect(res.falseSuccess).toBe(false);
  });

  test('«я отменила вашу запись», а запись в CRM ЖИВА → falseSuccess', async () => {
    const provider = providerOf([{ text: 'Готово, я отменила вашу запись 🤍', toolCalls: [], assistantMsg: {} }]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'отмените запись', [FUTURE_BOOKING]);
    expect(res.falseSuccess).toBe(true);
  });

  test('«перенесла на 14:00» остаётся безусловной ложью — снимок переноса не подтверждает', async () => {
    const provider = providerOf([{ text: 'Готово, перенесла вашу запись на 14:00 🤍', toolCalls: [], assistantMsg: {} }]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'перенеси на 14', [FUTURE_BOOKING]);
    expect(res.falseSuccess).toBe(true);
  });

  test('сверки не было (нет блока записей) → поведение прежнее, реплика считается ложью', async () => {
    const provider = providerOf([{ text: 'Мы записали вас на 16:00 🤍', toolCalls: [], assistantMsg: {} }]);
    const res = await runDialog(1, '79000000000', {
      // Номера нет → блок записей не строится вовсе (liveBookings = null).
      deps: { ...baseDeps(provider, { schemas: [], handlers: {} }), history: historyOf('а во сколько подойти?') },
    });
    expect(res.falseSuccess).toBe(true);
  });
});
