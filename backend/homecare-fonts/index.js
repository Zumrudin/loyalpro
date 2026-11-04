// Шрифты листа «Домашнего ухода» для PDF — локальные копии Google Fonts (Cormorant Garamond, Lora;
// лицензия SIL OFL 1.1, тексты лицензий рядом), встраиваемые в HTML как data: URI.
//
// ЗАЧЕМ: PDF собирает puppeteer с waitUntil:'load', а шаблон тянул CSS шрифтов с fonts.googleapis.com.
// С нового прода (Selectel, Москва) этот запрос примерно в каждом восьмом случае не завершается
// вовсе — 30 с ожидания и «Navigation timeout» вместо PDF (замер 04.11.2026: 2 из 15). Локальные
// шрифты сеть не трогают. Экранный предпросмотр по-прежнему берёт шрифты у Google: браузер
// сотрудника при сбое просто показывает запасной шрифт, а не падает.
//
// faces.json — те же @font-face, что отдаёт css2 API (подмножества latin, latin-ext, cyrillic;
// шрифты переменные, поэтому один файл покрывает несколько начертаний). Обновлять — тем же
// запросом css2 с User-Agent Chrome.
const fs = require('fs');
const path = require('path');

let cached = null;

function inlineFontCss() {
  if (cached !== null) return cached;
  const faces = JSON.parse(fs.readFileSync(path.join(__dirname, 'faces.json'), 'utf8'));
  const data = new Map();
  cached = faces.map(f => {
    if (!data.has(f.file)) {
      data.set(f.file, fs.readFileSync(path.join(__dirname, f.file)).toString('base64'));
    }
    return `/* ${f.subset} */
@font-face {
  font-family: '${f.family}';
  font-style: ${f.style};
  font-weight: ${f.weight};
  font-display: swap;
  src: url(data:font/woff2;base64,${data.get(f.file)}) format('woff2');
  unicode-range: ${f.range};
}`;
  }).join('\n');
  return cached;
}

module.exports = { inlineFontCss };
