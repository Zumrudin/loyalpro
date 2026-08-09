'use strict';
// Живая проверка прайс-фото: реальный салон, реальный индекс из БД и файлов,
// реальный инструмент. ОТПРАВКА ЗАСТАБЛЕНА — никому ничего не уходит.
//
//   node scripts/agent-price-photo-e2e.js [salonId]

const priceListData = require('../services/agent/price-list-data');
const priceList = require('../services/agent/price-list');
const tool = require('../services/agent/tools/send-price-list');

(async () => {
  const salonId = Number(process.argv[2] || 1);
  const index = await priceListData.loadPriceIndex(salonId);
  const block = priceList.renderPriceListBlock(index);
  console.log('── Блок промпта ──');
  console.log(block || '(блока нет: ни фото, ни ссылки)');

  const withPhotos = [...index.nodes.values()].filter(n => n.photos.length);
  if (!withPhotos.length) {
    console.log('\nФото прайса в салоне нет — загрузите хотя бы одно в админке и повторите.');
    process.exit(0);
  }

  const key = withPhotos[0].key;
  const ctx = { channel: 'whatsapp', priceIndex: index, attachments: [] };
  console.log(`\n── Вызов send_price_list(${key}) ──`);
  console.log(await tool.run(salonId, { category: key }, ctx));
  console.log('Вложений в буфере хода:', ctx.attachments.length);

  console.log('\n── Файлы читаются с диска ──');
  for (const att of ctx.attachments) {
    const buf = await priceListData.readPhotoBuffer(att.fileUrl);
    console.log(att.fileUrl, buf ? `${buf.length} байт` : 'НЕ ПРОЧИТАН');
  }

  console.log('\n── Канал без файлов (telegram_bot) ──');
  console.log(await tool.run(salonId, { category: key }, { channel: 'telegram_bot', priceIndex: index, attachments: [] }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
