'use strict';
const { channelOptions, phoneVariants, FILE_NAME, CAPTION } = require('./services/home-care-send');

describe('home-care-send.channelOptions', () => {
  test('номер есть, переписки нет: WhatsApp и MAX доступны, Telegram — нет', () => {
    const o = channelOptions('+7 (920) 025-55-91', []);
    const by = Object.fromEntries(o.channels.map(c => [c.channel, c]));
    expect(o.dialogKey).toBe('79200255591');
    expect(by.whatsapp.available).toBe(true);
    expect(by.whatsapp.params).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(by.max.available).toBe(true);
    expect(by.tdlib.available).toBe(false);
    expect(by.tdlib.reason).toMatch(/Telegram/);
    expect(o.defaultChannel).toBe('whatsapp');
  });

  test('по умолчанию — мессенджер последнего входящего; Telegram по chat_id, MAX с max_user_id', () => {
    const o = channelOptions('89200255591', [
      { channel: 'tdlib', phone: null, chat_id: '385578542', msg_ts: 200 },
      { channel: 'max', phone: '79200255591', chat_id: '62232990', msg_ts: 100 },
    ]);
    const by = Object.fromEntries(o.channels.map(c => [c.channel, c]));
    expect(o.defaultChannel).toBe('tdlib');
    expect(by.tdlib.params).toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542' });
    expect(by.max.params).toEqual({ dispatchRouting: ['max'], phone: '79200255591', max_user_id: '62232990' });
  });

  test('без номера ничего, кроме канала, куда клиент писал', () => {
    const o = channelOptions(null, []);
    expect(o.channels.every(c => !c.available)).toBe(true);
    expect(o.defaultChannel).toBeNull();
  });

  test('варианты номера и имя файла', () => {
    expect(phoneVariants('8 920 025 55 91')).toEqual(['79200255591', '+79200255591', '89200255591']);
    expect(phoneVariants('123')).toEqual([]);
    expect(FILE_NAME).toMatch(/^[A-Za-z0-9_]+\.pdf$/);
    expect(CAPTION).toBe('Лист назначения');
  });
});

describe('home-care-send: стоимость услуги', () => {
  const { itemPrice, priceIndex, titleKey } = require('./services/home-care-send');
  const { formatRub } = require('./homecare-template');

  test('цена сохраняется только у услуг листа назначения', () => {
    expect(itemPrice({ time_of_day: 'sheet_face', price: '4 500' })).toBe(4500);
    expect(itemPrice({ time_of_day: 'sheet_hair', price: '1500,50' })).toBe(1500.5);
    expect(itemPrice({ time_of_day: 'morning', price: 900 })).toBeNull();
    expect(itemPrice({ time_of_day: 'vitamins', price: 900 })).toBeNull();
    expect(itemPrice({ time_of_day: 'sheet_body', price: '' })).toBeNull();
    expect(itemPrice({ time_of_day: 'sheet_body', price: 'abc' })).toBeNull();
    expect(itemPrice({ time_of_day: 'sheet_body', price: -5 })).toBeNull();
  });

  test('цена YClients: price_min, при пустом — price_max; management первым', () => {
    const m = priceIndex(
      [{ title: 'Чистка  лица', price_min: 0, price_max: 5000 }, { title: 'Пилинг', price_min: 0, price_max: 0 }],
      [{ title: 'чистка лица', price_min: 100, price_max: 100 }, { title: 'Пилинг', price_min: 3000, price_max: 3500 }],
    );
    expect(m.get(titleKey('Чистка лица'))).toBe(5000);
    expect(m.get(titleKey('Пилинг'))).toBe(3000);
  });

  test('формат в листе: цифры и знак рубля, без разрыва', () => {
    expect(formatRub(4500)).toBe('4 500 ₽');
    expect(formatRub('12500.50')).toBe('12 500,5 ₽');
    expect(formatRub(null)).toBe('');
    expect(formatRub('')).toBe('');
  });
});
