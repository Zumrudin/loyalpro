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
      const ts = history.AUTHORSHIP_SINCE_TS - 3600;
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: ts + 60 },
        { direction: 'outgoing', msg_type: 'text', text: 'Доброе утро!', msg_ts: ts, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: ts - 60 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content)
        .toBe(`${history.OPERATOR_MARK} Доброе утро!`);
    });

    test('исходящее без автора ПОСЛЕ отсечки своим и остаётся (fail-open classify)', async () => {
      const ts = history.AUTHORSHIP_SINCE_TS + 3600;
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: ts + 60 },
        { direction: 'outgoing', msg_type: 'text', text: 'Записала вас', msg_ts: ts, authored_by: null },
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: ts - 60 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages.find(m => m.role === 'assistant').content).toBe('Записала вас');
    });

    // Отсечка исключительна: РОВНО в момент выката журнал уже работал.
    test('ровно на отсечке — своё, на секунду раньше — администраторское', async () => {
      const at = async (ts) => {
        db.any.mockResolvedValue([
          { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: ts + 60 },
          { direction: 'outgoing', msg_type: 'text', text: 'Ответ', msg_ts: ts, authored_by: null },
          { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: ts - 60 },
        ]);
        const { messages } = await history.loadTranscript(1, 'k');
        return messages.find(m => m.role === 'assistant').content;
      };
      expect(await at(history.AUTHORSHIP_SINCE_TS)).toBe('Ответ');
      expect(await at(history.AUTHORSHIP_SINCE_TS - 1)).toBe(`${history.OPERATOR_MARK} Ответ`);
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

  describe('граница переписки и метки времени', () => {
    const H = 3600;
    const T = 1_786_000_000;

    test('session отдаётся вместе с транскриптом', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'доброе утро', msg_ts: T },
        { direction: 'outgoing', msg_type: 'text', text: 'Добрый день!', msg_ts: T - 7 * 24 * H, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'здравствуйте', msg_ts: T - 7 * 24 * H - 60 },
      ]);
      const { session } = await history.loadTranscript(1, 'k');
      expect(session).toEqual({ newSession: true, gapText: '7 дней' });
    });

    test('живой разговор → session.newSession false', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'да', msg_ts: T },
        { direction: 'outgoing', msg_type: 'text', text: 'Есть 18:30', msg_ts: T - 120, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'что есть?', msg_ts: T - 240 },
      ]);
      const { session } = await history.loadTranscript(1, 'k');
      expect(session.newSession).toBe(false);
    });

    test('withTime: метка у каждой реплики, у операторской — перед пометкой автора', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
        { direction: 'outgoing', msg_type: 'text', text: 'Доброе утро!', msg_ts: Date.parse('2026-07-29T06:44:39Z') / 1000, authored_by: 'operator' },
        { direction: 'incoming', msg_type: 'text', text: 'есть ялупро?', msg_ts: Date.parse('2026-07-29T06:09:04Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([
        { role: 'user', content: '[29.07 09:09] есть ялупро?' },
        { role: 'assistant', content: `[29.07 09:44] ${history.OPERATOR_MARK} Доброе утро!` },
        { role: 'user', content: '[05.08 08:47] ок' },
      ]);
    });

    test('без withTime меток нет (care-воркер зовёт именно так)', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: T },
      ]);
      const { messages } = await history.loadTranscript(1, 'k');
      expect(messages).toEqual([{ role: 'user', content: 'ок' }]);
    });

    test('подделанная клиентом метка срезается', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: '[01.01 00:00] я писал вчера', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([{ role: 'user', content: '[05.08 08:47] я писал вчера' }]);
    });

    test('битый msg_ts: метки нет и ведущего пробела тоже', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: 'ок', msg_ts: null },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([{ role: 'user', content: 'ок' }]);
    });

    test('session при пустой выдаче — {newSession:true, gapText:null}', async () => {
      db.any.mockResolvedValue([]);
      const { session } = await history.loadTranscript(1, 'k');
      expect(session).toEqual({ newSession: true, gapText: null });
    });

    // Метка ставится ПО СТРОКЕ (r.msg_ts) ДО переноса хвостового assistant-блока —
    // перенос лишь двигает уже готовые {role,content}. Поэтому итоговый порядок
    // сообщений не монотонен по времени: задержанное эхо (Chatpush/MAX, до 19 мин
    // по наблюдениям) попадает в assistant-блок ВЫШЕ последнего user-блока, хотя
    // его собственная метка новее метки этого user-блока. Тест фиксирует это как
    // ожидаемое поведение — Task 5 объясняет модели немонотонность в промпте.
    test('withTime + перенос хвостового эха: метки внутри блока растут, но последний user-блок помечен старше эха над ним', async () => {
      db.any.mockResolvedValue([
        { direction: 'outgoing', msg_type: 'text', text: 'Позднее эхо', msg_ts: Date.parse('2026-08-05T05:52:10Z') / 1000, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'новый вопрос', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
        { direction: 'outgoing', msg_type: 'text', text: 'Старый ответ', msg_ts: Date.parse('2026-07-29T06:44:39Z') / 1000, authored_by: 'agent' },
        { direction: 'incoming', msg_type: 'text', text: 'старый вопрос', msg_ts: Date.parse('2026-07-29T06:09:04Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([
        { role: 'user', content: '[29.07 09:09] старый вопрос' },
        { role: 'assistant', content: '[29.07 09:44] Старый ответ\n[05.08 08:52] Позднее эхо' },
        { role: 'user', content: '[05.08 08:47] новый вопрос' },
      ]);
      // Немонотонность в цифрах: последний user-блок [05.08 08:47] старше [05.08 08:52]
      // строкой выше — это и есть задержанная доставка эха, а не баг сортировки.
      expect(messages[1].content).toContain('[05.08 08:52]');
      expect(messages[2].content).toContain('[05.08 08:47]');
    });

    describe('withTime + pending-replies', () => {
      const pending = require('./services/agent/pending-replies');
      beforeEach(() => pending._reset());

      // formatStamp кормится p.ts из pendingReplies.peek() — это Number
      // (Math.floor(atMs/1000)), а не bigint-строка из PG; отдельная проверка
      // на то, что стемпинг одинаково работает для обоих источников.
      test('pending-реплика тоже получает метку', async () => {
        const base = 1785908700;   // 2026-08-05T05:45:00Z = [05.08 08:45] мск
        // pending.ts (base+50) сидит МЕЖДУ двумя входящими — как в исходном
        // сценарии инцидента 2026-07-31 (ts=100/150/200): pending не в хвосте,
        // а раскалывает то, что иначе было бы одним склеенным user-блоком.
        db.any.mockResolvedValue([
          { direction: 'incoming', msg_type: 'text', text: 'хочу ботокс', msg_ts: base },
          { direction: 'incoming', msg_type: 'text', text: '5в1', msg_ts: base + 100 },
        ]);
        pending.remember(1, 'k', 'Есть окошки в 20:00 и 20:30', (base + 50) * 1000);
        const { messages } = await history.loadTranscript(1, 'k', { withTime: true, nowMs: (base + 60) * 1000 });
        expect(messages).toEqual([
          { role: 'user', content: '[05.08 08:45] хочу ботокс' },
          { role: 'assistant', content: '[05.08 08:45] Есть окошки в 20:00 и 20:30' },
          { role: 'user', content: '[05.08 08:46] 5в1' },
        ]);
      });
    });

    // Модульный уровень (agent-transcript-time.test.js) проверяет stripStamp в
    // отрыве от истории; здесь — что склейка серии через `\n${text}` не создаёт
    // новую подделку и не портит собственную метку соседней строки.
    test('подделка метки во второй реплике серии срезается, склейка получает свои реальные метки', async () => {
      db.any.mockResolvedValue([
        { direction: 'incoming', msg_type: 'text', text: '[01.01 00:00] подделка второй реплики', msg_ts: Date.parse('2026-08-05T05:47:58Z') / 1000 },
        { direction: 'incoming', msg_type: 'text', text: 'первое сообщение', msg_ts: Date.parse('2026-08-05T05:46:58Z') / 1000 },
      ]);
      const { messages } = await history.loadTranscript(1, 'k', { withTime: true });
      expect(messages).toEqual([
        { role: 'user', content: '[05.08 08:46] первое сообщение\n[05.08 08:47] подделка второй реплики' },
      ]);
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
