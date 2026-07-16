// frontend/js/pages/kb-markdown.js
// Минимальный markdown→HTML рендерер для статей базы знаний.
// Чистая функция: в браузере глобальна (window.kbMarkdown), в Node экспортируется.
'use strict';

function kbEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Инлайн-разметка внутри уже экранированной строки: **жирный**.
function kbInline(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function kbMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listBuf = null;      // 'ul' пока копим <li>
  let checkIdx = 0;        // сквозной индекс чекбоксов для localStorage
  let i = 0;

  const flushList = () => {
    if (listBuf) { out.push(`<ul class="kb-ul">${listBuf}</ul>`); listBuf = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // код-блок ```
    if (line.trim().startsWith('```')) {
      flushList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(kbEsc(lines[i])); i++;
      }
      i++; // закрывающая ```
      out.push(
        `<div class="kb-code"><button type="button" class="kb-copy" title="Копировать">⧉</button>` +
        `<pre><code>${buf.join('\n')}</code></pre></div>`);
      continue;
    }

    // чекбокс - [ ] / - [x]
    const cb = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
    if (cb) {
      flushList();
      const checked = cb[1].toLowerCase() === 'x' ? ' checked' : '';
      out.push(
        `<label class="kb-check"><input type="checkbox" data-kb-check="${checkIdx}"${checked}> ` +
        `<span>${kbInline(kbEsc(cb[2]))}</span></label>`);
      checkIdx++;
      i++; continue;
    }

    // заголовки # ## ###  → h3/h4/h5 (h1/h2 занят layout-ом страницы)
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList();
      const lvl = Math.min(5, h[1].length + 2);
      out.push(`<h${lvl} class="kb-h">${kbInline(kbEsc(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    // обычный список - item
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) {
      listBuf = (listBuf || '') + `<li>${kbInline(kbEsc(li[1]))}</li>`;
      i++; continue;
    }

    // пустая строка
    if (line.trim() === '') { flushList(); i++; continue; }

    // абзац
    flushList();
    out.push(`<p>${kbInline(kbEsc(line))}</p>`);
    i++;
  }
  flushList();
  return out.join('\n');
}

if (typeof window !== 'undefined') { window.kbMarkdown = kbMarkdown; window.kbEsc = kbEsc; }
if (typeof module !== 'undefined' && module.exports) { module.exports = { kbMarkdown, kbEsc }; }
