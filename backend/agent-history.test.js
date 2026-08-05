'use strict';

jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));

const { db } = require('./db');
const history = require('./services/agent/history');

beforeEach(() => jest.clearAllMocks());

describe('loadTranscript', () => {
  test('incoming→user, outgoing→assistant, серия склеивается, watermark = max incoming ts', async () => {
    // db.any возвращает по msg_ts DESC (как в SQL) — модуль сам развернёт.
    db.any.mockResolvedValue([
      { direction: 'incoming', msg_type: 'text', text: 'и педикюр тоже', msg_ts: 300 },
      { direction: 'incoming', msg_type: 'text', text: 'хочу маникюр',   msg_ts: 200 },
      { direction: 'outgoing', msg_type: 'text', text: 'Здравствуйте!',  msg_ts: 100 },
    ]);
    const { messages, watermark } = await history.loadTranscript(1, '79001112233');
    // Ведущее "Здравствуйте!" (outgoing, самое старое сообщение в выборке) срезается —
    // Claude Messages API требует, чтобы первым шёл user (см. error-codes: "First message
    // must be user"). Серия из двух incoming остаётся склеенной в один user-turn.
    expect(messages).toEqual([
      { role: 'user', content: 'хочу маникюр\nи педикюр тоже' },
    ]);
    expect(watermark).toBe(300);
    expect(db.any.mock.calls[0][1]).toEqual([1, '79001112233', 20]);
  });

  // Инцидент 2026-08-04 (79253209302): администратор вёл диалог из приложения
  // MAX, его реплики приходили тем же эхом и попадали в транскрипт как СВОИ.
  // Сработало правило «ВЫБОР ВАРИАНТА = СОГЛАСИЕ» — Мила сочла услугу и время
  // согласованными ею самой и оформила запись на выдуманную услугу.
  describe('авторство исходящих', () => {
    test('реплика оператора помечена в транскрипте', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'Да можно', msg_ts: 300 },
        { direction: 'outgoing', msg_type: 'text', text: 'В 19:15 удобно было бы?', msg_ts: 200, authored_by: 'operator' },
        { direction: 'incoming', msg_type: 'text', text: 'В 18.40', msg_ts: 100 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      const assistant = messages.find(m => m.role === 'assistant');
      expect(assistant.content).toBe('[сообщение администратора клиники] В 19:15 удобно было бы?');
    });

    test('свои реплики и автоуведомления не помечаются', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: 300 },
        { direction: 'outgoing', msg_type: 'text', text: 'Записала вас', msg_ts: 200, authored_by: 'agent' },
        { direction: 'outgoing', msg_type: 'text', text: 'Вы записаны на прием', msg_ts: 150, authored_by: 'system' },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: 100 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content)
        .toBe('Вы записаны на прием\nЗаписала вас');   // хронологический порядок
    });

    // Отсечка = момент выката журнала авторства (04.08.2026, коммит 34caa25).
    // До неё NULL означает «автор неизвестен, вероятно администратор»; после —
    // «classify упал» (там намеренный fail-open, чтобы не глушить Милу на её
    // же эхе), и такое NULL оператором считать нельзя.
    test('исходящее без автора СТАРШЕ отсечки помечается как администраторское', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: 1_785_000_000 },
        { direction: 'outgoing', msg_type: 'text', text: 'Доброе утро!', msg_ts: 1_753_000_000, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: 1_752_000_000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content)
        .toBe(`${history.OPERATOR_MARK} Доброе утро!`);
    });

    test('исходящее без автора ПОСЛЕ отсечки своим и остаётся (fail-open classify)', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: 1_786_000_100 },
        { direction: 'outgoing', msg_type: 'text', text: 'Записала вас', msg_ts: 1_786_000_000, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: 1_785_999_000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content).toBe('Записала вас');
    });
  });

  test('ведущие assistant-реплики срезаются (Claude требует user первым)', async () => {
    db.any.mockResolvedValue([
      { direction: 'incoming', msg_type: 'text', text: 'привет', msg_ts: 50 },
      { direction: 'outgoing', msg_type: 'text', text: 'Чем помочь?', msg_ts: 10 },
    ]);
    const { messages } = await history.loadTranscript(1, 'k');
    expect(messages[0].role).toBe('user');
  });

  test('задержанное эхо после нового входящего → assistant-хвост переносится перед последний user', async () => {
    // Chatpush/MAX доставил наш ответ через минуты: эхо (msg_ts 400) легло ПОЗЖЕ
    // нового входящего (300). Транскрипт не должен кончаться assistant-репликой —
    // Polza/Azure отвергает такой диалог (400 «assistant message prefill»).
    db.any.mockResolvedValue([
      { direction: 'outgoing', msg_type: 'text', text: 'Ответ на «хочу маникюр»', msg_ts: 400 },
      { direction: 'incoming', msg_type: 'text', text: 'а педикюр есть?',         msg_ts: 300 },
      { direction: 'incoming', msg_type: 'text', text: 'хочу маникюр',            msg_ts: 200 },
    ]);
    const { messages, watermark } = await history.loadTranscript(1, 'k');
    // Оба входящих в выборке соседние (по ts) → склеены в один user-блок; перенос
    // ставит эхо перед ним, а ведущий assistant без более раннего user срезается.
    // Главное — транскрипт кончается user-блоком, а не assistant-репликой.
    expect(messages).toEqual([
      { role: 'user', content: 'хочу маникюр\nа педикюр есть?' },
    ]);
    expect(watermark).toBe(300);
  });

  test('assistant-хвост вливается в предыдущий assistant-блок, диалог кончается user', async () => {
    db.any.mockResolvedValue([
      { direction: 'outgoing', msg_type: 'text', text: 'позднее эхо',   msg_ts: 500, authored_by: 'agent' },
      { direction: 'incoming', msg_type: 'text', text: 'новый вопрос',  msg_ts: 400 },
      { direction: 'outgoing', msg_type: 'text', text: 'старый ответ',  msg_ts: 300, authored_by: 'agent' },
      { direction: 'incoming', msg_type: 'text', text: 'старый вопрос', msg_ts: 200 },
    ]);
    const { messages } = await history.loadTranscript(1, 'k');
    expect(messages).toEqual([
      { role: 'user', content: 'старый вопрос' },
      { role: 'assistant', content: 'старый ответ\nпозднее эхо' },
      { role: 'user', content: 'новый вопрос' },
    ]);
  });

  test('пустой диалог → пустые messages, watermark 0', async () => {
    db.any.mockResolvedValue([]);
    const { messages, watermark } = await history.loadTranscript(1, 'k');
    expect(messages).toEqual([]);
    expect(watermark).toBe(0);
  });

  // ── pending-replies: только что отправленные ответы до прихода эха ──
  // Инцидент 2026-07-31: повторный прогон стартовал сразу после отправки ответа,
  // эха ещё не было → модель видела серию клиента «без ответа» и отвечала заново.
  describe('подмешивание pending-replies', () => {
    const pending = require('./services/agent/pending-replies');
    beforeEach(() => pending._reset());

    test('свежеотправленный ответ виден в транскрипте до прихода эха', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: '5в1',         msg_ts: 200 },
        { direction: 'incoming', msg_type: 'text', text: 'хочу ботокс', msg_ts: 100 },
      ]);
      pending.remember(1, 'k', 'Есть окошки в 20:00 и 20:30', 150_000);   // ts=150с
      const { messages, watermark } = await history.loadTranscript(1, 'k', { nowMs: 160_000 });
      expect(messages).toEqual([
        { role: 'user', content: 'хочу ботокс' },
        { role: 'assistant', content: 'Есть окошки в 20:00 и 20:30' },
        { role: 'user', content: '5в1' },
      ]);
      expect(watermark).toBe(200);
    });

    test('эхо уже в БД → pending с тем же текстом не дублируется', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ещё вопрос', msg_ts: 300 },
        { direction: 'outgoing', msg_type: 'text', text: 'Ответ',      msg_ts: 150, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'вопрос',     msg_ts: 100 },
      ]);
      pending.remember(1, 'k', 'Ответ', 150_000);
      const { messages } = await history.loadTranscript(1, 'k', { nowMs: 160_000 });
      expect(messages).toEqual([
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: 'Ответ' },
        { role: 'user', content: 'ещё вопрос' },
      ]);
    });

    test('pending чужого диалога не подмешивается', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'вопрос', msg_ts: 100 },
      ]);
      pending.remember(1, 'другой-диалог', 'чужой ответ', 150_000);
      const { messages } = await history.loadTranscript(1, 'k', { nowMs: 160_000 });
      expect(messages).toEqual([{ role: 'user', content: 'вопрос' }]);
    });
  });
});

describe('hasIncomingAfter', () => {
  test('true, если есть входящее новее watermark', async () => {
    db.oneOrNone.mockResolvedValue({ '?column?': 1 });
    const out = await history.hasIncomingAfter(1, 'k', 200);
    expect(out).toBe(true);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, 'k', 200]);
  });
  test('false, если нет', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await history.hasIncomingAfter(1, 'k', 200)).toBe(false);
  });
});
