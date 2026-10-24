'use strict';
// Минимальные DOCX для тестов и живых скриптов — без бинарных фикстур в git.
// makeDocx({ body, header }) собирает word/document.xml (и колонтитул) из XML-кусков;
// p('текст') — абзац, table([['№','Услуга'], …]) — таблица по строкам.
const PizZip = require('pizzip');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const table = (rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

function makeDocx({ body = '', header = null } = {}) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + (header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '')
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  let sect = '';
  if (header) {
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
      + '</Relationships>');
    zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}" xmlns:r="${R}">${header}</w:hdr>`);
    sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/></w:sectPr>';
  }
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${sect}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

/** Текст части документа без разметки (сущности XML раскрыты) — для проверок в тестах. */
function docText(buffer, part = 'word/document.xml') {
  return new PizZip(buffer).file(part).asText()
    .replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

module.exports = { makeDocx, docText, p, table };
