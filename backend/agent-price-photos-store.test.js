'use strict';

// Валидация записи фото прайса. БД мокается: проверяем правила, а не SQL.

jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
const { db } = require('./db');
const settings = require('./services/agent-settings');

beforeEach(() => { jest.clearAllMocks(); });

describe('addPricePhoto', () => {
  const file = { fileUrl: '/uploads/p.jpg', fileName: 'p.jpg', mimeType: 'image/jpeg', byteSize: 100 };

  test('нужен РОВНО один из ycCategoryId/subcategoryId', async () => {
    await expect(settings.addPricePhoto(1, { ...file }))
      .rejects.toMatchObject({ code: 'BAD_NODE' });
    await expect(settings.addPricePhoto(1, { ...file, ycCategoryId: 12, subcategoryId: 7 }))
      .rejects.toMatchObject({ code: 'BAD_NODE' });
  });

  test('кап 10 фото на узел', async () => {
    db.one.mockResolvedValueOnce({ n: 10, next_order: 11 });
    await expect(settings.addPricePhoto(1, { ...file, ycCategoryId: 12 }))
      .rejects.toMatchObject({ code: 'PHOTO_LIMIT' });
  });

  test('в пределах капа строка вставляется с display_order = следующий', async () => {
    db.one.mockResolvedValueOnce({ n: 2, next_order: 3 });
    db.one.mockResolvedValueOnce({ id: 55 });
    const row = await settings.addPricePhoto(1, { ...file, subcategoryId: 7 });
    expect(row).toEqual({ id: 55 });
    const params = db.one.mock.calls[1][1];
    expect(params).toContain(3);      // display_order
    expect(params).toContain(7);      // subcategory_id
  });
});

describe('priceListUrl в настройках агента', () => {
  test('пустая строка сохраняется как null', () => {
    expect(settings.normalizePriceListUrl('')).toBeNull();
    expect(settings.normalizePriceListUrl('   ')).toBeNull();
    expect(settings.normalizePriceListUrl(null)).toBeNull();
  });

  test('принимается только http(s)-ссылка разумной длины', () => {
    expect(settings.normalizePriceListUrl('https://peri.ru/price')).toBe('https://peri.ru/price');
    expect(() => settings.normalizePriceListUrl('javascript:alert(1)')).toThrow();
    expect(() => settings.normalizePriceListUrl('peri.ru/price')).toThrow();
    expect(() => settings.normalizePriceListUrl('https://peri.ru/' + 'x'.repeat(600))).toThrow();
  });
});
