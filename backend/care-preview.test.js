'use strict';
const { matchVisits } = require('./services/care/preview');

const TOUCHES = [
  { id: 1, title: 'Т+1 самочувствие', delay_days: 1, send_time: '10:30' },
  { id: 2, title: 'Т+14 контроль',    delay_days: 14, send_time: '12:00' },
];

// 2026-08-03 12:00 мск
const NOW = new Date('2026-08-03T09:00:00Z').getTime();

function rec(over = {}) {
  return {
    id: 100, date: '2026-08-01 14:00:00', attendance: 1, paid_full: 0,
    staff: { id: 55, name: 'Пери' },
    services: [{ id: 900, title: 'Биоревитализация' }],
    client: { id: 7, name: 'Анна', phone: '+7 (920) 025-55-91' },
    ...over,
  };
}

describe('matchVisits — критерий «визит состоялся»', () => {
  test('attendance=1 и paid_full=1 проходят, ожидание/неявка — нет', () => {
    const { totals } = matchVisits({
      records: [
        rec({ id: 1, attendance: 1 }),
        rec({ id: 2, attendance: 0, paid_full: 1 }),
        rec({ id: 3, attendance: 0, paid_full: 0 }),
        rec({ id: 4, attendance: -1, paid_full: 1 }),
      ],
      conditions: { logic: 'and', items: [] }, touches: TOUCHES, nowMs: NOW,
    });
    expect(totals.records).toBe(4);
    // attendance=-1 несёт paid_full=1 — isVisitCompleted его пропускает как
    // состоявшийся; отсев неявки живёт в classifyRecordEvent (вебхук), не здесь.
    expect(totals.completed).toBe(3);
  });
});

describe('matchVisits — условия отбора', () => {
  test('условие по мастеру отсекает чужие визиты', () => {
    const { totals, rows } = matchVisits({
      records: [rec({ id: 1, staff: { id: 55, name: 'Пери' } }),
                rec({ id: 2, staff: { id: 66, name: 'Юлия' }, client: { phone: '79001112233' } })],
      conditions: { logic: 'and', items: [{ type: 'staff', ids: [55] }] },
      touches: TOUCHES, nowMs: NOW,
    });
    expect(totals.matched).toBe(1);
    expect(rows[0].recordId).toBe(1);
  });

  test('условие по категории работает через catMap', () => {
    const catMap = new Map([['900', '12']]);
    const args = {
      records: [rec()], touches: TOUCHES, nowMs: NOW,
      conditions: { logic: 'and', items: [{ type: 'category', ids: [12] }] },
    };
    expect(matchVisits({ ...args, catMap }).totals.matched).toBe(1);
    expect(matchVisits({ ...args }).totals.matched).toBe(0); // пустая карта не матчит
  });

  test('пустые условия = любой состоявшийся визит', () => {
    const { totals } = matchVisits({
      records: [rec()], conditions: { logic: 'and', items: [] }, touches: TOUCHES, nowMs: NOW,
    });
    expect(totals.matched).toBe(1);
  });
});

describe('matchVisits — отсев и перекрытие', () => {
  const conditions = { logic: 'and', items: [] };

  test('клиент без телефона попадает в строки, но с skipReason=no_phone', () => {
    const { totals, rows } = matchVisits({
      records: [rec({ client: { name: 'Без номера', phone: '' } })],
      conditions, touches: TOUCHES, nowMs: NOW,
    });
    expect(rows[0].skipReason).toBe('no_phone');
    expect(rows[0].touches).toEqual([]);
    expect(totals.willEnroll).toBe(0);
  });

  test('клиент из ЧС отсекается по каноничному номеру', () => {
    const { rows } = matchVisits({
      records: [rec()], conditions, touches: TOUCHES, nowMs: NOW,
      blacklisted: new Set(['79200255591']),
    });
    expect(rows[0].skipReason).toBe('blacklist');
  });

  test('несколько визитов одного клиента: живёт только самый поздний', () => {
    const { totals, rows } = matchVisits({
      records: [
        rec({ id: 1, date: '2026-07-01 10:00:00' }),
        rec({ id: 2, date: '2026-08-01 10:00:00' }),
        rec({ id: 3, date: '2026-06-01 10:00:00' }),
      ],
      conditions, touches: TOUCHES, nowMs: NOW,
    });
    expect(rows.map(r => r.recordId)).toEqual([2, 1, 3]);   // свежие сверху
    expect(rows[0].skipReason).toBeNull();
    expect(rows[1].skipReason).toBe('superseded');
    expect(rows[2].skipReason).toBe('superseded');
    expect(totals.willEnroll).toBe(1);
    expect(totals.clients).toBe(1);
    expect(totals.excluded).toBe(2);
  });

  test('разные клиенты друг друга не перекрывают', () => {
    const { totals } = matchVisits({
      records: [rec({ id: 1 }), rec({ id: 2, client: { phone: '79001112233' } })],
      conditions, touches: TOUCHES, nowMs: NOW,
    });
    expect(totals.willEnroll).toBe(2);
    expect(totals.clients).toBe(2);
  });
});

describe('matchVisits — расписание касаний', () => {
  test('касания считаются от даты визита, прошедшие помечены past', () => {
    const { rows } = matchVisits({
      records: [rec({ date: '2026-08-01 14:00:00' })],
      conditions: { logic: 'and', items: [] }, touches: TOUCHES, nowMs: NOW,
    });
    const [t1, t2] = rows[0].touches;
    expect(t1.scheduledAt).toBe(new Date('2026-08-02T10:30:00+03:00').toISOString());
    expect(t1.past).toBe(true);                    // 02.08 уже прошло
    expect(t2.scheduledAt).toBe(new Date('2026-08-15T12:00:00+03:00').toISOString());
    expect(t2.past).toBe(false);
  });

  test('битая дата визита не роняет превью', () => {
    const { rows } = matchVisits({
      records: [rec({ date: 'мусор' })],
      conditions: { logic: 'and', items: [] }, touches: TOUCHES, nowMs: NOW,
    });
    expect(rows[0].visitAt).toBeNull();
    expect(rows[0].touches.every(t => t.scheduledAt === null)).toBe(true);
  });
});
