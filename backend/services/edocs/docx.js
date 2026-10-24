'use strict';
// Разбор и заполнение DOCX-шаблонов «Документов» (docxtemplater, теги в { }).
// Теги берём штатным doc.getTags() (есть с 3.4x): InspectModule требует lodash,
// которого нет в зависимостях docxtemplater, и падает на require.
// errorLogging:false — иначе библиотека печатает каждую ошибку шаблона в stdout.
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { EMPTY } = require('./format');

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;   // как у F.Doc для шаблонов
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class TemplateError extends Error {
  constructor(message, details = []) { super(message); this.name = 'TemplateError'; this.details = details; }
}

function asTemplateError(e) {
  const list = e && e.properties && Array.isArray(e.properties.errors) ? e.properties.errors : [e];
  const details = list.map((x) => (x && x.properties && x.properties.explanation) || (x && x.message) || String(x));
  return new TemplateError(`Ошибка в разметке шаблона: ${details.join('; ')}`, details);
}

function open(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new TemplateError('Файл пустой');
  if (buffer.length > MAX_TEMPLATE_BYTES) throw new TemplateError('Шаблон больше 10 МБ');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) throw new TemplateError('Это не DOCX: нужен файл Word (.docx)');
  let zip;
  try { zip = new PizZip(buffer); } catch (e) { throw new TemplateError('Файл повреждён: не удалось распаковать DOCX'); }
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

module.exports = { inspect, render, TemplateError, MAX_TEMPLATE_BYTES, DOCX_MIME };
