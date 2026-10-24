'use strict';
// Разбор и заполнение DOCX-шаблонов «Документов» (docxtemplater, теги в { }).
// Теги берём штатным doc.getTags() (есть с 3.4x): InspectModule требует lodash,
// которого нет в зависимостях docxtemplater, и падает на require.
// errorLogging:false — иначе библиотека печатает каждую ошибку шаблона в stdout.
const zlib = require('zlib');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { EMPTY } = require('./format');

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;   // как у F.Doc для шаблонов (сжатый размер)
const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;   // сумма несжатых размеров записей архива: защита от «zip-бомбы»
const DEFLATE = '\x08\x00';                     // метод сжатия записи в ZIP — в таком виде его хранит pizzip
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class TemplateError extends Error {
  constructor(message, details = []) { super(message); this.name = 'TemplateError'; this.details = details; }
}

function asTemplateError(e) {
  const list = e && e.properties && Array.isArray(e.properties.errors) ? e.properties.errors : [e];
  const details = list.map((x) => (x && x.properties && x.properties.explanation) || (x && x.message) || String(x));
  return new TemplateError(`Ошибка в разметке шаблона: ${details.join('; ')}`, details);
}

const tooBig = () => new TemplateError('Шаблон слишком велик после распаковки (больше 25 МБ) — упростите документ');

/**
 * Защита от «zip-бомбы»: лимит загрузки проверяет только сжатый размер, а 41 КБ пробелов в document.xml
 * разворачиваются в 40 МБ XML (+160 МБ памяти). Суммируем несжатые размеры записей из оглавления архива
 * (pizzip держит их в file._data.uncompressedSize; сами записи при загрузке не распаковываются).
 * Оглавление пишет автор файла и может соврать — заявить мало, а внутри спрятать гигабайты: pizzip заметил бы
 * расхождение только ПОСЛЕ полной распаковки. Поэтому каждую DEFLATE-запись пробно распаковываем zlib с потолком
 * «заявленный размер»: честный файл проходит (pizzip сверяет размер так же строго), лживый отклоняется
 * после нескольких байт лишнего вывода, а не после всего потока.
 */
function assertUnpackedSize(zip) {
  const entries = Object.values(zip.files).filter((f) => f && !f.dir && f._data);
  let total = 0;
  for (const f of entries) total += Number(f._data.uncompressedSize) || 0;
  if (total > MAX_UNPACKED_BYTES) throw tooBig();
  for (const f of entries) {
    const d = f._data;
    if (d.compressionMethod !== DEFLATE || typeof d.getCompressedContent !== 'function') continue;
    try { zlib.inflateRawSync(d.getCompressedContent(), { maxOutputLength: (Number(d.uncompressedSize) || 0) + 1 }); } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
      // Битый поток — не наша тема: pizzip скажет об этом сам, и open() ответит «повреждён» / «ошибка в разметке».
    }
  }
}

function open(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new TemplateError('Файл пустой');
  if (buffer.length > MAX_TEMPLATE_BYTES) throw new TemplateError('Шаблон больше 10 МБ');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) throw new TemplateError('Это не DOCX: нужен файл Word (.docx)');
  let zip;
  try { zip = new PizZip(buffer); } catch (e) { throw new TemplateError('Файл повреждён: не удалось распаковать DOCX'); }
  assertUnpackedSize(zip);
  if (!zip.file('word/document.xml')) throw new TemplateError('Это не документ Word: внутри нет word/document.xml');
  try {
    return new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      errorLogging: false,
      // Пустой простой тег — видимый пропуск; пустой цикл/условие — ничего.
      nullGetter: (part) => (part && part.module ? '' : EMPTY),
    });
  } catch (e) { throw asTemplateError(e); }
}

function mergeTags(into, tags) {
  for (const [k, v] of Object.entries(tags || {})) { into[k] = into[k] || {}; mergeTags(into[k], v); }
  return into;
}

/** Теги документа и колонтитулов одним объектом: { fio: {}, services: { title: {} } }. */
function inspect(buffer) {
  const t = open(buffer).getTags();
  const all = {};
  if (t.document) mergeTags(all, t.document.tags);
  for (const part of [...(t.headers || []), ...(t.footers || [])]) mergeTags(all, part.tags);
  return all;
}

/** Заполненный DOCX (Buffer). */
function render(buffer, data) {
  const doc = open(buffer);
  try { doc.render(data); } catch (e) { throw asTemplateError(e); }
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { inspect, render, TemplateError, MAX_TEMPLATE_BYTES, MAX_UNPACKED_BYTES, DOCX_MIME };
