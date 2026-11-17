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
const settings = require('../agent-settings');
const categoryPhotos = require('../service-category-photos');

const uploadsDir = path.join(__dirname, '../../../frontend/uploads');

// Короткий TTL-кэш индекса по salonId. ЗАЧЕМ: loadPriceIndex зовётся оркестратором
// на КАЖДОМ ходу КАЖДОГО диалога (даже у салонов без единого фото прайса), а внутри —
// четыре обращения (listPricePhotos, loadCategoryTreeSafe, loadCategoryTitles,
// getSettings) плюс fs.existsSync по каждому фото; БД удалённая (Beget). Стиль —
// как у ycGetServiceCatalog в services/yclients.js (тот же ключ salonId), но TTL
// короче (60 с здесь против 2 мин там — паритета по TTL нет, только по приёму).
// ЧЕМ ПЛАТИМ: администратор может увидеть своё новое/удалённое фото у Милы с
// задержкой до TTL — но мутирующие ручки price-photos сбрасывают кэш явно
// (invalidate), так что в норме админ видит эффект сразу, а TTL страхует только
// от забытого/упавшего сброса.
const _priceIndexCache = {};                 // salonId → { ts, data }
const PRICE_INDEX_TTL_MS = 60 * 1000;
const _generation = new Map();
let _epoch = 0;
const generationOf = salonId => `${_epoch}|${_generation.get(String(salonId)) || 0}`;

// Индекс прайсов салона. Бросает наружу — оркестратор ловит своим fail-open
// (ход идёт без блока прайсов, как без каталога). opts.nowMs — для тестов.
async function loadPriceIndex(salonId, opts = {}) {
  const now = opts.nowMs || Date.now();
  const cached = _priceIndexCache[salonId];
  if (cached && (now - cached.ts) < PRICE_INDEX_TTL_MS) return cached.data;
  const generation = generationOf(salonId);

  const [catalog, cfg] = await Promise.all([
    categoryPhotos.loadIndex(salonId),
    settings.getSettings(salonId),
  ]);
  // Битая запись (файл удалили мимо админки) отбрасывается ЗДЕСЬ: иначе
  // инструмент пообещает модели вложение, а диспетчеру его будет нечем отправить.
  const alive = (catalog.photos || []).filter(p => {
    return !!existingFile(p && p.file_url);
  });
  const data = priceList.buildLocalIndex({
    categories: catalog.categories,
    aliases: catalog.aliases,
    photos: alive,
    priceListUrl: (cfg && cfg.priceListUrl) || null,
  });
  // Кэшируем только успешный результат: сборка, упавшая на полпути (Promise.all
  // бросил), сюда не доходит — иначе сбой источника закэшировался бы на минуту,
  // и Мила молчала бы про прайс дольше, чем сам сбой источника длился.
  // Мутация могла завершиться, пока источники читались. Такой результат можно
  // вернуть уже начатому ходу, но нельзя снова класть в очищенный кэш.
  if (generation === generationOf(salonId)) _priceIndexCache[salonId] = { ts: now, data };
  return data;
}

// Сброс кэша. Без аргумента — сброс ВСЕГО (используется тестами и как аварийный
// рычаг); с salonId — точечный сброс одного салона. Зовётся из мутирующих ручек
// price-photos (routes/agent-settings.js): без сброса администратор до минуты
// недоумевал бы, почему загруженное фото Мила не видит.
function invalidate(salonId) {
  if (salonId == null) {
    for (const k of Object.keys(_priceIndexCache)) delete _priceIndexCache[k];
    _epoch++;
    return;
  }
  const key=String(salonId);
  _generation.set(key,(_generation.get(key)||0)+1);
  delete _priceIndexCache[salonId];
}

// Абсолютный путь строго внутри uploads. Тот же гейт, что в portfolio.safeUnlink:
// file_url — единственное, что связывает БД с файловой системой.
function safeAbs(relUrl) {
  if (typeof relUrl !== 'string' || !/^\/uploads\/[^/\\]+$/.test(relUrl)) return null;
  const base=relUrl.slice('/uploads/'.length);
  if (!base || base === '.' || base === '..') return null;
  return path.join(uploadsDir,base);
}

function existingFile(relUrl) {
  const candidate=safeAbs(relUrl);if(!candidate)return null;
  try {
    const root=fs.realpathSync(uploadsDir),real=fs.realpathSync(candidate);
    return real.startsWith(root+path.sep)&&fs.statSync(real).isFile()?real:null;
  } catch (_) { return null; }
}

async function readPhotoBuffer(relUrl) {
  const candidate=safeAbs(relUrl);if(!candidate)return null;
  try {
    const [root,real]=await Promise.all([fsp.realpath(uploadsDir),fsp.realpath(candidate)]);
    if(!real.startsWith(root+path.sep)||(await fsp.stat(real)).isFile()!==true)return null;
    return await fsp.readFile(real);
  } catch (e) { return null; }
}

module.exports = { loadPriceIndex, readPhotoBuffer, uploadsDir, invalidate };
