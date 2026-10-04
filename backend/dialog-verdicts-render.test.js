// backend/dialog-verdicts-render.test.js
'use strict';
// Вердикты ИИ по перепискам: таксономия статусов и признак автоуведомления о записи.
// Спека docs/superpowers/specs/2026-10-04-dialog-verdicts-design.md.
const { STATUSES, STATUS_CODES, TAXONOMY_VERSION, BOOKING_NOTICE_RE, UNANALYZED } =
  require('./services/dialog-verdicts/taxonomy');

describe('taxonomy', () => {
  test('восемь стартовых статусов, other последний, версия 1', () => {
    expect(STATUS_CODES).toEqual(['booked', 'declined', 'pending', 'reschedule', 'question', 'broadcast_reply', 'no_dialog', 'other']);
    expect(TAXONOMY_VERSION).toBe(1);
    expect(UNANALYZED).toBe('unanalyzed');
    expect(STATUS_CODES).not.toContain(UNANALYZED);
  });
  test('у каждого статуса есть label, short и определение для промпта', () => {
    for (const s of STATUSES) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.short).toBe('string');
      expect(s.def.length).toBeGreaterThan(10);
    }
  });
});

describe('BOOKING_NOTICE_RE', () => {
  test('ловит реальный текст уведомления YClients', () => {
    expect(BOOKING_NOTICE_RE.test('Вы записаны на прием 09.10.2026 19:00 в «PERI CLINIC».\nПо адресу: ул. Генерала Белова')).toBe(true);
  });
  test('не ловит напоминание о записи и подтверждение', () => {
    expect(BOOKING_NOTICE_RE.test('Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись 09.10.2026 19:00')).toBe(false);
    expect(BOOKING_NOTICE_RE.test('✅ Ваша запись подтверждена.\nБудем ждать вас!')).toBe(false);
  });
});

const { renderDialogDay, detectNotified, nextDay, MSG_MAX, DAY_MAX, TAIL_MAX } =
  require('./services/dialog-verdicts/render');

const msg = (over) => ({ direction: 'incoming', authored_by: null, text: 'привет', msg_type: 'text', day: '2026-10-03', ...over });

describe('renderDialogDay', () => {
  test('роли клиент/клиника/авто и маркеры блоков', () => {
    const out = renderDialogDay({
      tailMessages: [msg({ day: '2026-10-01', text: 'а цена?' })],
      dayMessages: [
        msg({ text: 'Хочу на завтра' }),
        msg({ direction: 'outgoing', authored_by: 'agent', text: 'Есть 12:00' }),
        msg({ direction: 'outgoing', authored_by: 'system', text: 'Вы записаны на прием 04.10.2026 12:00 в «PERI CLINIC».' }),
        msg({ direction: 'outgoing', authored_by: null, text: 'Ждём вас' }),
      ],
    });
    expect(out).toBe([
      '--- предыдущие дни ---',
      'клиент: а цена?',
      '--- этот день ---',
      'клиент: Хочу на завтра',
      'клиника: Есть 12:00',
      'авто: Вы записаны на прием 04.10.2026 12:00 в «PERI CLINIC».',
      'клиника: Ждём вас',
    ].join('\n'));
  });

  test('без хвоста маркер предыдущих дней не печатается', () => {
    expect(renderDialogDay({ dayMessages: [msg({ text: 'ок' })] })).toBe('--- этот день ---\nклиент: ок');
  });

  test('хвост режется до TAIL_MAX последних сообщений', () => {
    const tail = Array.from({ length: 15 }, (_, i) => msg({ day: '2026-10-01', text: 't' + i }));
    const out = renderDialogDay({ tailMessages: tail, dayMessages: [msg()] });
    expect(out).not.toContain('клиент: t4\n');
    expect(out).toContain('клиент: t5');
    expect(out).toContain('клиент: t14');
    expect(TAIL_MAX).toBe(10);
  });

  test('одно сообщение режется до MSG_MAX, переводы строк схлопываются', () => {
    const out = renderDialogDay({ dayMessages: [msg({ text: 'a\nb ' + 'x'.repeat(700) })] });
    const line = out.split('\n')[1];
    expect(line.startsWith('клиент: a b ')).toBe(true);
    expect(line.length).toBe('клиент: '.length + MSG_MAX);
  });

  test('весь диалог-день не длиннее DAY_MAX: сначала выбрасывается хвост, потом НАЧАЛО дня', () => {
    const tail = Array.from({ length: 10 }, (_, i) => msg({ day: '2026-10-01', text: 'хвост' + i + ' ' + 'y'.repeat(500) }));
    const day = Array.from({ length: 12 }, (_, i) => msg({ text: 'день' + i + ' ' + 'z'.repeat(500) }));
    const out = renderDialogDay({ tailMessages: tail, dayMessages: day });
    expect(out.length).toBeLessThanOrEqual(DAY_MAX);
    expect(out).not.toContain('предыдущие дни');
    expect(out).toContain('день11');          // конец дня (исход разговора) сохранён
    expect(out).not.toContain('день0 ');      // начало дня срезано
    expect(out.split('\n')[1]).toBe('…');     // маркер среза
  });

  test('файл без текста → [файл], пустой текст пропускается', () => {
    const out = renderDialogDay({ dayMessages: [
      msg({ text: '', msg_type: 'image' }),
      msg({ text: '   ', msg_type: 'text' }),
      msg({ text: 'ok' }),
    ] });
    expect(out).toBe('--- этот день ---\nклиент: [файл]\nклиент: ok');
  });
});

describe('detectNotified / nextDay', () => {
  test('nextDay считает по календарю', () => {
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
  });
  test('уведомление в этот день или на следующий → true; клиентский текст и «через день» → false', () => {
    const notice = { direction: 'outgoing', authored_by: 'system', text: 'Вы записаны на прием 05.10.2026 12:00 в «PERI CLINIC».' };
    expect(detectNotified([{ ...notice, day: '2026-10-03' }], '2026-10-03')).toBe(true);
    expect(detectNotified([{ ...notice, day: '2026-10-04' }], '2026-10-03')).toBe(true);
    expect(detectNotified([{ ...notice, day: '2026-10-05' }], '2026-10-03')).toBe(false);
    expect(detectNotified([{ ...notice, day: '2026-10-03', authored_by: null }], '2026-10-03')).toBe(false);
    expect(detectNotified([{ ...notice, day: '2026-10-03', direction: 'incoming' }], '2026-10-03')).toBe(false);
    expect(detectNotified([], '2026-10-03')).toBe(false);
  });
});
