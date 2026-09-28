'use strict';

const { buildSystemPrompt, FACTUAL_SECTION_MARKER } = require('./services/agent/system-prompt');
const { buildSystemPromptV2 } = require('./services/agent/system-prompt-v2');
const priceList = require('./services/agent/price-list');
const sendPriceList = require('./services/agent/tools/send-price-list');

describe.each([
  ['v1', buildSystemPrompt],
  ['v2', buildSystemPromptV2],
])('%s: подтверждённое отсутствие препарата', (_version, build) => {
  test.each(['Есть ли препарат Example Bright?', 'Сколько стоит Example Bright?'])('%s', lastUserText => {
    const p = build({ lastUserText, priceListBlock: 's7|Биоревитализация' });
    const at = p.indexOf('НАЛИЧИЕ КОНКРЕТНОГО ПРЕПАРАТА:');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(p.indexOf(FACTUAL_SECTION_MARKER));
    expect(p).toMatch(/отсутствие подтверждено[^\n]*вызови send_price_list/i);
    expect(p).toMatch(/Только из-за подтверждённого отсутствия НЕ вызывай escalate_to_operator/);
    expect(p).toMatch(/НЕ называй их равнозначной заменой/);
    expect(p).toMatch(/Подбор препарата оставь врачу/);
  });

  test('поиск без результата, скрытая услуга и пустая цена не доказывают отсутствие', () => {
    const p = build({ catalogBlock: 'КАТАЛОГ\n11|Example Other|30||Биоревитализация|7' });
    expect(p).toMatch(/Отсутствие строки в каталоге, результата поиска или цены НЕ доказывает отсутствие/);
    expect(p).toMatch(/Слова пациента и прежние догадки бота подтверждением НЕ являются/);
    expect(p).toMatch(/Старое сообщение о временном отсутствии без актуального подтверждения недостаточно/);
    expect(p).toMatch(/данные неполные, устаревшие или противоречивые[^\n]*Вызови escalate_to_operator/);
    expect(p).toMatch(/Отсутствие цены у представленного препарата — неизвестная стоимость/);
  });

  test('правило действует и без фотографий, но не обещает несуществующее вложение', () => {
    const p = build({});
    expect(p).toMatch(/Обещай фотографии только после attached:true/);
    expect(p).toMatch(/если блок прайс-листов недоступен, не выдумывай ключ направления и не обещай фото/);
    expect(p).toMatch(/Отсутствие фотографии само по себе не требует перевода/);
    expect(p).toMatch(/Прямая просьба позвать человека, медицинские ограничения и стоп-темы сохраняют приоритет/);
  });
});

test('v1: исключение согласовано с запретами фото и перевода для нестандартной услуги', () => {
  const p = buildSystemPrompt({ priceListBlock: 's7|Биоревитализация' });
  expect(p).toMatch(/КОНКРЕТНУЮ услугу[^\n]*НЕ отправляй фото, кроме сценария подтверждённого отсутствия/);
  expect(p).toMatch(/НЕ отправляй прайс по своей инициативе[^\n]*либо при подтверждённом отсутствии/);
  expect(p).toMatch(/Нестандартная услуга \(кроме подтверждённого отсутствия препарата/);
  expect(sendPriceList.schema.description).toMatch(/при подтверждённом отсутствии запрошенного препарата/);
});

test('ассортимент уходит тем же буфером: два листа, повтор не дублирует их', async () => {
  const ctx = {
    channel: 'whatsapp', attachments: [],
    priceIndex: priceList.buildIndex({
      categories: [{ id: 30, title: 'Инъекции' }],
      subcats: [{ id: 7, yc_category_id: 30, title: 'Биоревитализация' }],
      photos: [1, 2].map(id => ({ id, subcategory_id: 7,
        file_url: `/uploads/example-${id}.jpg`, file_name: `example-${id}.jpg`, mime_type: 'image/jpeg' })),
    }),
  };
  expect(await sendPriceList.run(1, { category: 's7' }, ctx)).toMatchObject({ attached: true, photos: 2 });
  expect(await sendPriceList.run(1, { category: 's7' }, ctx)).toMatchObject({ already_attached: true });
  expect(ctx.attachments).toHaveLength(2);
  expect(ctx.attachments.every(a => a.category === 'Биоревитализация')).toBe(true);
});
