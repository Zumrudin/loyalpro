'use strict';
// Разбор списка «имя + телефон» для разовой рассылки (спека 2026-11-01 §3). Чистый модуль: текст
// (строка на человека, разделители ; , таб или пробел), CSV и строки XLSX (массив массивов). Номер —
// общий канон cascade.canonPhone (7XXXXXXXXXX): правило канонизации одно на модуль уведомлений и рассылки.
const { canonPhone } = require('../notifications/cascade');

const MAX_ROWS = 5000;
const NAME_HDR = /^(имя|name|фио|клиент|пациент)$/i;
const PHONE_HDR = /^(телефон|phone|номер|тел\.?|мобильный)$/i;

function cellStr(v) { return v == null ? '' : String(v).trim(); }

// Ячейка — телефон, только если после чистки в ней нет букв: «Анна 8916…» телефоном не считается.
function asPhone(v) {
  const s = cellStr(v);
  if (!s || /\p{L}/u.test(s)) return null;
  return canonPhone(s);
}

function finish(items, invalid) {
  const seen = new Set();
  const rows = [];
  let duplicates = 0;
  let capped = false;
  for (const it of items) {
    if (seen.has(it.phone)) { duplicates++; continue; }
    if (rows.length >= MAX_ROWS) { capped = true; continue; }
    seen.add(it.phone);
    rows.push(it);
  }
  if (capped) invalid.push({ line: null, raw: `превышен лимит ${MAX_ROWS} строк` });
  return { rows, invalid, duplicates };
}

function parseRows(table) {
  const items = [];
  const invalid = [];
  let start = 0;
  let nameCol = null;
  let phoneCol = null;
  const head = (table[0] || []).map(cellStr);
  const hp = head.findIndex(h => PHONE_HDR.test(h));
  if (hp >= 0) {
    phoneCol = hp;
    const hn = head.findIndex(h => NAME_HDR.test(h));
    nameCol = hn >= 0 ? hn : null;
    start = 1;
  }
  for (let i = start; i < table.length; i++) {
    const cells = (table[i] || []).map(cellStr);
    if (!cells.some(Boolean)) continue;
    const line = i + 1;
    let pIdx = phoneCol;
    if (pIdx == null) pIdx = cells.findIndex(c => asPhone(c));
    const phone = pIdx != null && pIdx >= 0 ? asPhone(cells[pIdx]) : null;
    if (!phone) { invalid.push({ line, raw: cells.filter(Boolean).join(' ') }); continue; }
    const name = nameCol != null
      ? cells[nameCol] || ''
      : cells.filter((c, j) => j !== pIdx && c && /\p{L}/u.test(c))[0] || '';
    items.push({ name: name.slice(0, 120), phone, line });
  }
  return finish(items, invalid);
}

// Строка текста: таб/; → ячейки как есть; иначе телефон — самый длинный хвост/голова из цифр и
// символов номера, остальное — имя («Анна 8 916 123-45-67», «+7 916… , Ирина»).
const PHONE_RUN = /\+?\d[\d\s()\-]{8,}\d/;
function splitLine(raw) {
  if (/[\t;]/.test(raw)) return raw.split(/[\t;]/);
  const m = raw.match(PHONE_RUN);
  if (!m) return [raw];
  const rest = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).replace(/[,]/g, ' ').trim();
  return [rest, m[0]];
}

function parseText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const table = lines.map(l => (l.trim() ? splitLine(l.trim()) : []));
  const r = parseRows(table);
  // В тексте «битая» строка показывается целиком, как её вставили.
  r.invalid = r.invalid.map(x => (x.line ? { line: x.line, raw: lines[x.line - 1].trim() } : x));
  return r;
}

// CSV: разделитель ; или , (по первой строке), кавычки "…" с "" внутри.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length && first.includes(';') ? ';' : ',';
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

module.exports = { parseText, parseRows, parseCsv, MAX_ROWS };
