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
