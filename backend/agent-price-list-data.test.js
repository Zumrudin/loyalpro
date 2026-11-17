'use strict';

// Загрузчик индекса прайсов: битые записи (файла нет на диске) отбрасываются
// ЗДЕСЬ, а не при отправке — иначе Мила пообещает прайс, которого не будет.

jest.mock('fs', () => ({ ...jest.requireActual('fs'), realpathSync: jest.fn(), statSync: jest.fn() }));
jest.mock('fs/promises',()=>({realpath:jest.fn(),stat:jest.fn(),readFile:jest.fn()}));
jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/service-category-photos', () => ({ loadIndex: jest.fn() }));
jest.mock('./services/agent-settings', () => ({
  getSettings: jest.fn(),
}));

const fs = require('fs');
const fsp = require('fs/promises');
const categoryPhotos = require('./services/service-category-photos');
const settings = require('./services/agent-settings');
const data = require('./services/agent/price-list-data');

beforeEach(() => {
  jest.clearAllMocks();
  data.invalidate();
  categoryPhotos.loadIndex.mockResolvedValue({categories:[{ id: 12, title: 'Лазерная эпиляция',parent_id:null }],aliases:[{legacy_key:'c12',category_id:12}],photos:[]});
  settings.getSettings.mockResolvedValue({ priceListUrl: 'https://peri.ru/price' });
  fs.realpathSync.mockImplementation(p=>p);
  fs.statSync.mockReturnValue({isFile:()=>true});
  fsp.realpath.mockImplementation(async p=>p);
  fsp.stat.mockResolvedValue({isFile:()=>true});
  fsp.readFile.mockResolvedValue(Buffer.from('photo'));
});

test('фото без файла на диске в индекс не попадает', async () => {
  categoryPhotos.loadIndex.mockResolvedValue({categories:[{id:12,title:'Лазерная эпиляция',parent_id:null}],aliases:[],photos:[
    { id: 1, category_id: 12, file_url: '/uploads/live.jpg', file_name: 'live.jpg', mime_type: 'image/jpeg' },
    { id: 2, category_id: 12, file_url: '/uploads/gone.jpg', file_name: 'gone.jpg', mime_type: 'image/jpeg' },
  ]});
  fs.realpathSync.mockImplementation(p => String(p).endsWith('gone.jpg')?(()=>{throw new Error('ENOENT')})():p);
  const idx = await data.loadPriceIndex(1);
  expect(idx.nodes.get('k12').photos.map(p => p.id)).toEqual([1]);
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
  expect(await data.readPhotoBuffer('/uploads/nested/a.jpg')).toBeNull();
  fsp.realpath.mockImplementation(async p=>String(p).endsWith('escape.jpg')?'/tmp/outside.jpg':p);
  expect(await data.readPhotoBuffer('/uploads/escape.jpg')).toBeNull();
  fsp.realpath.mockImplementation(async p=>p);fsp.stat.mockResolvedValueOnce({isFile:()=>false});
  expect(await data.readPhotoBuffer('/uploads/directory.jpg')).toBeNull();
  expect(fsp.readFile).not.toHaveBeenCalled();
});

test('индекс отбрасывает symlink наружу и каталог',async()=>{
 categoryPhotos.loadIndex.mockResolvedValue({categories:[{id:12,title:'X',parent_id:null}],aliases:[],photos:[
  {id:1,category_id:12,file_url:'/uploads/link.jpg',file_name:'link.jpg',mime_type:'image/jpeg'},
  {id:2,category_id:12,file_url:'/uploads/dir.jpg',file_name:'dir.jpg',mime_type:'image/jpeg'},
 ]});
 fs.realpathSync.mockImplementation(p=>String(p).endsWith('link.jpg')?'/tmp/outside.jpg':p);
 fs.statSync.mockReturnValue({isFile:()=>false});
 const idx=await data.loadPriceIndex(1,{nowMs:123});expect(idx.nodes.get('k12').photos).toEqual([]);
});

// ── Короткий TTL-кэш индекса (находка A): loadPriceIndex не должен дёргать
// источники (БД + YClients) на КАЖДОМ ходу диалога. ──
describe('TTL-кэш индекса', () => {
  beforeEach(() => {
    data.invalidate();   // кэш общий на процесс — тесты не должны видеть друг друга
    categoryPhotos.loadIndex.mockResolvedValue({categories:[{id:12,title:'Лазерная эпиляция',parent_id:null}],aliases:[],photos:[
      { id: 1, category_id: 12, file_url: '/uploads/live.jpg', file_name: 'live.jpg', mime_type: 'image/jpeg' },
    ]});
    fs.realpathSync.mockImplementation(p=>p);
  });

  test('второй вызов в пределах TTL не дёргает источники повторно', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(1, { nowMs: nowMs + 30 * 1000 });   // 30с спустя, TTL 60с
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(1);
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
  });

  test('протухший кэш (>TTL) — источники дёргаются снова', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(1, { nowMs: nowMs + 61 * 1000 });   // за TTL
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(2);
  });

  test('invalidate(salonId) — следующий вызов идёт живым (даже в пределах TTL)', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    data.invalidate(1);
    await data.loadPriceIndex(1, { nowMs: nowMs + 1000 });
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(2);
  });

  test('invalidate() без аргумента чистит кэш всех салонов', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(2, { nowMs });
    data.invalidate();
    await data.loadPriceIndex(1, { nowMs: nowMs + 1000 });
    await data.loadPriceIndex(2, { nowMs: nowMs + 1000 });
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(4);
  });

  test('кэш по разным salonId не пересекается', async () => {
    const nowMs = 1000000;
    await data.loadPriceIndex(1, { nowMs });
    await data.loadPriceIndex(2, { nowMs });
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(2);
  });

  test('сбой сборки НЕ кэшируется — следующий вызов пробует снова', async () => {
    const nowMs = 1000000;
    categoryPhotos.loadIndex.mockRejectedValueOnce(new Error('db down'));
    await expect(data.loadPriceIndex(1, { nowMs })).rejects.toThrow('db down');
    categoryPhotos.loadIndex.mockResolvedValue({categories:[],aliases:[],photos:[]});
    await expect(data.loadPriceIndex(1, { nowMs: nowMs + 1000 })).resolves.toBeTruthy();
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(2);
  });

  test('invalidate во время загрузки не позволяет устаревшему результату вернуться в кэш',async()=>{
    let release;const pending=new Promise(resolve=>{release=resolve});
    categoryPhotos.loadIndex.mockReturnValueOnce(pending);
    const first=data.loadPriceIndex(1,{nowMs:1000000});
    data.invalidate(1);
    release({categories:[{id:12,title:'Old',parent_id:null}],aliases:[],photos:[]});
    await first;
    categoryPhotos.loadIndex.mockResolvedValueOnce({categories:[{id:12,title:'New',parent_id:null}],aliases:[],photos:[]});
    const fresh=await data.loadPriceIndex(1,{nowMs:1000001});
    expect(categoryPhotos.loadIndex).toHaveBeenCalledTimes(2);
    expect(fresh.nodes.get('k12').title).toBe('New');
  });
});
