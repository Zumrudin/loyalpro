'use strict';
// ============================================================
// I/O-обвязка прайс-листов: собрать индекс (чистый price-list.js) из БД,
// дерева подкатегорий и названий категорий YClients; прочитать файл с диска
// для отправки. Вся работа с файловой системой живёт ЗДЕСЬ — диспетчер знает
// только про доставку.
// ============================================================
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const priceList = require('./price-list');
const catalogData = require('./catalog-data');
const settings = require('../agent-settings');

const uploadsDir = path.join(__dirname, '../../../frontend/uploads');

// Короткий TTL-кэш индекса по salonId. ЗАЧЕМ: loadPriceIndex зовётся оркестратором
// на КАЖДОМ ходу КАЖДОГО диалога (даже у салонов без единого фото прайса), а внутри —
// четыре обращения (listPricePhotos, loadCategoryTreeSafe, loadCategoryTitles,
// getSettings) плюс fs.existsSync по каждому фото; БД удалённая (Beget). Стиль и TTL —
// как у ycGetServiceCatalog в services/yclients.js (2 мин, тот же ключ salonId).
// ЧЕМ ПЛАТИМ: администратор может увидеть своё новое/удалённое фото у Милы с
// задержкой до TTL — но мутирующие ручки price-photos сбрасывают кэш явно
// (invalidate), так что в норме админ видит эффект сразу, а TTL страхует только
// от забытого/упавшего сброса.
const _priceIndexCache = {};                 // salonId → { ts, data }
const PRICE_INDEX_TTL_MS = 60 * 1000;

// Индекс прайсов салона. Бросает наружу — оркестратор ловит своим fail-open
// (ход идёт без блока прайсов, как без каталога). opts.nowMs — для тестов.
async function loadPriceIndex(salonId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const cached = _priceIndexCache[salonId];
  if (cached && (now - cached.ts) < PRICE_INDEX_TTL_MS) return cached.data;

  const [photos, tree, categories, cfg] = await Promise.all([
    settings.listPricePhotos(salonId),
    settings.loadCategoryTreeSafe(salonId),
    catalogData.loadCategoryTitles(salonId),
    settings.getSettings(salonId),
  ]);
  // Битая запись (файл удалили мимо админки) отбрасывается ЗДЕСЬ: иначе
  // инструмент пообещает модели вложение, а диспетчеру его будет нечем отправить.
  const alive = (photos || []).filter(p => {
    const abs = safeAbs(p && p.file_url);
    return abs ? fs.existsSync(abs) : false;
  });
  const data = priceList.buildIndex({
    categories,
    subcats: (tree && tree.subcats) || [],
    photos: alive,
    priceListUrl: (cfg && cfg.priceListUrl) || null,
  });
  // Кэшируем только успешный результат: сборка, упавшая на полпути (Promise.all
  // бросил), сюда не доходит — иначе сбой источника закэшировался бы на минуту,
  // и Мила молчала бы про прайс дольше, чем сам сбой источника длился.
  _priceIndexCache[salonId] = { ts: now, data };
  return data;
}

// Сброс кэша. Без аргумента — сброс ВСЕГО (используется тестами и как аварийный
// рычаг); с salonId — точечный сброс одного салона. Зовётся из мутирующих ручек
// price-photos (routes/agent-settings.js): без сброса администратор до минуты
// недоумевал бы, почему загруженное фото Мила не видит.
function invalidate(salonId) {
  if (salonId == null) {
    for (const k of Object.keys(_priceIndexCache)) delete _priceIndexCache[k];
    return;
  }
  delete _priceIndexCache[salonId];
}

// Абсолютный путь строго внутри uploads. Тот же гейт, что в portfolio.safeUnlink:
// file_url — единственное, что связывает БД с файловой системой.
function safeAbs(relUrl) {
  if (!relUrl || typeof relUrl !== 'string' || !relUrl.startsWith('/uploads/')) return null;
  const base = path.basename(relUrl);
  // ГОТЧА: `path.basename('/uploads/..')` — это `'..'`, и одного префикса мало:
  // путь ушёл бы на РОДИТЕЛЬСКИЙ каталог, а `existsSync` на каталоге истинен —
  // битая строка проехала бы фильтр живых фото и обещала модели вложение.
  if (!base || base === '.' || base === '..') return null;
  return path.join(uploadsDir, base);
}

async function readPhotoBuffer(relUrl) {
  const abs = safeAbs(relUrl);
  if (!abs) return null;
  try { return await fsp.readFile(abs); } catch (e) { return null; }
}

module.exports = { loadPriceIndex, readPhotoBuffer, uploadsDir, invalidate };
