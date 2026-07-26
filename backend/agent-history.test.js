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
      { direction: 'outgoing', msg_type: 'text', text: 'позднее эхо',   msg_ts: 500 },
      { direction: 'incoming', msg_type: 'text', text: 'новый вопрос',  msg_ts: 400 },
      { direction: 'outgoing', msg_type: 'text', text: 'старый ответ',  msg_ts: 300 },
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
