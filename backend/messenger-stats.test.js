// backend/messenger-stats.test.js
'use strict';
// TZ закреплён в jest.config.js (globalSetup): фикстура «Date в локальную полночь»
// ловит баг dateKey только при TZ с положительным смещением, на UTC-хосте она зелёная.
const { summarize, channelLabel, eachDate, periodDays } = require('./services/messenger-stats');

describe('messenger-stats: channelLabel', () => {
  test('известные каналы получают человеческие имена, прочие — как есть', () => {
    expect(channelLabel('tdlib')).toBe('Telegram');
    expect(channelLabel('whatsapp')).toBe('WhatsApp');
    expect(channelLabel('max')).toBe('MAX');
    expect(channelLabel('max_bot')).toBe('max_bot');
    expect(channelLabel(null)).toBe('—');
  });
});

describe('messenger-stats: eachDate', () => {
  test('перечисляет каждый день включительно', () => {
    expect(eachDate('2026-09-29', '2026-10-02')).toEqual(
      ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  test('один день → один элемент', () => {
    expect(eachDate('2026-10-03', '2026-10-03')).toEqual(['2026-10-03']);
  });
});

describe('messenger-stats: periodDays', () => {
  test('считает дни включительно', () => {
    expect(periodDays('2026-10-01', '2026-10-03')).toBe(3);
    expect(periodDays('2026-10-03', '2026-10-03')).toBe(1);
  });
  test('битая дата → NaN', () => {
    expect(Number.isNaN(periodDays('x', '2026-10-03'))).toBe(true);
  });
});

describe('messenger-stats: summarize', () => {
  const rows = [
    { date: '2026-10-01', channel: 'tdlib',    dialogs: 5, client_first: 3, client_first_no_phone: 1, booked_same_day: 2, booked_by_agent: 1 },
    { date: '2026-10-01', channel: 'whatsapp', dialogs: 2, client_first: 2, client_first_no_phone: 0, booked_same_day: 1, booked_by_agent: 0 },
    { date: '2026-10-03', channel: 'tdlib',    dialogs: '4', client_first: '1', client_first_no_phone: '0', booked_same_day: '0', booked_by_agent: '0' },
  ];
  const out = summarize(rows, { from: '2026-10-01', to: '2026-10-03' });

  test('итоги — суммы по всем строкам, строки pg приводятся к числам', () => {
    expect(out.totals).toMatchObject({ dialogs: 11, clientFirst: 6, clientFirstNoPhone: 1, bookedSameDay: 3, bookedByAgent: 1 });
    expect(out.period).toEqual({ from: '2026-10-01', to: '2026-10-03' });
  });

  test('разрез по каналам: метка, сортировка по dialogs убыванию', () => {
    expect(out.byChannel.map(c => c.channel)).toEqual(['tdlib', 'whatsapp']);
    expect(out.byChannel[0]).toMatchObject({ channel: 'tdlib', label: 'Telegram', dialogs: 9, clientFirst: 4, clientFirstNoPhone: 1, bookedSameDay: 2, bookedByAgent: 1 });
  });

  test('ряд по дням покрывает каждый день периода, пустые дни — нулями', () => {
    expect(out.daily).toEqual([
      { date: '2026-10-01', clientFirst: 5, bookedSameDay: 3 },
      { date: '2026-10-02', clientFirst: 0, bookedSameDay: 0 },
      { date: '2026-10-03', clientFirst: 1, bookedSameDay: 0 },
    ]);
  });

  test('инварианты dialogs ≥ clientFirst ≥ bookedSameDay держатся на итогах и каналах', () => {
    for (const s of [out.totals, ...out.byChannel]) {
      expect(s.dialogs).toBeGreaterThanOrEqual(s.clientFirst);
      expect(s.clientFirst).toBeGreaterThanOrEqual(s.bookedSameDay);
      expect(s.bookedSameDay).toBeGreaterThanOrEqual(s.bookedByAgent);
    }
  });

  test('ряд по дням в сумме совпадает с итогами (ничего не потеряно молча)', () => {
    expect(out.daily.reduce((s, d) => s + d.clientFirst, 0)).toBe(out.totals.clientFirst);
    expect(out.daily.reduce((s, d) => s + d.bookedSameDay, 0)).toBe(out.totals.bookedSameDay);
  });

  test('пустой вход → нули, пустые каналы, ряд из нулей', () => {
    const e = summarize([], { from: '2026-10-02', to: '2026-10-03' });
    expect(e.totals).toMatchObject({ dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
    expect(e.byChannel).toEqual([]);
    expect(e.daily).toEqual([
      { date: '2026-10-02', clientFirst: 0, bookedSameDay: 0 },
      { date: '2026-10-03', clientFirst: 0, bookedSameDay: 0 },
    ]);
  });

  test('дата из pg может прийти объектом Date — нормализуется к YYYY-MM-DD', () => {
    expect(new Date(2026, 9, 2).getTimezoneOffset()).toBe(-180); // TZ закреплён в jest.config.js
    const r = summarize([{ date: new Date(2026, 9, 2), channel: 'max', dialogs: 1, client_first: 1, client_first_no_phone: 0, booked_same_day: 0, booked_by_agent: 0 }],
      { from: '2026-10-02', to: '2026-10-02' });
    expect(r.daily).toEqual([{ date: '2026-10-02', clientFirst: 1, bookedSameDay: 0 }]);
  });
});

describe('messenger-stats: вердикты', () => {
  const { MESSENGER_STATS_SQL, PERSONAL_NON_SYSTEM_SQL, phoneFormsSql, recCteSql, BOOKED_CTE_SQL } = require('./services/messenger-stats');
  const { STATUS_CODES } = require('./services/dialog-verdicts/taxonomy');

  test('SQL сводки джойнит dialog_verdicts и считает колонку на каждый статус плюс unanalyzed', () => {
    expect(MESSENGER_STATS_SQL).toContain('LEFT JOIN dialog_verdicts');
    for (const c of STATUS_CODES) expect(MESSENGER_STATS_SQL).toContain(`AS v_${c}`);
    expect(MESSENGER_STATS_SQL).toContain('AS v_unanalyzed');
  });

  test('общие фрагменты экспортируются и подставляются', () => {
    expect(PERSONAL_NON_SYSTEM_SQL).toContain(`<> 'system'`);
    expect(phoneFormsSql('x.p10')).toBe(`ARRAY['+7' || x.p10, '7' || x.p10, '8' || x.p10, x.p10]`);
    const rec = recCteSql({ salon: '$1', from: '$3', to: '$3' });
    expect(rec).toContain('r.salon_id = $1');
    expect(rec).toContain('BETWEEN $3::text AND $3::text');
    expect(BOOKED_CTE_SQL).toContain('FROM cl JOIN rec');
    expect(MESSENGER_STATS_SQL).toContain(recCteSql({ salon: '$1', from: '$2', to: '$3' }));
    expect(MESSENGER_STATS_SQL).toContain(BOOKED_CTE_SQL);
  });

  test('summarize собирает verdicts по каналу и в итогах; сумма статусов равна dialogs', () => {
    const rows = [
      { date: '2026-10-01', channel: 'tdlib', dialogs: 5, client_first: 3, client_first_no_phone: 0, booked_same_day: 2, booked_by_agent: 0,
        v_booked: 2, v_declined: 1, v_pending: 0, v_reschedule: 0, v_question: 1, v_broadcast_reply: 0, v_no_dialog: 0, v_other: 0, v_unanalyzed: 1 },
      { date: '2026-10-02', channel: 'tdlib', dialogs: '2', client_first: '1', client_first_no_phone: '0', booked_same_day: '0', booked_by_agent: '0',
        v_booked: '0', v_declined: '0', v_pending: '1', v_reschedule: '0', v_question: '0', v_broadcast_reply: '0', v_no_dialog: '0', v_other: '0', v_unanalyzed: '1' },
    ];
    const out = summarize(rows, { from: '2026-10-01', to: '2026-10-02' });
    expect(out.byChannel[0].verdicts).toEqual({ booked: 2, declined: 1, pending: 1, reschedule: 0, question: 1, broadcast_reply: 0, no_dialog: 0, other: 0, unanalyzed: 2 });
    expect(out.totals.verdicts).toEqual(out.byChannel[0].verdicts);
    const sum = Object.values(out.totals.verdicts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(out.totals.dialogs);
  });

  test('строки без v_* колонок (старый вызов) дают нули, а не NaN', () => {
    const out = summarize([{ date: '2026-10-01', channel: 'max', dialogs: 1, client_first: 1, client_first_no_phone: 0, booked_same_day: 0, booked_by_agent: 0 }], { from: '2026-10-01', to: '2026-10-01' });
    expect(out.totals.verdicts.booked).toBe(0);
    expect(out.totals.verdicts.unanalyzed).toBe(0);
  });
});

describe('messenger-stats: loadMessengerStats', () => {
  const { loadMessengerStats, MESSENGER_STATS_SQL } = require('./services/messenger-stats');

  test('передаёт salon_id, from, to параметрами $1..$3 и отдаёт строки db.any', async () => {
    const calls = [];
    const db = { any: async (sql, params) => { calls.push({ sql, params }); return [{ date: '2026-10-01', channel: 'tdlib', dialogs: 1, client_first: 1, client_first_no_phone: 0, booked_same_day: 0, booked_by_agent: 0 }]; } };
    const rows = await loadMessengerStats(7, '2026-10-01', '2026-10-03', { db });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(MESSENGER_STATS_SQL);
    expect(calls[0].params).toEqual([7, '2026-10-01', '2026-10-03']);
    expect(rows).toHaveLength(1);
  });

  test('SQL исключает автоуведомления и группы и использует ключ диалога «Чата»', () => {
    expect(MESSENGER_STATS_SQL).toMatch(/authored_by,\s*''\)\s*<>\s*'system'/);
    expect(MESSENGER_STATS_SQL).toMatch(/NOT LIKE '-%'/);
    expect(MESSENGER_STATS_SQL).toMatch(/NOT LIKE '%@g\.us'/);
    expect(MESSENGER_STATS_SQL).toMatch(/create_date/);
    // Ключ диалога — ТОТ ЖЕ, что в services/chat.js (одно правило на систему).
    const { DIALOG_KEY_SQL } = require('./services/chat');
    expect(MESSENGER_STATS_SQL).toContain(DIALOG_KEY_SQL);
  });
});
