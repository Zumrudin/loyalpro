'use strict';

const { renderMemory, SLOT_TIMES_FRESH_MS } = require('./services/agent/tool-memory');

// 2026-08-04 12:00 мск = 09:00 UTC
const NOW = Date.parse('2026-08-04T09:00:00Z');
const MIN = 60 * 1000;

function ev(over = {}) {
  return { tool: 't', input: {}, result: {}, is_error: false, delivered: true, age_ms: 5 * MIN, ...over };
}

test('детерминизм: одинаковый вход → одинаковые строки', () => {
  const rows = [ev({ tool: 'search_knowledge_base', input: { query: 'акция' } })];
  expect(renderMemory(rows, { nowMs: NOW })).toEqual(renderMemory(rows, { nowMs: NOW }));
});

test('недоставленные ходы не рендерятся; write-инструменты — при любом delivered', () => {
  const rows = [
    ev({ tool: 'search_knowledge_base', input: { query: 'x' }, delivered: false }),
    ev({ tool: 'search_knowledge_base', input: { query: 'y' }, delivered: null }),
    ev({ tool: 'create_booking', input: { datetime: '2026-08-05T14:00:00+03:00' }, result: { record_id: 5 }, delivered: false }),
    ev({ tool: 'create_booking', input: { datetime: '2026-08-05T15:00:00+03:00' }, result: { record_id: 6 }, delivered: null }),
  ];
  const { lines } = renderMemory(rows, { nowMs: NOW });
  const joined = lines.join('\n');
  expect(joined).not.toMatch(/база знаний|x|y/);
  expect(joined).toMatch(/record_id=5/);
  expect(joined).toMatch(/record_id=6/);
});

test('ошибочные вызовы не рендерятся (даже write)', () => {
  const rows = [ev({ tool: 'create_booking', is_error: true, result: { error: 'занято' } })];
  expect(renderMemory(rows, { nowMs: NOW }).lines).toEqual([]);
});

test('свежие слоты (<30 мин) — с временами, старые — только факт запроса', () => {
  const slots = { slots: [{ time: '10:00' }, { time: '11:30' }] };
  const inp = { service_yc_id: 7, staff_yc_id: 55, date: '2026-08-05' };
  const fresh = renderMemory([ev({ tool: 'get_available_slots', input: inp, result: slots, age_ms: 10 * MIN })], { nowMs: NOW });
  expect(fresh.lines[0]).toMatch(/10:00, 11:30/);
  const stale = renderMemory([ev({ tool: 'get_available_slots', input: inp, result: slots, age_ms: SLOT_TIMES_FRESH_MS + MIN })], { nowMs: NOW });
  expect(stale.lines[0]).not.toMatch(/10:00|11:30/);
  expect(stale.lines[0]).toMatch(/устарел/);
  expect(stale.lines[0]).toMatch(/2026-08-05/);
});

test('PII-аргументы не попадают в рендер (в т.ч. через фолбэк)', () => {
  // Инструмент намеренно НЕИЗВЕСТНЫЙ: фолбэк живёт только для таких (у всех
  // зарегистрированных есть экстрактор либо запись в SKIP_TOOLS).
  const rows = [ev({ tool: 'some_new_tool', input: { client_phone: '79991234567', client_name: 'Мария Ивановна', comment: 'секрет' }, result: { balance: 100 } })];
  const joined = renderMemory(rows, { nowMs: NOW }).lines.join('\n');
  expect(joined).not.toMatch(/79991234567|Мария|секрет/);
  expect(joined).toMatch(/some_new_tool/);
  expect(joined).toMatch(/balance=100/);
});

test('метка времени: сегодня / вчера / дата (мск)', () => {
  const mk = (age) => renderMemory([ev({ tool: 'search_knowledge_base', input: { query: 'q' }, age_ms: age })], { nowMs: NOW }).lines[0];
  expect(mk(30 * MIN)).toMatch(/^\[сегодня 11:30\]/);
  expect(mk(24 * 60 * MIN)).toMatch(/^\[вчера 12:00\]/);
  // Метка старше «вчера» рендерится ISO-датой (детерминизм важнее красоты):
  // nowMs - 47ч = 2026-08-02T13:00 мск.
  expect(mk(47 * 60 * MIN)).toMatch(/^\[2026-08-02 13:00\]/);
});

test('кап событий: write выживают, старые read срезаются', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(ev({ tool: 'search_knowledge_base', input: { query: `q${i}` }, age_ms: (100 - i) * MIN }));
  rows.unshift(ev({ tool: 'create_booking', input: { datetime: '2026-08-05T14:00:00+03:00' }, result: { record_id: 1 }, age_ms: 200 * MIN }));
  const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
  expect(lines.length).toBeLessThanOrEqual(30);
  expect(lines.join('\n')).toMatch(/record_id=1/);   // старейший write не срезан
  expect(dropped).toBeGreaterThan(0);
  expect(lines.join('\n')).not.toMatch(/«q0»/);       // старейший read срезан
});

test('кап событий на границе: writes >= MAX_EVENTS вытесняет ВСЕ read (регресс slice(-0))', () => {
  // reads.slice(-0) в JS эквивалентен reads.slice(0) — весь массив, а не пустой
  // срез. При writes.length >= MAX_EVENTS бюджет на read равен нулю: без явной
  // проверки нуля этот баг тихо возвращал бы все read-события и dropped=0.
  function writesN(n) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push(ev({ tool: 'create_booking', input: { datetime: '2026-08-05T14:00:00+03:00' }, result: { record_id: i + 1 }, age_ms: (500 - i) * MIN }));
    }
    return arr;
  }
  function readsN(n) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push(ev({ tool: 'search_knowledge_base', input: { query: `r${i}` }, age_ms: (50 - i) * MIN }));
    }
    return arr;
  }

  // Ровно MAX_EVENTS (30) write — бюджет на read равен нулю.
  {
    const rows = [...writesN(30), ...readsN(10)];
    const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
    expect(lines.length).toBe(30);
    expect(lines.every(l => /record_id=/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/база знаний/);
    expect(dropped).toBe(10);
  }

  // Больше MAX_EVENTS (35) write — write не срезаются никогда, но read всё
  // равно должны уйти целиком, а не просочиться через отрицательный ноль.
  {
    const rows = [...writesN(35), ...readsN(10)];
    const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
    expect(lines.length).toBeLessThanOrEqual(35);
    expect(lines.every(l => /record_id=/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/база знаний/);
    expect(dropped).toBe(10);
  }
});

test('кап символов: длинный журнал усыхает, write остаются', () => {
  const rows = [ev({ tool: 'create_booking', input: { datetime: '2026-08-05T14:00:00+03:00' }, result: { record_id: 9 }, age_ms: 90 * MIN })];
  for (let i = 0; i < 29; i++) rows.push(ev({ tool: 'search_knowledge_base', input: { query: 'о'.repeat(200) }, age_ms: (80 - i) * MIN }));
  const { lines } = renderMemory(rows, { nowMs: NOW });
  expect(lines.join('\n').length).toBeLessThanOrEqual(4000 + 200);
  expect(lines.join('\n')).toMatch(/record_id=9/);
});

test('экстрактор цен: get_service_masters рендерит мастеров с price_display', () => {
  const rows = [ev({ tool: 'get_service_masters', result: { services: [{ title: 'Комплекс 5в1', staff: [{ name: 'Юлия', price_display: '19 000 ₽' }, { name: 'Пери', price_display: '23 000 ₽' }] }] } })];
  const line = renderMemory(rows, { nowMs: NOW }).lines[0];
  expect(line).toMatch(/«Комплекс 5в1»/);
  expect(line).toMatch(/Юлия 19 000 ₽/);
  expect(line).toMatch(/Пери 23 000 ₽/);
});

test('экстрактор book_chain: частичная цепочка помечается', () => {
  const rows = [ev({ tool: 'book_chain', result: { partial: true, records: [{ record_id: 1, datetime: '2026-08-05T14:00:00+03:00' }] } })];
  expect(renderMemory(rows, { nowMs: NOW }).lines[0]).toMatch(/ЧАСТИЧНО/);
});

test('история визитов: счётчик и первые визиты', () => {
  const rows = [ev({ tool: 'get_client_visit_history', result: { visits: [{ date: '2026-07-01', services: [{ title: 'Чистка' }] }, { date: '2026-06-01', services: [{ title: 'Пилинг' }] }] } })];
  const line = renderMemory(rows, { nowMs: NOW }).lines[0];
  expect(line).toMatch(/2 /);
  expect(line).toMatch(/Чистка/);
});

test('битые строки (не-JSON input/result) не роняют рендер', () => {
  const rows = [ev({ tool: 'x', input: 'не json', result: undefined })];
  expect(() => renderMemory(rows, { nowMs: NOW })).not.toThrow();
});

test('PII в РЕЗУЛЬТАТЕ неизвестного инструмента не течёт через фолбэк', () => {
  // Ни один существующий инструмент так не делает (персональные поля всегда
  // внутри объектов/массивов) — это репро для правдоподобного будущего
  // инструмента, кладущего PII СКАЛЯРОМ верхнего уровня результата.
  const rows = [ev({
    tool: 'some_new_tool',
    input: {},
    result: { client_full_name: 'Иванова Мария Петровна', client_phone: '79991234567', contact_email: 'm@example.com', ok: true },
  })];
  const joined = renderMemory(rows, { nowMs: NOW }).lines.join('\n');
  expect(joined).not.toMatch(/Иванова|Мария|Петровна|79991234567|m@example\.com/);
  expect(joined).toMatch(/some_new_tool/);
  expect(joined).toMatch(/ok=true/);
});

test('dropped считает ТОЛЬКО срезанное капом, а не факты-пустышки экстракторов', () => {
  const rows = [
    ev({ tool: 'book_chain', result: { booked_all: false, records: [] } }),        // экстрактор → null
    ev({ tool: 'get_service_masters', result: { services: [] } }),                  // экстрактор → null
  ];
  const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
  expect(lines).toEqual([]);
  expect(dropped).toBe(0);   // ничего не срезано капом — экстракторам просто нечего сказать
});

test('хронология одного хода: события с ОДИНАКОВЫМ age_ms сохраняют исходный порядок', () => {
  // created_at общий для всего хода (один multi-row INSERT DEFAULT NOW()) —
  // tsMs совпадает; без тай-брейка по исходному индексу writes.concat(reads)
  // всегда ставил бы write перед read, даже если по факту она была первой.
  const rows = [
    ev({ tool: 'get_client_visit_history', result: { visits: [{ datetime: '2026-08-01', services: ['Чистка'] }] }, age_ms: 5 * MIN }),
    ev({ tool: 'create_booking', input: { datetime: '2026-08-05T14:00:00+03:00' }, result: { record_id: 42 }, age_ms: 5 * MIN }),
  ];
  const { lines } = renderMemory(rows, { nowMs: NOW });
  expect(lines.length).toBe(2);
  expect(lines[0]).toMatch(/читала историю визитов/);
  expect(lines[1]).toMatch(/record_id=42/);
});

describe('SKIP_TOOLS: инструменты, которых в памяти быть не должно', () => {
  test('escalate_to_operator не даёт строки (закрытый конфликт не тянем назад)', () => {
    // После «Вернуть боту» промпт отдельным блоком велит считать конфликт
    // РАЗРЕШЁННЫМ; строка «escalated=true, reason=пациент недоволен…» лежала бы
    // в САМОМ хвосте промпта, свежее этого блока, и провоцировала ре-эскалацию.
    const rows = [ev({ tool: 'escalate_to_operator', input: { reason: 'пациент недоволен ценой' }, result: { escalated: true, reason: 'пациент недоволен ценой' } })];
    const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
    expect(lines).toEqual([]);
    expect(dropped).toBe(0);   // не срез капом — событие просто не рендерится
  });

  test('живые персональные данные и статические справочники не рендерятся', () => {
    const rows = [
      ev({ tool: 'get_bonus_balance', result: { found: true, cards: [{ balance: 1500 }] } }),
      ev({ tool: 'get_client_abonements', result: { abonements: [], note: 'Активных абонементов не найдено.' } }),
      ev({ tool: 'get_client', input: { phone: '79991234567' }, result: { found: true } }),
      ev({ tool: 'list_staff', result: { staff: [{ yc_id: 1, name: 'Юлия' }] } }),
      ev({ tool: 'list_services', result: { services: [{ yc_id: 1, title: 'Чистка' }] } }),
    ];
    expect(renderMemory(rows, { nowMs: NOW }).lines).toEqual([]);
  });

  test('скипнутые события не съедают бюджет MAX_EVENTS', () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(ev({ tool: 'get_bonus_balance', result: { found: true }, age_ms: (200 - i) * MIN }));
    rows.push(ev({ tool: 'search_knowledge_base', input: { query: 'акция' }, age_ms: 5 * MIN }));
    const { lines, dropped } = renderMemory(rows, { nowMs: NOW });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/акция/);
    expect(dropped).toBe(0);
  });

  test('каждый зарегистрированный инструмент — либо экстрактор, либо SKIP_TOOLS (фолбэк только для неизвестных)', () => {
    // Фолбэк «tool(args) → k=v» задуман для инструмента, которого ещё нет в
    // tool-memory. На зарегистрированном он даёт строку-пустышку («list_staff()»),
    // которая занимает место в бюджете и ничего не сообщает. Тест ловит новый
    // инструмент, добавленный в реестр мимо этого файла.
    const registry = require('./services/agent/tools');
    const names = new Set(registry.schemas.map(s => s.name));
    for (const n of Object.keys(registry.catalogMode.handlers)) names.add(n);
    for (const tool of names) {
      const line = renderMemory([ev({ tool, input: {}, result: {} })], { nowMs: NOW }).lines[0];
      if (line === undefined) continue;   // скип или экстрактор без факта — ок
      expect(line).not.toContain(`${tool}(`);
    }
  });
});

test('get_available_dates: свежий график — с часами, устаревший — только факт', () => {
  const res = { schedule: [{ date: '2026-08-05', hours: [{ from: '10:00', to: '18:00' }] }], working_days_count: 1 };
  const inp = { staff_yc_id: 55, date_from: '2026-08-05', date_to: '2026-08-10' };
  const fresh = renderMemory([ev({ tool: 'get_available_dates', input: inp, result: res, age_ms: 10 * MIN })], { nowMs: NOW });
  expect(fresh.lines[0]).toMatch(/2026-08-05 10:00-18:00/);
  const stale = renderMemory([ev({ tool: 'get_available_dates', input: inp, result: res, age_ms: SLOT_TIMES_FRESH_MS + MIN })], { nowMs: NOW });
  expect(stale.lines[0]).not.toMatch(/10:00-18:00/);
  expect(stale.lines[0]).toMatch(/устарел/);
  expect(stale.lines[0]).toMatch(/staff_yc_id=55/);
});

test('get_parallel_slots: свежие старты — с временем, устаревшие — только факт', () => {
  const res = { date: '2026-08-05', starts: [{ time: '12:00', guests: [] }, { time: '13:00', guests: [] }] };
  const inp = { date: '2026-08-05', guests: [{ service_yc_id: 1, staff_yc_id: 10 }, { service_yc_id: 2, staff_yc_id: 20 }] };
  const fresh = renderMemory([ev({ tool: 'get_parallel_slots', input: inp, result: res, age_ms: 10 * MIN })], { nowMs: NOW });
  expect(fresh.lines[0]).toMatch(/12:00, 13:00/);
  const stale = renderMemory([ev({ tool: 'get_parallel_slots', input: inp, result: res, age_ms: SLOT_TIMES_FRESH_MS + MIN })], { nowMs: NOW });
  expect(stale.lines[0]).not.toMatch(/12:00|13:00/);
  expect(stale.lines[0]).toMatch(/устарел/);
});

test('get_sequential_slots: свежие варианты — с временем и БЕЗ option_id; устаревшие — только факт', () => {
  const res = {
    requested_date: '2026-08-05',
    variants: [{
      type: 'same_staff', date: '2026-08-05', staff: [{ yc_id: 10, name: 'Юлия' }],
      starts: [{ time: '12:00', option_id: 'o1', gap_minutes: 0, booking_mode: 'single_record', chain: [{ option_id: 'o1-leak' }] }],
    }],
  };
  const inp = { services: [{ service_yc_id: 1 }, { service_yc_id: 2 }], date: '2026-08-05' };
  const fresh = renderMemory([ev({ tool: 'get_sequential_slots', input: inp, result: res, age_ms: 10 * MIN })], { nowMs: NOW });
  expect(fresh.lines[0]).toMatch(/12:00/);
  expect(fresh.lines[0]).toMatch(/Юлия/);
  expect(fresh.lines[0]).not.toMatch(/o1|option_id/);
  const stale = renderMemory([ev({ tool: 'get_sequential_slots', input: inp, result: res, age_ms: SLOT_TIMES_FRESH_MS + MIN })], { nowMs: NOW });
  expect(stale.lines[0]).not.toMatch(/12:00|Юлия/);
  expect(stale.lines[0]).toMatch(/устарел/);
});

describe('память: get_available_slots — мастера нет в графике', () => {
  // Инцидент 2026-08-10 (79166524647): у мастера отпуск, но и выдача, и журнал
  // говорили одно и то же — «свободного времени не было». Следующим ходом это
  // читается как «день был расписан», и модель идёт перебирать соседние даты,
  // хотя мастера нет в графике ещё три недели.
  const INPUT = { service_yc_id: 900, staff_yc_id: 1910274, date: '2026-08-14' };

  test('отпуск в журнале звучит как отпуск, а не как занятость', () => {
    const res = { slots: [], staff_not_working: true, staff_next_working_date: '2026-09-01' };
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: res, age_ms: 10 * MIN })],
      { nowMs: NOW });
    expect(lines[0]).toMatch(/не работа/i);
    expect(lines[0]).toMatch(/2026-09-01/);
    expect(lines[0]).not.toMatch(/свободного времени не было/);
  });

  test('занятый день по-прежнему занятый день', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: { slots: [] }, age_ms: 10 * MIN })],
      { nowMs: NOW });
    expect(lines[0]).toMatch(/свободного времени не было/);
    expect(lines[0]).not.toMatch(/не работа/i);
  });
});

describe('память: get_available_slots без мастера (выбор специалиста)', () => {
  // Пациент мастера не называл → инструмент вернул окна всех исполнителей
  // (staff_options вместо slots). Экстрактор, читавший только res.slots, писал
  // в журнал «staff_yc_id=undefined … свободного времени не было» — прямую ложь
  // о том, что модель тем же ходом показала пациенту.
  const OPTIONS = {
    staff_options: [
      { staff_yc_id: 11, name: 'Юлия', position: 'косметолог-эстетист', slots: [{ time: '12:00' }, { time: '14:00' }] },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: 'главный врач', slots: [{ time: '15:00' }] },
    ],
  };
  const INPUT = { service_yc_id: 900, date: '2026-08-02' };   // staff_yc_id не передавался

  test('времена всех показанных мастеров попадают в выжимку', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: OPTIONS, age_ms: 10 * MIN })],
      { nowMs: NOW });
    expect(lines[0]).toMatch(/Юлия/);
    expect(lines[0]).toMatch(/12:00, 14:00/);
    expect(lines[0]).toMatch(/Пери Исамудиновна/);
    expect(lines[0]).toMatch(/15:00/);
    expect(lines[0]).not.toMatch(/свободного времени не было/);
    expect(lines[0]).not.toMatch(/undefined/);
  });

  test('устаревшее событие времён не показывает', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: OPTIONS, age_ms: SLOT_TIMES_FRESH_MS + MIN })],
      { nowMs: NOW });
    expect(lines[0]).not.toMatch(/12:00|15:00/);
    expect(lines[0]).toMatch(/перезапроси/);
  });

  test('«ни у кого» — только когда все исполнители реально ответили', () => {
    // Тот же водораздел, что в самом инструменте (no_staff_available выставляется
    // лишь при reachable === total): недостижимый из-за сбоя YClients мастер не
    // должен превращаться в журнале в «занят» — иначе модель следующим ходом
    // объявит пациенту выдуманный отказ клиники.
    const all = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: { staff_options: [], no_staff_available: true }, age_ms: MIN })],
      { nowMs: NOW });
    expect(all.lines[0]).toMatch(/ни у кого/);
    const partial = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: { staff_options: [] }, age_ms: MIN })],
      { nowMs: NOW });
    expect(partial.lines[0]).not.toMatch(/ни у кого/);
    expect(partial.lines[0]).toMatch(/не всех/);
  });

  // Усечение без многоточия читается как полный список: следующим ходом модель
  // видит «Юлия: 12:00, …, 14:30» и может заявить пациенту «больше окон нет».
  // Одномастерная ветка многоточие ставит — мультимастерная обязана тоже.
  test('усечённые списки помечены многоточием — и времена, и мастера', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ time: `1${i}:00` }));
    const { lines } = renderMemory([ev({
      tool: 'get_available_slots', input: INPUT, age_ms: MIN,
      result: { staff_options: [
        { staff_yc_id: 11, name: 'Юлия', slots: many(8) },
        { staff_yc_id: 12, name: 'Татьяна', slots: [{ time: '15:00' }] },
        { staff_yc_id: 13, name: 'Мария', slots: [{ time: '16:00' }] },
        { staff_yc_id: 14, name: 'Анна', slots: [{ time: '17:00' }] },
      ] },
    })], { nowMs: NOW });
    expect(lines[0]).toMatch(/Юлия: 10:00, 11:00, 12:00, 13:00, 14:00, 15:00…/);
    expect(lines[0]).not.toMatch(/Анна/);
    expect(lines[0]).toMatch(/16:00…$/);   // мастера тоже срезаны — многоточие в конце
  });

  test('полные списки многоточием не помечаются', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: OPTIONS, age_ms: MIN })],
      { nowMs: NOW });
    expect(lines[0]).not.toMatch(/…/);
  });

  test('одномастерный режим не изменился: id мастера в строке', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INPUT, staff_yc_id: 55 }, result: { slots: [{ time: '10:00' }] }, age_ms: MIN })],
      { nowMs: NOW });
    expect(lines[0]).toMatch(/staff_yc_id=55/);
    expect(lines[0]).toMatch(/показаны 10:00/);
  });
});

describe('память: рендерятся ПОКАЗАННЫЕ времена, а не начало slots', () => {
  const INP = { service_yc_id: 9536676, date: '2026-08-07' };
  const ALL = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'].map(t => ({ time: t }));
  const OFFER = [{ time: '14:00' }, { time: '13:30' }];

  // В журнал должно попадать то, что пациент реально услышал: иначе следующим
  // ходом модель процитирует время, которое сама никогда не предлагала.
  test('одномастерная выдача: в память идёт offer_slots с многоточием', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274 }, age_ms: MIN,
        result: { slots: ALL, offer_slots: OFFER } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('14:00, 13:30…');
    expect(lines.join('\n')).not.toContain('11:00');
  });

  test('staff_options: в память идёт offer_slots каждого мастера', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INP, age_ms: MIN,
        result: { staff_options: [{ name: 'Пери', slots: ALL, offer_slots: OFFER }] } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('Пери: 14:00, 13:30…');
  });

  // Свободный день: времени пациенту не называли ВООБЩЕ (спрашивали половину дня).
  // Без этой ветки фолбэк на slots писал бы в память «показаны 11:00, 11:30…» —
  // времена, которых пациент не слышал, и следующим ходом модель на них ссылается.
  test('free_day: в память идёт факт «весь день свободен», а не времена из slots', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274 }, age_ms: MIN,
        result: { slots: ALL, offer_slots: [], free_day: true } })], { nowMs: NOW });
    expect(lines.join('\n')).toMatch(/весь день свободен/);
    expect(lines.join('\n')).not.toContain('11:00');
  });

  test('free_day у мастера в staff_options: имя есть, времени нет', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INP, age_ms: MIN,
        result: { staff_options: [
          { name: 'Пери', slots: ALL, offer_slots: [], free_day: true },
          { name: 'Юлия', slots: ALL, offer_slots: OFFER },
        ] } })], { nowMs: NOW });
    const text = lines.join('\n');
    expect(text).toMatch(/Пери: весь день свободен/);
    expect(text).toContain('Юлия: 14:00, 13:30…');
    expect(text).not.toContain('11:00');
  });

  // Половина дня, названная пациентом, объясняет, почему времён мало: без неё
  // следующим ходом модель читает узкую выдачу как «больше ничего нет».
  test('day_part попадает в строку памяти', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274, day_part: 'evening' },
        age_ms: MIN, result: { slots: ALL, offer_slots: OFFER } })], { nowMs: NOW });
    expect(lines[0]).toContain('day_part=evening');
  });

  // События, записанные ДО выката, offer_slots не имеют, а память читает журнал
  // за 48 часов — для них поведение обязано остаться прежним.
  test('события без offer_slots рендерятся по slots, как раньше', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274 }, age_ms: MIN,
        result: { slots: ALL } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('11:00');
  });
});

test('send_price_list: в памяти остаётся факт отправленного прайса', () => {
  const ok = renderMemory([ev({
    tool: 'send_price_list',
    input: { category: 'c12' },
    result: { attached: true, category: 'Лазерная эпиляция', photos: 2 },
    age_ms: 5 * MIN,
  })], { nowMs: NOW }).lines[0];
  expect(ok).toContain('Лазерная эпиляция');
  expect(ok).toContain('2');
  expect(ok).not.toContain('send_price_list(');

  const fail = renderMemory([ev({
    tool: 'send_price_list',
    input: { category: 'c30' },
    result: { attached: false, reason: 'no_photo', category: 'Инъекции' },
    age_ms: 5 * MIN,
  })], { nowMs: NOW }).lines[0];
  expect(fail).toMatch(/не отправ/i);
});
