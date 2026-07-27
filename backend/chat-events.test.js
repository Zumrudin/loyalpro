'use strict';
const events = require('./services/chat-events');

function fakeRes() {
  const chunks = [];
  return {
    chunks,
    write: (s) => chunks.push(s),
    on: function (ev, cb) { if (ev === 'close') this._close = cb; return this; },
  };
}

describe('chat-events', () => {
  test('emit доставляет событие подписчику своего салона и не трогает чужой', () => {
    const a = fakeRes(), b = fakeRes();
    events.subscribe(1, a);
    events.subscribe(2, b);
    events.emit(1, { type: 'message', dialogKey: 'k' });
    expect(a.chunks.some(c => c.includes('"dialogKey":"k"'))).toBe(true);
    expect(b.chunks.length).toBe(0);
    events.unsubscribe(1, a); events.unsubscribe(2, b);
  });
  test('после unsubscribe события не приходят', () => {
    const a = fakeRes();
    events.subscribe(1, a);
    events.unsubscribe(1, a);
    events.emit(1, { type: 'message' });
    expect(a.chunks.length).toBe(0);
  });
  test('упавший write не роняет emit и отписывает подписчика', () => {
    const bad = { write: () => { throw new Error('broken pipe'); }, on() { return this; } };
    const ok = fakeRes();
    events.subscribe(1, bad);
    events.subscribe(1, ok);
    expect(() => events.emit(1, { type: 'message' })).not.toThrow();
    expect(ok.chunks.length).toBe(1);
    events.unsubscribe(1, ok);
    events.emit(1, { type: 'message' });   // bad уже отписан — не бросает
  });
});
