// backend/services/medical-cert-pdf.js
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATH = path.join(__dirname, '../assets/fonts/PTSans-Regular.ttf');
const BLACK = rgb(0, 0, 0);

// Нарисовать строку символов по ячейкам (равный шаг step от x)
function drawCells(page, font, text, f) {
  const chars = String(text);
  const size = f.fontSize || 11;
  let startX = f.x;
  if (f.align === 'right' && f.anchorRight) {
    startX = f.anchorRight - (chars.length - 1) * f.step;
  }
  for (let i = 0; i < chars.length && i < (f.max || chars.length); i++) {
    page.drawText(chars[i], { x: startX + i * f.step, y: f.y, size, font, color: BLACK });
  }
}

// Свободный текст с переносом по ширине width
function drawText(page, font, text, f) {
  const size = f.fontSize || 12;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lineHeight = f.lineHeight || size + 4;
  let line = '';
  let y = f.y;
  const flush = () => { if (line) { page.drawText(line, { x: f.x, y, size, font, color: BLACK }); y -= lineHeight; line = ''; } };
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) > (f.width || 9999) && line) { flush(); line = w; }
    else line = trial;
  }
  flush();
}

function drawField(page, font, value, f) {
  if (value === null || value === undefined || value === '') return;
  if (f.type === 'cells')        drawCells(page, font, value, f);
  else if (f.type === 'checkbox') page.drawText(String(value), { x: f.x, y: f.y, size: f.fontSize || 11, font, color: BLACK });
  else                            drawText(page, font, value, f);
}

// blank: Buffer пустого бланка; coords: {fields}; values: {fieldName: stringValue}
async function fillCertificate({ blank, coords, values }) {
  const doc = await PDFDocument.load(blank);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
  const pages = doc.getPages();

  for (const [name, f] of Object.entries(coords.fields || {})) {
    const value = values[name];
    if (value === null || value === undefined || value === '') continue;
    const page = pages[f.page || 0];
    if (!page) continue; // страница отсутствует — пропускаем
    drawField(page, font, value, f);
  }
  return Buffer.from(await doc.save());
}

module.exports = { fillCertificate, drawCells, drawText };
