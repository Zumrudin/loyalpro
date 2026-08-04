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
  const rows = [ev({ tool: 'get_bonus_balance', input: { client_phone: '79991234567', client_name: 'Мария Ивановна', comment: 'секрет' }, result: { balance: 100 } })];
  const joined = renderMemory(rows, { nowMs: NOW }).lines.join('\n');
  expect(joined).not.toMatch(/79991234567|Мария|секрет/);
  expect(joined).toMatch(/get_bonus_balance/);
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
