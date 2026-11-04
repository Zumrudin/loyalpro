// Живая проверка PDF листа «Домашнего ухода» БОЕВЫМ обработчиком GET /api/home-care/:id/pdf,
// без HTTP, JWT и сессий: маршрут вызывается in-process, настройки шаблона (salons.template_*)
// читаются из БД салона. Ничего не пишет в БД.
//
//   cd backend && node scripts/homecare-pdf-check.js --salon=1 --id=12 --out=/tmp/hc.pdf
//   cd backend && node scripts/homecare-pdf-check.js --salon=1 --fixture=/tmp/rx.json --out=/tmp/hc.pdf
//
// --fixture — назначение JSON (поля home_care_prescriptions + client_name/specialist_name/salon_name
// и массив items): нужен, когда в салоне нет назначения с позициями (на новом проде 04.11.2026
// единственное назначение было пустым, и PDF состоял из одного водяного знака).
//
// ЗАЧЕМ: на новом сервере (Ubuntu 26.04, Selectel) Chrome puppeteer не запускался — не хватало
// системных библиотек (libnspr4, libnss3, libatk…), и «Скачать PDF» падал у всех. Скрипт ловит
// это сразу после выката. На проде запускать под пользователем приложения (`sudo -u loyalpro -H`),
// иначе puppeteer не найдёт свой Chrome в ~/.cache/puppeteer.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

function arg(name) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const salonId = parseInt(arg('salon') || '1', 10);
const id = arg('id');
const fixturePath = arg('fixture');
const out = arg('out') || '/tmp/homecare-pdf-check.pdf';
if (!id && !fixturePath) {
  console.error('нужен --id=<назначение> или --fixture=<файл.json>');
  process.exit(2);
}

const { db } = require('../db');
if (fixturePath) {
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { items = [], ...prescription } = fx;
  // Обработчик берёт назначение через oneOrNone, позиции через any; шаблон — через db.one (остаётся боевым).
  db.oneOrNone = async () => prescription;
  db.any = async () => items;
}

const router = require('../routes/home-care');
const layer = router.stack.find(l => l.route && l.route.path === '/:id/pdf');
if (!layer) { console.error('маршрут /:id/pdf не найден в routes/home-care.js'); process.exit(1); }
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const res = {
  setHeader() {},
  status(code) { this.code = code; return this; },
  json(body) { console.error('FAIL', this.code, body); process.exit(1); },
  // send зовётся внутри try обработчика: брошенная здесь ошибка записи легла бы в лог приложения
  // как «PDF generation failed», хотя PDF собран. Поэтому запись ловим сами.
  send(buf) {
    try { fs.writeFileSync(out, buf); }
    catch (e) { console.error(`PDF собран (${buf.length} байт), но не записан в ${out}: ${e.message}`); process.exit(1); }
    console.log(`OK PDF ${buf.length} байт → ${path.resolve(out)}`);
    process.exit(0);
  },
};

handler({ params: { id: id || '0' }, user: { salonId, userId: 0, role: 'owner' }, query: {} }, res);
