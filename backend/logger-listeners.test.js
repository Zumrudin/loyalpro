'use strict';
const { createLogger } = require('./logger');

test('module loggers share one pipeline without adding transport listeners', () => {
  const first = createLogger('synthetic-a');
  const before = first.transports.map(t => t.eventNames().map(n => [n, t.listenerCount(n)]));
  const children = Array.from({ length: 100 }, (_, i) => createLogger(`synthetic-${i}`));
  expect(children.every(c => c.transports[0] === first.transports[0])).toBe(true);
  expect(first.transports.map(t => t.eventNames().map(n => [n, t.listenerCount(n)]))).toEqual(before);
  const write = jest.spyOn(Object.getPrototypeOf(first), 'write').mockImplementation(() => true);
  children[3].info('synthetic');
  expect(write.mock.calls[0][0].module).toBe('synthetic-3');
  write.mockRestore();
});
