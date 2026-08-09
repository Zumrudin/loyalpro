'use strict';

// Отправка фото прайс-листа по направлению услуг. Инструмент НИЧЕГО не шлёт
// сам: он проверяет узел, канал и кладёт вложения в буфер хода (ctx.attachments),
// а отправляет их диспетчер вместе с текстовой репликой. ЗАЧЕМ так: отправка
// внутри tool-цикла была бы side-effect'ом, и ход перестал бы выбрасываться при
// серии сообщений — клиент получал бы картинку без слов либо дубль ответа.
// КОНТРАКТ С ВЫЗЫВАЮЩИМ: `ctx.attachments` — НОВЫЙ массив на КАЖДУЮ попытку
// хода. Переиспользованный между перегенерациями буфер увёз бы пациенту фото
// от ЧЕРНОВИКА, который выброшен и текстом до него не дошёл.
const priceList = require('../price-list');

// Chatpush send_file умеет файлы только в этих каналах.
const FILE_CHANNELS = new Set(['whatsapp', 'tdlib', 'max']);

const HINT_ATTACHED = 'Фото прайса уйдут пациенту СРАЗУ ПОСЛЕ твоего сообщения — не пиши «во вложении выше». Не пересказывай содержимое листа и не называй цены «с картинки»: ты их не видишь. Конкретную цену бери только из каталога услуг.';
const HINT_NO_PHOTO = 'Готового листа по этому направлению нет. Дай ссылку на прайс на сайте и предложи назвать конкретную услугу — её цену скажешь точно. Причину («нет файла», «канал не поддерживает») пациенту не объясняй.';

const schema = {
  name: 'send_price_list',
  description: 'Отправить пациенту фото прайс-листа по НАПРАВЛЕНИЮ услуг. ' +
    'Звать, когда пациент просит прайс/цены по направлению целиком («прайс на эпиляцию», «сколько стоит лазерная эпиляция»). ' +
    'Для цены КОНКРЕТНОЙ услуги инструмент не нужен — её называй из каталога.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Ключ направления из блока «ПРАЙС-ЛИСТЫ В КАРТИНКАХ» (например c12 или s7), дословно',
      },
    },
    required: ['category'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const bucket = Array.isArray(ctx.attachments) ? ctx.attachments : null;
  if (!ctx.priceIndex || !bucket) {
    return { error: 'Прайс-листы сейчас недоступны — назови цену конкретной услуги из каталога.' };
  }
  const key = String((input && input.category) || '').trim();
  const found = priceList.resolvePhotos(key, ctx.priceIndex);
  if (!found) {
    return { error: `Неизвестный ключ направления «${key}». Возьми ключ из блока «ПРАЙС-ЛИСТЫ В КАРТИНКАХ» дословно.` };
  }
  const url = ctx.priceIndex.priceListUrl || null;

  // Дедуп по узлу-ИСТОЧНИКУ фото, а не по запрошенному: у подкатегории своих
  // листов может не быть, и она отдаёт родительские — вопрос про подкатегорию
  // И про её направление в одном ходу прислал бы пациенту одни и те же
  // картинки дважды под двумя названиями.
  const sourceKey = found.inheritedFrom || found.node.key;
  if (bucket.some(a => a.sourceKey === sourceKey)) {
    return { attached: true, already_attached: true, category: found.node.title, hint: HINT_ATTACHED };
  }
  if (!found.photos.length) {
    return { attached: false, reason: 'no_photo', category: found.node.title, price_list_url: url, hint: HINT_NO_PHOTO };
  }
  if (!FILE_CHANNELS.has(ctx.channel)) {
    return { attached: false, reason: 'channel_unsupported', category: found.node.title, price_list_url: url, hint: HINT_NO_PHOTO };
  }
  const free = priceList.MAX_PHOTOS_PER_TURN - bucket.length;
  if (free <= 0) {
    return { attached: false, reason: 'limit', category: found.node.title, price_list_url: url, hint: HINT_NO_PHOTO };
  }
  const take = found.photos.slice(0, free);
  for (const p of take) {
    bucket.push({
      nodeKey: found.node.key, sourceKey, category: found.node.title,
      fileUrl: p.fileUrl, fileName: p.fileName, mimeType: p.mimeType,
    });
  }
  return { attached: true, category: found.node.title, photos: take.length, hint: HINT_ATTACHED };
}

module.exports = { schema, run };
