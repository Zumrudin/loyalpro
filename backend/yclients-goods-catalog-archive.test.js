'use strict';
const { ARCHIVE_SQL } = require('./services/yclients-goods-catalog');

describe('архивация каталога («Уходы»)', () => {
  test('не трогает локальные товары склада (yclients_good_id IS NULL)', () => {
    expect(ARCHIVE_SQL).toMatch(/yclients_good_id IS NOT NULL/);
  });
  test('сохраняет 24-часовое условие устаревания', () => {
    expect(ARCHIVE_SQL).toMatch(/last_seen_at < NOW\(\) - INTERVAL '24 hours'/);
  });
});
