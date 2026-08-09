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
