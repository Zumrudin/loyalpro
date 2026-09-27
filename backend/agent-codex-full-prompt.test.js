'use strict';
const { safeRegistry, redact } = require('./scripts/mila-codex-full-prompt');
const ctx = { clientPhone: '7' + '0'.repeat(10) };

test('CRM writes and unknown tools never call actual handlers', async () => {
  const names = ['create_booking', 'cancel_booking', 'reschedule_booking', 'modify_booking_services', 'book_chain', 'new_unknown_write'];
  const fn = jest.fn();
  const handlers = Object.fromEntries(names.map(n => [n, fn]));
  const registry = safeRegistry({ handlers, schemas: [] }, 1, ctx.clientPhone, []);
  for (const name of names) expect(await registry.handlers[name](1, {}, ctx))
    .toMatchObject({ error: 'test_mode_write_blocked' });
  expect(fn).not.toHaveBeenCalled();
});

test('escalation is simulated and does not notify an operator', async () => {
  const real = jest.fn();
  const registry = safeRegistry({ handlers: { escalate_to_operator: real }, schemas: [] }, 1, ctx.clientPhone, []);
  expect(await registry.handlers.escalate_to_operator(1, { reason: 'synthetic' }, ctx))
    .toMatchObject({ escalated: true, testOnly: true });
  expect(real).not.toHaveBeenCalled();
});

test('rejects tenant mismatch before any handler', async () => {
  const real = jest.fn();
  const registry = safeRegistry({ handlers: { list_staff: real }, schemas: [] }, 1, ctx.clientPhone, []);
  await expect(registry.handlers.list_staff(2, {}, ctx)).rejects.toThrow('EVAL_CONTEXT_MISMATCH');
  expect(real).not.toHaveBeenCalled();
});

test('rejects missing or different patient context and other phone lookups', async () => {
  const real = jest.fn();
  const registry = safeRegistry({ handlers: { get_client: real }, schemas: [] }, 1, ctx.clientPhone, []);
  await expect(registry.handlers.get_client(1, {}, {})).rejects.toThrow('EVAL_CONTEXT_MISMATCH');
  expect(await registry.handlers.get_client(1, { phone: '7' + '1'.repeat(10) }, ctx))
    .toEqual({ error: 'test_phone_only' });
  expect(real).not.toHaveBeenCalled();
});

test('read handlers preserve arguments and results', async () => {
  const real = jest.fn(async () => ({ staff: [] }));
  const calls = [];
  const registry = safeRegistry({ handlers: { list_staff: real }, schemas: [] }, 1, ctx.clientPhone, calls);
  expect(await registry.handlers.list_staff(1, {}, ctx)).toEqual({ staff: [] });
  expect(real).toHaveBeenCalledWith(1, {}, ctx);
  expect(calls).toEqual([{ name: 'list_staff', simulated: false, error: false, degraded: false }]);
});

test('report redacts personal names', () => {
  expect(redact('Тестовый Клиент, здравствуйте!', ['Тестовый Клиент'])).toBe('[имя], здравствуйте!');
});
