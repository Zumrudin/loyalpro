const fs = require('fs');
const path = require('path');
const { inlineFontCss } = require('./homecare-fonts');
const { buildHomeCareHtml } = require('./homecare-template');

const RX = {
  client_name: 'Иванова Анна', salon_name: 'PERI CLINIC', start_date: '2026-04-28',
  items: [{ time_of_day: 'morning', category: 'Очищение', product_name: 'Гель', sort_order: 0 }],
};

describe('homecare-fonts: шрифты PDF без сети', () => {
  test('каждый @font-face встроен data: URI, ссылок наружу нет', () => {
    const css = inlineFontCss();
    const faces = css.match(/@font-face/g) || [];
    expect(faces.length).toBe(JSON.parse(fs.readFileSync(path.join(__dirname, 'homecare-fonts/faces.json'))).length);
    expect(css).not.toMatch(/https?:\/\//);
    expect((css.match(/url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/g) || []).length).toBe(faces.length);
  });

  test('покрыты оба семейства шаблона и кириллица', () => {
    const css = inlineFontCss();
    expect(css).toContain("font-family: 'Cormorant Garamond'");
    expect(css).toContain("font-family: 'Lora'");
    expect(css).toMatch(/\/\* cyrillic \*\//);
  });

  test('шаблон с fontCss не обращается к Google Fonts (PDF)', () => {
    const html = buildHomeCareHtml(RX, { fontCss: inlineFontCss() });
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).toContain('@font-face');
  });

  test('без fontCss предпросмотр по-прежнему берёт Google Fonts', () => {
    const html = buildHomeCareHtml(RX);
    expect(html).toContain('https://fonts.googleapis.com/css2?family=Cormorant+Garamond');
    expect(html).not.toContain('@font-face');
  });
});
