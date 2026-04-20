/**
 * HOME CARE PRINT TEMPLATE
 * ========================
 * Генерирует HTML-страницу в стиле PERI CLINIC для печати и PDF.
 *
 * КОНФИГУРАЦИЯ ДЛЯ ДРУГОЙ ОРГАНИЗАЦИИ:
 * ─────────────────────────────────────
 * Измените только переменные в объекте BRAND_CONFIG ниже:
 *   - logoLine1, logoLine2  → имя организации (разбитое на 2 части)
 *   - subtitle              → подзаголовок под логотипом
 *   - accentColor           → основной акцентный цвет (HEX)
 *   - bgColor               → цвет фона страницы
 *   - contactPhone/web/social → контакты в подвале
 *
 * Чтобы заменить логотип-изображение: поместите файл в frontend/ и
 * укажите URL в logoImageUrl (или оставьте null для текстового логотипа).
 *
 * Чтобы заменить фоновый водяной знак: укажите путь в wmImageUrl
 * (или оставьте null — будет нарисован SVG-лотос).
 */

const BRAND_CONFIG = {
  logoLine1:    'PERI',
  logoLine2:    'CLINIC',
  logoSeparator:'✿',               // символ между частями логотипа
  subtitle:     'Клиника Эстетической медицины',
  docTitle:     'Домашний уход',

  // Путь к файлу логотипа-изображения. null = использовать текстовый логотип
  // Пример: '/logo.png'
  logoImageUrl: null,

  // URL фонового водяного знака. null = SVG-лотос
  // Пример: '/watermark.png'
  wmImageUrl:   null,

  accentColor:  '#b8943e',         // золотой акцент
  bgColor:      '#faf0e6',         // кремовый фон
  textColor:    '#2c2020',         // основной текст
  textLight:    '#7a5a3a',         // вторичный текст

  contactPhone:  '',               // '+7 (925) 017-77-78'
  contactWeb:    '',               // 'www.peri-clinic.ru'
  contactSocial: '',               // '@peri_clinic'
};

// ─── SVG-лотос (водяной знак) ──────────────────────────────────────────────
function buildLotusSvg(color = '#b8943e') {
  const petals = [];
  const N = 16; // количество лепестков
  for (let i = 0; i < N; i++) {
    const angle = (i * 360) / N;
    // Внешние длинные лепестки
    petals.push(`<ellipse cx="150" cy="150" rx="16" ry="90"
      transform="rotate(${angle} 150 150)" fill="${color}" opacity="0.13"/>`);
    // Средние лепестки
    petals.push(`<ellipse cx="150" cy="150" rx="10" ry="55"
      transform="rotate(${angle + 360/N/2} 150 150)" fill="${color}" opacity="0.09"/>`);
  }
  // Внутренние короткие
  for (let i = 0; i < 8; i++) {
    const angle = (i * 45);
    petals.push(`<ellipse cx="150" cy="150" rx="8" ry="28"
      transform="rotate(${angle} 150 150)" fill="${color}" opacity="0.18"/>`);
  }
  petals.push(`<circle cx="150" cy="150" r="22" fill="${color}" opacity="0.20"/>`);
  petals.push(`<circle cx="150" cy="150" r="10" fill="${color}" opacity="0.15"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"
    style="width:100%;height:100%">${petals.join('')}</svg>`;
}

// ─── Вспомогательные функции ───────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Рендер одной категории (чекбокс + продукты)
function renderCategory(catName, items = []) {
  const c   = BRAND_CONFIG.accentColor;
  const rows = items.map(it => `
    <div class="item-name">${escHtml(it.product_name)}</div>
    ${it.instructions
      ? `<div class="item-instr">${escHtml(it.instructions)}</div>`
      : ''}`).join('') || '<div class="empty-slot"></div>';

  return `
    <div class="cat-block">
      <div class="cat-name">
        <span class="cat-check">✓</span>${escHtml(catName)}
      </div>
      <div class="cat-items">${rows}</div>
    </div>`;
}

// Рендер одного столбца (Утро / Вечер)
function renderColumn(title, categories, grouped) {
  const inner = categories.map(cat =>
    renderCategory(cat, (grouped[cat] || []))
  ).join('');
  return `
    <div class="col">
      <div class="col-title">${escHtml(title)}</div>
      ${inner}
    </div>`;
}

// ─── Главная функция ────────────────────────────────────────────────────────
/**
 * Генерирует полный HTML-документ для печати/PDF.
 * @param {Object} prescription  — объект назначения из БД (+ items[])
 * @param {Object} [config]      — переопределение BRAND_CONFIG
 * @returns {string} HTML-строка
 */
function buildHomeCareHtml(prescription, config = {}) {
  const C = { ...BRAND_CONFIG, ...config };

  // Группируем items по time_of_day → { category: [items] }
  const bySection = {};
  (prescription.items || []).forEach(it => {
    if (!bySection[it.time_of_day]) bySection[it.time_of_day] = {};
    const cat = bySection[it.time_of_day];
    if (!cat[it.category]) cat[it.category] = [];
    cat[it.category].push(it);
  });

  const morningCats = ['Очищение','Демакияж','Тонизация','Сыворотка',
                       'Крем для лица','Крем для век','SPF'];
  const eveningCats = ['Демакияж','Очищение','Тонизация','Сыворотка',
                       'Крем для лица','Крем для век'];

  const clientName  = escHtml(prescription.client_name  || '—');
  const specialist         = escHtml(prescription.specialist_name || '');
  const specialistPosition = escHtml(prescription.specialist_position || '');
  const salonName   = escHtml(prescription.salon_name   || C.logoLine1 + ' ' + C.logoLine2);
  const dateStr     = prescription.created_at
    ? new Date(prescription.created_at)
        .toLocaleDateString('ru', {day:'2-digit',month:'long',year:'numeric'})
    : '';

  // Водяной знак
  const wmHtml = C.wmImageUrl
    ? `<img src="${C.wmImageUrl}" class="watermark" alt="">`
    : `<div class="watermark">${buildLotusSvg(C.accentColor)}</div>`;

  // Логотип
  const logoHtml = C.logoImageUrl
    ? `<!-- REPLACE: замените src на путь к вашему логотипу -->
       <img src="${C.logoImageUrl}" class="logo-image" alt="${salonName}">`
    : `<div class="logo-text">
         <span class="logo-word">${escHtml(C.logoLine1)}</span>
         <span class="logo-sep">${C.logoSeparator}</span>
         <span class="logo-word">${escHtml(C.logoLine2)}</span>
       </div>`;

  // Дополнительный уход
  const addSec = bySection['additional'] || {};
  const addHtml = (Object.keys(addSec).length) ? `
    <div class="add-section">
      <div class="add-title">Дополнительный уход</div>
      <div class="add-grid">
        ${['Маски','Пилинги'].map(cat =>
          `<div>${renderCategory(cat, addSec[cat] || [])}</div>`
        ).join('')}
      </div>
    </div>` : '';

  // Лист назначения
  const sheetAreas = [
    { key:'sheet_face', label:'Лицо' },
    { key:'sheet_body', label:'Тело' },
    { key:'sheet_hair', label:'Волосы' },
  ];
  const sheetFilled = sheetAreas.filter(a => {
    const s = bySection[a.key] || {};
    return Object.values(s).some(arr => arr.length > 0);
  });
  const sheetHtml = sheetFilled.length ? `
    <div class="sheet-section">
      <div class="section-title">Лист назначения</div>
      <div class="sheet-grid">
        ${sheetFilled.map(area => {
          const items = Object.values(bySection[area.key] || {}).flat();
          return `<div class="sheet-col">
            <div class="sheet-col-title">${escHtml(area.label)}</div>
            ${items.map(it=>`
              <div class="item-name">${escHtml(it.product_name)}</div>
              ${it.instructions?`<div class="item-instr">${escHtml(it.instructions)}</div>`:''}`
            ).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // Витамины
  const vitItems = Object.values(bySection['vitamins'] || {}).flat();
  const vitHtml = vitItems.length ? `
    <div class="vit-section">
      <div class="section-title">Витамины и добавки</div>
      ${vitItems.map(it=>`
        <div class="vit-item">
          <span class="cat-check">✓</span>
          <span class="item-name">${escHtml(it.product_name)}</span>
          ${it.instructions?`<span class="item-instr"> — ${escHtml(it.instructions)}</span>`:''}
        </div>`).join('')}
    </div>` : '';

  // Подвал контакты
  const footerContacts = [
    C.contactPhone  && `<span>📞 ${escHtml(C.contactPhone)}</span>`,
    C.contactWeb    && `<span>🌐 ${escHtml(C.contactWeb)}</span>`,
    C.contactSocial && `<span>📱 ${escHtml(C.contactSocial)}</span>`,
  ].filter(Boolean).join('<span class="footer-dot">·</span>');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(C.docTitle)} — ${clientName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Lora:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>
/* ═══════════════════════════════════════════════════════
   BRAND TOKENS — меняйте только здесь для другой организации
   ═══════════════════════════════════════════════════════ */
:root {
  --accent:   ${C.accentColor};   /* золотой акцент */
  --bg:       ${C.bgColor};       /* кремовый фон   */
  --text:     ${C.textColor};     /* основной текст */
  --text2:    ${C.textLight};     /* вторичный      */
  --font-h:   'Cormorant Garamond', Georgia, serif;
  --font-b:   'Lora', Georgia, serif;
}

/* ─── RESET ─── */
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

/* ─── PAGE ─── */
@page {
  size: A4;
  margin: 10mm 13mm 12mm 13mm;
}
html, body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-b);
  font-size: 9.2pt;
  line-height: 1.45;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page {
  background: var(--bg);
  padding: 20px 24px 16px;
  position: relative;
}

/* ─── WATERMARK ───────────────────────────────────────────────────────────
   Чтобы заменить водяной знак: замените src в теге <img class="watermark">
   на путь к вашему файлу. Размер и позицию регулируйте через .watermark.
   ─────────────────────────────────────────────────────────────────────── */
.watermark {
  position: fixed;
  top: 50%;
  left: 52%;
  transform: translate(-50%, -50%);
  width: 440px;
  height: 440px;
  pointer-events: none;
  z-index: 0;
  opacity: 1; /* SVG управляет opacity внутри себя */
}
.watermark img { width:100%; height:100%; object-fit:contain; opacity:0.10; }

/* ─── CONTENT ─── */
.content { position: relative; z-index: 1; }

/* ─── HEADER ──────────────────────────────────────────────────────────────
   Чтобы заменить текстовый логотип изображением:
   1. Поместите файл logo.png в папку frontend/
   2. В BRAND_CONFIG укажите logoImageUrl: '/logo.png'
   3. CSS .logo-image задаёт размер, меняйте max-height при необходимости.
   ─────────────────────────────────────────────────────────────────────── */
.header {
  text-align: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1.5px solid var(--accent);
}
.logo-image { max-height: 56px; max-width: 240px; object-fit:contain; margin-bottom:4px; }
.logo-text {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 3px;
}
.logo-word {
  font-family: var(--font-h);
  font-size: 15.5pt;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 5px;
  text-transform: uppercase;
}
.logo-sep { color: var(--accent); font-size: 18pt; line-height: 1; }
.subtitle {
  font-family: var(--font-b);
  font-size: 7.8pt;
  color: var(--text2);
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 9px;
}
.doc-title {
  font-family: var(--font-h);
  font-size: 21pt;
  font-weight: 500;
  font-style: italic;
  color: var(--text);
  margin-bottom: 5px;
}
.gold-bar {
  width: 44px; height: 2px;
  background: var(--accent);
  margin: 0 auto 8px;
}
.client-line {
  font-size: 9.5pt;
  color: var(--text);
}
.client-line b { font-style: italic; }

/* ─── TWO COLUMNS (Утро / Вечер) ─── */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-bottom: 10px;
}
.col-title {
  font-family: var(--font-h);
  font-size: 14pt;
  font-weight: 600;
  color: var(--text);
  border-bottom: 1.5px solid var(--accent);
  padding-bottom: 3px;
  margin-bottom: 10px;
}

/* ─── CATEGORIES ─── */
.cat-block { margin-bottom: 8px; }
.cat-name {
  font-size: 8.5pt;
  font-weight: 700;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-bottom: 2px;
}
.cat-check { color: var(--accent); font-size: 9pt; font-weight: 700; }
.cat-items { padding-left: 13px; }
.item-name {
  font-size: 8.8pt;
  color: var(--text);
  line-height: 1.5;
  font-weight: 500;
}
.item-instr {
  font-size: 7.8pt;
  color: var(--text2);
  font-style: italic;
  line-height: 1.4;
  margin-bottom: 2px;
}
/* Пустой слот — пунктирная линия */
.empty-slot {
  border-bottom: 1px dashed rgba(184,148,62,0.45);
  height: 1px;
  margin: 7px 0 9px;
}

/* ─── ДОПОЛНИТЕЛЬНЫЙ УХОД ─── */
.add-section {
  border-top: 1px solid rgba(184,148,62,0.35);
  padding-top: 9px;
  margin-bottom: 12px;
}
.add-title {
  font-family: var(--font-h);
  font-size: 11pt;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 7px;
}
.add-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28px;
}

/* ─── ЛИСТ НАЗНАЧЕНИЯ ─── */
.sheet-section {
  border-top: 1.5px solid var(--accent);
  padding-top: 10px;
  margin-bottom: 12px;
}
.section-title {
  font-family: var(--font-h);
  font-size: 12.5pt;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.sheet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 20px;
}
.sheet-col-title {
  font-size: 8.5pt;
  font-weight: 700;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid rgba(184,148,62,0.3);
  padding-bottom: 3px;
  margin-bottom: 5px;
}

/* ─── ВИТАМИНЫ ─── */
.vit-section {
  border-top: 1px solid rgba(184,148,62,0.3);
  padding-top: 9px;
  margin-bottom: 12px;
}
.vit-item {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-bottom: 3px;
  flex-wrap: wrap;
}

/* ─── NOTES ─── */
.notes-block {
  padding: 7px 11px;
  background: rgba(184,148,62,0.07);
  border-left: 3px solid var(--accent);
  border-radius: 3px;
  font-size: 8.2pt;
  font-style: italic;
  color: var(--text2);
  margin-top: 8px;
  margin-bottom: 10px;
}

/* ─── FOOTER ──────────────────────────────────────────────────────────────
   Для другой организации: замените contactPhone/Web/Social в BRAND_CONFIG
   ─────────────────────────────────────────────────────────────────────── */
.footer {
  margin-top: 12px;
  padding-top: 6px;
  border-top: 1px solid rgba(184,148,62,0.35);
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  font-size: 7.5pt;
  color: var(--text2);
  page-break-before: avoid;
  break-before: avoid;
}
.footer-contacts { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.footer-dot { color: var(--accent); }
.footer-sign {
  font-size: 8pt;
  color: var(--text);
  white-space: nowrap;
}
.footer-sign-line {
  display: inline-block;
  width: 130px;
  border-bottom: 1px solid var(--text);
  margin-left: 6px;
  vertical-align: middle;
}

/* ─── PRINT CONTROLS (только на экране) ─── */
.no-print {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: flex;
  gap: 8px;
  z-index: 9999;
}
.btn-print-go {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 10px 22px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  font-family: var(--font-h);
  font-weight: 600;
  letter-spacing: 0.5px;
}
.btn-close {
  background: var(--bg);
  color: var(--text2);
  border: 1px solid rgba(184,148,62,0.4);
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}

@media print {
  .no-print { display: none !important; }
  html, body { background: var(--bg); }
  .watermark { position: fixed; } /* фиксируем водяной знак на всех страницах */
}
</style>
</head>
<body>
<div class="page">

  <!-- ══ ВОДЯНОЙ ЗНАК ══ -->
  ${wmHtml}

  <div class="content">

    <!-- ══ ШАПКА ══ -->
    <div class="header">
      ${logoHtml}
      <div class="subtitle">${escHtml(C.subtitle)}</div>
      <div class="doc-title">${escHtml(C.docTitle)}</div>
      <div class="gold-bar"></div>
      <div class="client-line">Имя: <b>${clientName}</b></div>
    </div>

    <!-- ══ УТРО + ВЕЧЕР ══ -->
    <div class="two-col">
      ${renderColumn('Утро',    morningCats, bySection['morning'] || {})}
      ${renderColumn('Вечер',   eveningCats, bySection['evening'] || {})}
    </div>

    <!-- ══ ДОПОЛНИТЕЛЬНЫЙ УХОД ══ -->
    ${addHtml}

    <!-- ══ ЛИСТ НАЗНАЧЕНИЯ ══ -->
    ${sheetHtml}

    <!-- ══ ВИТАМИНЫ ══ -->
    ${vitHtml}

    <!-- ══ ЗАМЕТКИ ══ -->
    ${prescription.notes
      ? `<div class="notes-block">${escHtml(prescription.notes)}</div>` : ''}

    <!-- ══ ПОДВАЛ ══ -->
    <div class="footer">
      <div class="footer-contacts">${footerContacts || escHtml(salonName)}</div>
      <div class="footer-sign">
        Специалист: ${specialist || '—'}${specialistPosition ? ` <span style="font-size:10px;opacity:0.75">(${specialistPosition})</span>` : ''}
        <span class="footer-sign-line"></span>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /page -->

<div class="no-print">
  <button class="btn-print-go" onclick="window.print()">🖨 Печать / PDF</button>
  <button class="btn-close"    onclick="window.close()">Закрыть</button>
</div>
</body>
</html>`;
}

module.exports = { buildHomeCareHtml, BRAND_CONFIG };
