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

// Индекс прайсов салона. Бросает наружу — оркестратор ловит своим fail-open
// (ход идёт без блока прайсов, как без каталога).
async function loadPriceIndex(salonId) {
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
  return priceList.buildIndex({
    categories,
    subcats: (tree && tree.subcats) || [],
    photos: alive,
    priceListUrl: (cfg && cfg.priceListUrl) || null,
  });
}

// Абсолютный путь строго внутри uploads. Тот же гейт, что в portfolio.safeUnlink:
// file_url — единственное, что связывает БД с файловой системой.
function safeAbs(relUrl) {
  if (!relUrl || typeof relUrl !== 'string' || !relUrl.startsWith('/uploads/')) return null;
  return path.join(uploadsDir, path.basename(relUrl));
}

async function readPhotoBuffer(relUrl) {
  const abs = safeAbs(relUrl);
  if (!abs) return null;
  try { return await fsp.readFile(abs); } catch (e) { return null; }
}

module.exports = { loadPriceIndex, readPhotoBuffer, uploadsDir };
