'use strict';
// repointChatRow: эхо шлюза уже заняло api:<новый id> → старую строку не
// перецепляем (UNIQUE), а удаляем. SQL-форма проверяется на моке драйвера.
jest.mock('./db', () => ({ db: { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
const { db } = require('./db');
const { _store } = require('./services/agent/delivery-watchdog');

test('repointChatRow: один запрос, salon-scoped, DELETE старой при существующей новой, UPDATE иначе', async () => {
  await _store().repointChatRow(7, 'g12', 'g13');
  expect(db.query).toHaveBeenCalledTimes(1);
  const [sql, params] = db.query.mock.calls[0];
  expect(params).toEqual([7, 'api:g12', 'api:g13']);
  expect(sql).toMatch(/DELETE FROM chatpush_messages\s+WHERE salon_id = \$1 AND external_message_id = \$2\s+AND EXISTS \(SELECT 1 FROM chatpush_messages WHERE salon_id = \$1 AND external_message_id = \$3\)/);
  expect(sql).toMatch(/UPDATE chatpush_messages SET external_message_id = \$3[\s\S]*AND NOT EXISTS \(SELECT 1 FROM chatpush_messages WHERE salon_id = \$1 AND external_message_id = \$3\)/);
});
