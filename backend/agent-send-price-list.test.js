'use strict';

// Инструмент НИЧЕГО не отправляет: он кладёт вложения в буфер хода, а шлёт их
// диспетчер вместе с текстом. Так ход остаётся без side-effect и его можно
// выбросить при серии сообщений.

const priceList = require('./services/agent/price-list');
const tool = require('./services/agent/tools/send-price-list');

const index = () => priceList.buildIndex({
  categories: [{ id: 12, title: 'Лазерная эпиляция' }, { id: 30, title: 'Инъекции' }],
  subcats: [{ id: 7, yc_category_id: 30, parent_id: null, title: 'Биоревитализация' }],
  photos: [
    { id: 1, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/a.jpg', file_name: 'a.jpg', mime_type: 'image/jpeg' },
    { id: 2, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/b.jpg', file_name: 'b.jpg', mime_type: 'image/jpeg' },
  ],
  priceListUrl: 'https://peri.ru/price',
});

const ctx = (over) => ({ channel: 'whatsapp', priceIndex: index(), attachments: [], ...over });

test('фото кладутся в буфер хода, ничего не отправляется', async () => {
  const c = ctx();
  const res = await tool.run(1, { category: 'c12' }, c);
  expect(res.attached).toBe(true);
  expect(res.photos).toBe(2);
  expect(res.category).toBe('Лазерная эпиляция');
  expect(c.attachments).toHaveLength(2);
  expect(c.attachments[0]).toMatchObject({ nodeKey: 'c12', fileUrl: '/uploads/a.jpg', mimeType: 'image/jpeg' });
});

test('повторный вызов той же категории в ОДНОМ ходу не задваивает файлы', async () => {
  const c = ctx();
  await tool.run(1, { category: 'c12' }, c);
  const res = await tool.run(1, { category: 'c12' }, c);
  expect(res.already_attached).toBe(true);
  expect(c.attachments).toHaveLength(2);
});

test('своих фото нет — берутся родительские (подъём по дереву)', async () => {
  const c = ctx({
    priceIndex: priceList.buildIndex({
      categories: [{ id: 30, title: 'Инъекции' }],
      subcats: [{ id: 7, yc_category_id: 30, parent_id: null, title: 'Биоревитализация' }],
      photos: [{ id: 9, yc_category_id: 30, subcategory_id: null, file_url: '/uploads/x.jpg', file_name: 'x.jpg', mime_type: 'image/jpeg' }],
      priceListUrl: null,
    }),
  });
  const res = await tool.run(1, { category: 's7' }, c);
  expect(res.attached).toBe(true);
  expect(c.attachments).toHaveLength(1);
});

test('фото нет вовсе → no_photo + ссылка на сайт, буфер пуст', async () => {
  const c = ctx();
  const res = await tool.run(1, { category: 'c30' }, c);
  expect(res).toMatchObject({ attached: false, reason: 'no_photo', price_list_url: 'https://peri.ru/price' });
  expect(c.attachments).toHaveLength(0);
});

test('канал не умеет файлы → channel_unsupported, буфер пуст', async () => {
  const c = ctx({ channel: 'telegram_bot' });
  const res = await tool.run(1, { category: 'c12' }, c);
  expect(res).toMatchObject({ attached: false, reason: 'channel_unsupported' });
  expect(c.attachments).toHaveLength(0);
});

test('кап файлов на ход соблюдается', async () => {
  const c = ctx({ attachments: new Array(priceList.MAX_PHOTOS_PER_TURN).fill({ nodeKey: 'zz' }) });
  const res = await tool.run(1, { category: 'c12' }, c);
  expect(res).toMatchObject({ attached: false, reason: 'limit' });
});

test('неизвестный ключ — ошибка с подсказкой, а не тишина', async () => {
  const res = await tool.run(1, { category: 'c999' }, ctx());
  expect(res.error).toMatch(/ПРАЙС-ЛИСТЫ В КАРТИНКАХ/);
});

test('индекса нет (сбой загрузки) — деградация в ошибку, ход не падает', async () => {
  const res = await tool.run(1, { category: 'c12' }, { channel: 'whatsapp', attachments: [] });
  expect(res.error).toBeTruthy();
});

test('инструмент зарегистрирован в обоих режимах реестра', () => {
  const registry = require('./services/agent/tools');
  expect(registry.handlers.send_price_list).toBe(tool.run);
  expect(registry.catalogMode.handlers.send_price_list).toBe(tool.run);
});
