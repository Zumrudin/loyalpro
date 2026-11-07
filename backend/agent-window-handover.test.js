'use strict';

// Инцидент 2026-09-19 (79651442032): в 09:32 (окно до 09:30) «Удобнее, если
// перезвонит администратор» → gate skip (outside-schedule), ни эскалации, ни
// фразы — администратор нашёл диалог сам через 18 минут.

const wh = require('./services/agent/window-handover');

const HOUR = 60 * 60 * 1000;

describe('decideWindowHandover', () => {
  const base = { dialogStatus: 'bot', lastAgentReplyAgeMs: 3 * 60 * 1000, maxAgeMs: HOUR,
    incomingText: 'Удобнее, если перезвонит администратор. Здесь просто тратить время.' };

  test('боевой случай: бот вёл диалог 3 минуты назад → handover', () => {
    expect(wh.decideWindowHandover(base)).toEqual({ action: 'handover', why: 'live-dialog' });
  });

  test('выключено (maxAgeMs 0) → skip', () => {
    expect(wh.decideWindowHandover({ ...base, maxAgeMs: 0 }).action).toBe('skip');
  });

  test('диалог уже у человека (escalated) → skip', () => {
    expect(wh.decideWindowHandover({ ...base, dialogStatus: 'escalated' }).action).toBe('skip');
  });

  test('строки диалога нет / реплик Милы не было → skip', () => {
    expect(wh.decideWindowHandover({ ...base, dialogStatus: null }).action).toBe('skip');
    expect(wh.decideWindowHandover({ ...base, lastAgentReplyAgeMs: null }).action).toBe('skip');
  });

  test('последняя реплика Милы старше окна → skip (обрывать нечего)', () => {
    expect(wh.decideWindowHandover({ ...base, lastAgentReplyAgeMs: 2 * HOUR })).toEqual({ action: 'skip', why: 'agent-reply-too-old' });
  });

  test('чистая вежливость («Спасибо») → skip', () => {
    expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо' })).toEqual({ action: 'skip', why: 'pure-closing' });
    expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо, а 17:00 можно?' }).action).toBe('handover');
  });

  test('текста входящего нет (старый вебхук) — решает только возраст', () => {
    expect(wh.decideWindowHandover({ ...base, incomingText: undefined }).action).toBe('handover');
  });

  // Инцидент 07.11.2026 (79292633336): запись прошла в 09:09 внутри окна, Мила
  // попрощалась, в 09:37 (окно до 09:30) пациентка ответила «Ок» и получила
  // «Передаю Ваш вопрос администратору» — хотя вопроса не было.
  describe('подтверждение после разговора, закрытого Милой', () => {
    const closed = 'Татьяна, записала Вас на фотоомоложение лица к Астемиру Алексеевичу в четверг, 12 ноября, в 10:30. До встречи!';
    const ack = { ...base, lastAgentReplyAgeMs: 29 * 60 * 1000, incomingText: 'Ок', lastAgentReplyText: closed };

    test('боевой случай: «Ок» после «записала… До встречи!» → skip', () => {
      expect(wh.decideWindowHandover(ack)).toEqual({ action: 'skip', why: 'ack-after-closing' });
    });

    test('«Ок» после вопроса Милы — это согласие → handover', () => {
      expect(wh.decideWindowHandover({ ...ack,
        lastAgentReplyText: 'В четверг, 12 ноября, в 10:30 время свободно. Записать Вас на фотоомоложение лица?' }).action)
        .toBe('handover');
    });

    test('«Хорошо» после просьбы без вопросительного знака → handover', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingText: 'Хорошо',
        lastAgentReplyText: 'Екатерина, возвращаюсь к вашей записи к Юлии на 3 октября в 19:30. '
          + 'Если она ещё актуальна, напишите, пожалуйста, и мы продолжим оформление.' }).action)
        .toBe('handover');
    });

    test('«Да» — согласие, а не подтверждение → handover даже после прощания', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingText: 'Да' }).action).toBe('handover');
    });

    test('подтверждение вместе с вопросом → handover', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingText: 'Ок, а на чистку тоже можно?' }).action).toBe('handover');
    });

    test('текст реплики Милы неизвестен → handover, как раньше', () => {
      expect(wh.decideWindowHandover({ ...ack, lastAgentReplyText: undefined }).action).toBe('handover');
      expect(wh.decideWindowHandover({ ...ack, lastAgentReplyText: null }).action).toBe('handover');
    });

    // Дебаунс отдаёт диспетчеру только ПОСЛЕДНЕЕ сообщение серии.
    test('серия: содержательное сообщение, потом «Ок» → handover', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingTexts: ['А на чистку лица тоже можно записаться', 'Ок'] }).action)
        .toBe('handover');
    });

    test('серия: содержательное сообщение, потом «Спасибо» → handover (раньше молчали)', () => {
      expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо',
        incomingTexts: ['Перенесите меня на пятницу', 'Спасибо'] }).action).toBe('handover');
    });

    test('серия из одних подтверждений и благодарностей → skip', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingTexts: ['Ок', 'Спасибо!'] }).action).toBe('skip');
    });

    test('вложение без текста в серии классифицировать нельзя → handover', () => {
      expect(wh.decideWindowHandover({ ...ack, incomingTexts: [null, 'Ок'] }).action).toBe('handover');
      expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо', incomingTexts: ['', 'Спасибо'] }).action)
        .toBe('handover');
    });

    // Эхо Telegram/MAX приходит с задержкой в минуты: свежая реплика могла
    // ещё не лечь в БД и лежит только в pending-replies.
    test('после реплики из БД ушло исходящее без закрытия → handover', () => {
      expect(wh.decideWindowHandover({ ...ack,
        newerOutgoingTexts: ['Могу записать Вас и на консультацию в 11:00.'] }).action).toBe('handover');
    });

    test('более свежее исходящее тоже закрывает разговор → skip', () => {
      expect(wh.decideWindowHandover({ ...ack, newerOutgoingTexts: ['Будем ждать Вас! 🤍'] }).action).toBe('skip');
    });
  });
});

describe('onOutsideSchedule', () => {
  const NOW = Date.parse('2026-09-19T09:32:35+03:00');
  const meta = { phone: '79651442032', channel: 'max', text: 'Удобнее, если перезвонит администратор' };

  function deps(over = {}) {
    return {
      state: { get: jest.fn(async () => ({ status: 'bot' })) },
      history: {
        lastAgentReply: jest.fn(async () => ({
          at: Date.parse('2026-09-19T09:29:02+03:00'),
          text: 'Подобрала время: 10:00 или 11:30. Какое удобнее?',
        })),
        incomingTextsAfter: jest.fn(async () => []),
      },
      pending: { peek: jest.fn(() => []) },
      escalate: jest.fn(async () => ({ escalated: true })),
      send: jest.fn(async () => {}),
      handoverText: () => 'Передаю ваш диалог администратору клиники 🤍',
      maxAgeMs: HOUR, nowMs: NOW,
      logger: { info: jest.fn(), warn: jest.fn() },
      ...over,
    };
  }

  test('живой диалог → эскалация window_closed + фраза перевода', async () => {
    const d = deps();
    expect(await wh.onOutsideSchedule(1, '79651442032', meta, d)).toBe(true);
    expect(d.escalate).toHaveBeenCalledWith(1, '79651442032', 'window_closed');
    expect(d.send).toHaveBeenCalledWith(meta, 'Передаю ваш диалог администратору клиники 🤍');
  });

  test('реплика Милы старая → ничего', async () => {
    const d = deps({ history: {
      lastAgentReply: jest.fn(async () => ({ at: NOW - 5 * HOUR, text: 'До встречи!' })),
      incomingTextsAfter: jest.fn(async () => []),
    } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.escalate).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  test('содержательное сообщение → серию из БД не читаем (лишний запрос на каждое входящее вне окна)', async () => {
    const d = deps();
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(true);
    expect(d.history.incomingTextsAfter).not.toHaveBeenCalled();
  });

  describe('инцидент 07.11.2026 (79292633336): «Ок» после успешной записи', () => {
    const at = Date.parse('2026-11-07T09:09:25+03:00');
    const okMeta = { phone: '79292633336', channel: 'whatsapp', text: 'Ок' };
    const closed = 'Татьяна, записала Вас на фотоомоложение лица к Астемиру Алексеевичу в четверг, 12 ноября, в 10:30. До встречи!';
    function okDeps(over = {}) {
      return deps({
        nowMs: Date.parse('2026-11-07T09:37:55+03:00'),
        history: {
          lastAgentReply: jest.fn(async () => ({ at, text: closed })),
          incomingTextsAfter: jest.fn(async () => ['Ок']),
        },
        ...over,
      });
    }

    test('ни эскалации, ни фразы; в логе причина', async () => {
      const d = okDeps();
      expect(await wh.onOutsideSchedule(1, '79292633336', okMeta, d)).toBe(false);
      expect(d.escalate).not.toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
      expect(d.history.incomingTextsAfter).toHaveBeenCalledWith(1, '79292633336', at);
      expect(d.logger.info.mock.calls.some((c) => /перевода нет \(ack-after-closing\)/.test(String(c[0])))).toBe(true);
    });

    test('в серии из БД есть содержательное сообщение → перевод', async () => {
      const d = okDeps({ history: {
        lastAgentReply: jest.fn(async () => ({ at, text: closed })),
        incomingTextsAfter: jest.fn(async () => ['А на чистку лица можно ещё записаться', 'Ок']),
      } });
      expect(await wh.onOutsideSchedule(1, '79292633336', okMeta, d)).toBe(true);
      expect(d.escalate).toHaveBeenCalledWith(1, '79292633336', 'window_closed');
    });

    test('не легшая в БД реплика новее последней из БД учитывается, старая — нет', async () => {
      const sec = Math.floor(at / 1000);
      const older = okDeps({ pending: { peek: jest.fn(() => [{ text: 'Подобрать Вам время?', ts: sec - 600 }]) } });
      expect(await wh.onOutsideSchedule(1, 'k', okMeta, older)).toBe(false);

      const newer = okDeps({ pending: { peek: jest.fn(() => [{ text: 'Могу записать Вас и на консультацию в 11:00.', ts: sec + 60 }]) } });
      expect(await wh.onOutsideSchedule(1, 'k', okMeta, newer)).toBe(true);
      expect(newer.escalate).toHaveBeenCalledWith(1, 'k', 'window_closed');
    });

    test('сбой чтения серии → без перевода, только лог (как и сбой чтения состояния)', async () => {
      const d = okDeps({ history: {
        lastAgentReply: jest.fn(async () => ({ at, text: closed })),
        incomingTextsAfter: jest.fn(async () => { throw new Error('db down'); }),
      } });
      expect(await wh.onOutsideSchedule(1, 'k', okMeta, d)).toBe(false);
      expect(d.logger.warn).toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
    });
  });

  test('уже escalated → ничего', async () => {
    const d = deps({ state: { get: jest.fn(async () => ({ status: 'escalated' })) } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  test('сбой БД → без перевода, только лог', async () => {
    const d = deps({ state: { get: jest.fn(async () => { throw new Error('db down'); }) } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.logger.warn).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  test('эскалация упала → фраза пациенту всё равно уходит', async () => {
    const d = deps({ escalate: jest.fn(async () => { throw new Error('x'); }) });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(true);
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});
