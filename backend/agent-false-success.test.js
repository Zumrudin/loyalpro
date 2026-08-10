'use strict';

// Guard: модель НЕ должна отрапортовать о переносе/отмене/записи, если пишущий
// инструмент не вызывался (Haiko-пилот 2026-07-22: claude-haiku заявил «готово,
// перенесла на 14:00», НЕ вызвав reschedule_booking → клиенту ушла ложь).

jest.mock('./db', () => ({ db: {}, pool: {} }));

const { runDialog, detectFalseClaim } = require('./services/agent/orchestrator');

// Мок-провайдер: отдаёт заранее заготовленную очередь ответов по одному на вызов.
// requests — все запросы к провайдеру (нужны, чтобы отличить корректирующий
// довызов от основного: у него tools пустые, а последним сообщением идёт
// служебная проверка).
function providerOf(responses) {
  let i = 0;
  const requests = [];
  return {
    requests,
    createMessage: async (req) => { requests.push(req); return responses[Math.min(i++, responses.length - 1)]; },
    toolResultMessages: (results) => results.map(r => ({ role: 'tool', content: JSON.stringify(r.result) })),
  };
}
const say = (text) => ({ text, toolCalls: [], assistantMsg: {} });
const historyOf = (userText) => ({
  loadTranscript: async () => ({ messages: [{ role: 'user', content: userText }], watermark: 1 }),
  hasIncomingAfter: async () => false,
});
const state = { getOrCreate: async () => ({ status: 'bot', escalated_reason: null }), setWatermark: async () => {} };
const identity = { resolveClient: async () => null };
const baseDeps = (provider, registry) => ({
  provider, registry, history: null, state, identity,
  priceListData: { loadPriceIndex: async () => null },
});

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
    const res = await run(provider, registry, 'перенеси на 14:00');
    expect(res.falseSuccess).toBe(true);
    expect(res.escalated).toBe(false);
  });

  test('перенос реально выполнен (reschedule_booking ok) → НЕ falseSuccess', async () => {
    const provider = providerOf([
      { text: '', toolCalls: [{ id: 't1', name: 'reschedule_booking', input: {} }], assistantMsg: {} },
      { text: 'Готово, перенесла вашу запись на 14:00 🤍', toolCalls: [], assistantMsg: {} },
    ]);
    const registry = { schemas: [], handlers: { reschedule_booking: async () => ({ rescheduled: true }) } };
    const res = await run(provider, registry, 'перенеси на 14:00');
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
    const res = await run(provider, { schemas: [], handlers: {} }, 'перенеси на 14:00', [FUTURE_BOOKING]);
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

// ── Формулировки утверждения о записи ───────────────────────────────────────
//
// Инцидент 2026-08-06 (79200255591): запись, созданную Милой в 22:52, удалили в
// YClients в 22:55, а в 22:59 на новый вопрос пациента модель сослалась на неё.
// Воспроизведение на синтетическом номере дало формулировку «Я вижу, что вы УЖЕ
// записаны … на 7 августа в 12:00» — и regexp её не ловил: между «вы» и
// «записаны» стоит наречие. Ложь про несуществующую запись уходила пациенту.
//
// Наречия перечислены СПИСКОМ, а не «любым словом»: `вы \S+ записаны` поймал бы
// и «вы НЕ записаны» — правдивый ответ ровно в том состоянии (записей нет), в
// котором guard и срабатывает, то есть штатный ответ уводил бы диалог на человека.
describe('detectFalseClaim: утверждение о существующей записи', () => {
  const noProof = { existsHonest: false, cancelledHonest: false };
  const forms = ['вы записаны', 'вы уже записаны', 'вы всё ещё записаны',
    'вы все ещё записаны', 'вы по-прежнему записаны', 'вы точно записаны'];
  test.each(forms)('«%s» — утверждение о записи', (form) => {
    expect(detectFalseClaim(`Я вижу, что ${form} на 7 августа в 12:00 🤍`, noProof)).toBe('booked');
  });

  test.each(['вы не записаны', 'вы уже не записаны', 'вы пока не записаны'])(
    '«%s» — ОТРИЦАНИЕ, не ложный успех', (form) => {
      expect(detectFalseClaim(`К сожалению, ${form}. Давайте подберём время 🌸`, noProof)).toBe(null);
    });

  test('сверка подтверждает запись → утверждение честно', () => {
    expect(detectFalseClaim('Вы уже записаны на 7 августа в 12:00',
      { existsHonest: true, cancelledHonest: false })).toBe(null);
  });

  test('вид утверждения различается (для лога разбора)', () => {
    expect(detectFalseClaim('Готово, перенесла вашу запись на 14:00', noProof)).toBe('completion');
    expect(detectFalseClaim('Я отменила вашу запись', noProof)).toBe('cancelled');
  });
});

// ── Корректирующий довызов вместо перевода на администратора ────────────────
//
// Блок «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА» прямо говорит модели: запись пропала — это
// ШТАТНАЯ ситуация, предложи подобрать время заново, а НЕ переводи на человека.
// Guard делал ровно обратное: гасил реплику и уводил диалог к администратору
// (прод 2026-08-06, 79200255591 — на вопрос «на 7 или 8 можно записаться?»).
// Когда сверка прошла и записей НЕТ, правда известна детерминированно — значит
// ход можно починить одним довызовом, а не эскалацией. Side-effect'а на таком
// ходу нет по определению (falseSuccess требует !writeSucceeded), поэтому
// довызов безопасен.
describe('ложный успех при ПУСТОЙ сверке: один корректирующий довызов', () => {
  // Время назвал САМ пациент — иначе «12:00» в реплике ловится ещё и как
  // unknown_time (жёсткое с 10.08.2026), и тест мерил бы два довызова вместо
  // одного, то есть уже не то, про что он написан.
  const ASK = 'на 7 или 8 в 12:00 можно записаться?';
  const LIE = 'Я вижу, что вы уже записаны на 7 августа в 12:00 к Пери Исамудиновне 🤍';
  const FIX = 'Проверила: сейчас записи на 7 августа нет. Давайте подберу время заново — какой день удобен? 🌸';

  test('модель исправилась → ложь не доехала, эскалации нет, ушёл исправленный текст', async () => {
    const provider = providerOf([say(LIE), say(FIX)]);
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(res.falseSuccess).toBe(false);
    expect(res.replies).toEqual([FIX]);
  });

  test('довызов идёт БЕЗ инструментов — исправление не должно ничего записывать', async () => {
    const provider = providerOf([say(LIE), say(FIX)]);
    await run(provider, { schemas: [{ name: 'create_booking' }], handlers: {} }, ASK, []);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].tools).toEqual([]);
  });

  test('исправление тоже лжёт → довызов ровно ОДИН, дальше прежний перевод на человека', async () => {
    const provider = providerOf([say(LIE), say(LIE)]);
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(provider.requests).toHaveLength(2);
    expect(res.falseSuccess).toBe(true);
  });

  test('довызов вернул пустой текст → отдаём исходную реплику и прежний перевод', async () => {
    const provider = providerOf([say(LIE), say('')]);
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(res.falseSuccess).toBe(true);
    expect(res.replies).toEqual([LIE]);
  });

  test('довызов упал → ход не теряем, поведение прежнее', async () => {
    let i = 0;
    const provider = {
      createMessage: async () => { if (i++) throw new Error('provider down'); return say(LIE); },
      toolResultMessages: () => [],
    };
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(res.falseSuccess).toBe(true);
    expect(res.replies).toEqual([LIE]);
  });

  // Правда известна ТОЛЬКО при пустой сверке. Живая запись + «перенесла» и
  // отсутствие сверки вообще — состояния, где сказать модели нечего.
  test('запись в CRM ЖИВА («перенесла» без инструмента) → довызова нет, перевод как раньше', async () => {
    const provider = providerOf([say('Готово, перенесла вашу запись на 14:00 🤍')]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'перенеси на 14:00', [FUTURE_BOOKING]);
    expect(provider.requests).toHaveLength(1);
    expect(res.falseSuccess).toBe(true);
  });

  test('сверки не было (номер неизвестен) → довызова нет, перевод как раньше', async () => {
    const provider = providerOf([say('Мы записали вас на 16:00 🤍')]);
    const res = await runDialog(1, '79000000000', {
      // «16:00» цифрами в сообщении пациента: см. комментарий у ASK выше.
      deps: { ...baseDeps(provider, { schemas: [], handlers: {} }), history: historyOf('а во сколько подойти, в 16:00?') },
    });
    expect(provider.requests).toHaveLength(1);
    expect(res.falseSuccess).toBe(true);
  });

  test('честная реплика при пустой сверке довызова не вызывает', async () => {
    const provider = providerOf([say('Да, вашу запись отменили. Давайте подберём новое время 🌸')]);
    const res = await run(provider, { schemas: [], handlers: {} }, 'ту запись уже удалили ((', []);
    expect(provider.requests).toHaveLength(1);
    expect(res.falseSuccess).toBe(false);
  });

  // Порядок с reply-guard. Довызов пишет реплику ЗАНОВО, поэтому она обязана
  // пройти тот же линт, что и обычная: живая проверка (подменённый первый ответ,
  // настоящая модель) показала, что исправление свободно сочиняет время — без
  // линта оно ехало бы пациенту вообще без проверок.
  test('исправленная реплика проходит reply-guard (утечка id → переписывание)', async () => {
    const LEAK = 'Записи нет. Оформлю заново, номер обращения 1890942528 🌸';
    const CLEAN = 'Записи сейчас нет — давайте подберу время заново. Какой день удобен? 🌸';
    const provider = providerOf([say(LIE), say(LEAK), say(CLEAN)]);
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(provider.requests).toHaveLength(3);
    expect(res.replies).toEqual([CLEAN]);
    expect(res.falseSuccess).toBe(false);
  });

  // Разбор инцидента упирался в то, что вида утверждения не знал никто: guard
  // логировал только факт. Вид возвращается наружу — диспетчер пишет его в лог.
  test('вид утверждения уходит наружу вместе с флагом', async () => {
    const provider = providerOf([say(LIE), say(LIE)]);
    const res = await run(provider, { schemas: [], handlers: {} }, ASK, []);
    expect(res.falseSuccessKind).toBe('booked');
  });
});
