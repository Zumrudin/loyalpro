'use strict';

// HTTP-контракт загрузки прайса. Сеть не поднимаем: проверяем, что маршруты
// объявлены в правильном порядке и что коды ошибок разведены.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'routes/agent-settings.js'), 'utf8');

test('reorder объявлен ДО /:id — иначе path-матчер съест «reorder» как id', () => {
  const reorder = SRC.indexOf(`'/price-photos/reorder'`);
  const byId = SRC.indexOf(`'/price-photos/:id'`);
  expect(reorder).toBeGreaterThan(-1);
  expect(byId).toBeGreaterThan(-1);
  expect(reorder).toBeLessThan(byId);
});

test('кап на узел и битый узел разведены на разные ответы', () => {
  expect(SRC).toContain(`PHOTO_LIMIT`);
  expect(SRC).toContain(`BAD_NODE`);
});

test('загрузка ограничена картинками и 5 МБ', () => {
  expect(SRC).toContain('imageFileFilter');
  expect(SRC).toMatch(/fileSize:\s*5 \* 1024 \* 1024/);
});

test('удаление снимает файл с диска', () => {
  expect(SRC).toContain('safeUnlink');
});
