'use strict';

// Загрузчик индекса прайсов: битые записи (файла нет на диске) отбрасываются
// ЗДЕСЬ, а не при отправке — иначе Мила пообещает прайс, которого не будет.

jest.mock('fs', () => ({ ...jest.requireActual('fs'), existsSync: jest.fn() }));
jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/agent/catalog-data', () => ({ loadCategoryTitles: jest.fn() }));
jest.mock('./services/agent-settings', () => ({
  listPricePhotos: jest.fn(), loadCategoryTreeSafe: jest.fn(), getSettings: jest.fn(),
}));

const fs = require('fs');
const catalogData = require('./services/agent/catalog-data');
const settings = require('./services/agent-settings');
const data = require('./services/agent/price-list-data');

beforeEach(() => {
  jest.clearAllMocks();
  catalogData.loadCategoryTitles.mockResolvedValue([{ id: 12, title: 'Лазерная эпиляция' }]);
  settings.loadCategoryTreeSafe.mockResolvedValue({ subcats: [], placements: [] });
  settings.getSettings.mockResolvedValue({ priceListUrl: 'https://peri.ru/price' });
});

test('фото без файла на диске в индекс не попадает', async () => {
  settings.listPricePhotos.mockResolvedValue([
    { id: 1, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/live.jpg', file_name: 'live.jpg', mime_type: 'image/jpeg' },
    { id: 2, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/gone.jpg', file_name: 'gone.jpg', mime_type: 'image/jpeg' },
  ]);
  fs.existsSync.mockImplementation(p => String(p).endsWith('live.jpg'));
  const idx = await data.loadPriceIndex(1);
  expect(idx.nodes.get('c12').photos.map(p => p.id)).toEqual([1]);
  expect(idx.priceListUrl).toBe('https://peri.ru/price');
});

test('readPhotoBuffer не выходит за /uploads/', async () => {
  expect(await data.readPhotoBuffer('/etc/passwd')).toBeNull();
  expect(await data.readPhotoBuffer('')).toBeNull();
  expect(await data.readPhotoBuffer(null)).toBeNull();
  // `path.basename('/uploads/..')` = '..' — префикса мало, иначе путь ушёл бы
  // на родительский каталог, а existsSync на каталоге истинен.
  expect(await data.readPhotoBuffer('/uploads/..')).toBeNull();
  expect(await data.readPhotoBuffer('/uploads/../../etc/passwd')).toBeNull();
});

// ── Короткий TTL-кэш индекса (находка A): loadPriceIndex не должен дёргать
// источники (БД + YClients) на КАЖДОМ ходу диалога. ──
describe('TTL-кэш индекса', () => {
  beforeEach(() => {
    data.invalidate();   // кэш общий на процесс — тесты не должны видеть друг друга
    settings.listPricePhotos.mockResolvedValue([
      { id: 1, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/live.jpg', file_name: 'live.jpg', mime_type: 'image/jpeg' },
    ]);
    fs.existsSync.mockReturnValue(true);
  });

  test('второй вызов в пределах TTL не дёргает источники повторно', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(1, { nowMs: nowMs + 30 * 1000 });   // 30с спустя, TTL 60с
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(1);
    expect(settings.loadCategoryTreeSafe).toHaveBeenCalledTimes(1);
    expect(catalogData.loadCategoryTitles).toHaveBeenCalledTimes(1);
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
  });

  test('протухший кэш (>TTL) — источники дёргаются снова', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(1, { nowMs: nowMs + 61 * 1000 });   // за TTL
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(2);
  });

  test('invalidate(salonId) — следующий вызов идёт живым (даже в пределах TTL)', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    data.invalidate(1);
    await data.loadPriceIndex(1, { nowMs: nowMs + 1000 });
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(2);
  });

  test('invalidate() без аргумента чистит кэш всех салонов', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(2, { nowMs });
    data.invalidate();
    await data.loadPriceIndex(1, { nowMs: nowMs + 1000 });
    await data.loadPriceIndex(2, { nowMs: nowMs + 1000 });
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(4);
  });

  test('кэш по разным salonId не пересекается', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(2, { nowMs });
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(2);
  });

  test('сбой сборки НЕ кэшируется — следующий вызов пробует снова', async () => {
    const nowMs = 1000000;
    settings.listPricePhotos.mockRejectedValueOnce(new Error('db down'));
    await expect(data.loadPriceIndex(1, { nowMs })).rejects.toThrow('db down');
    settings.listPricePhotos.mockResolvedValue([]);
    await expect(data.loadPriceIndex(1, { nowMs: nowMs + 1000 })).resolves.toBeTruthy();
    expect(settings.listPricePhotos).toHaveBeenCalledTimes(2);
  });
});
