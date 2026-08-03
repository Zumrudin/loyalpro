'use strict';
const { dialogKey, isGroupKey, defaultChannel, recipientParams, isMedia, mediaLabel, messagePreview, phoneMatchCandidates } = require('./services/chat');
const { parseMessageEvent, deliveryIdFromWhatsappEchoId, ownOutgoingExternalId } = require('./services/chatpush');

describe('dialogKey', () => {
  test('prefers phone', () => {
    expect(dialogKey({ phone: '+79991234567', chat_id: 'c1' })).toBe('+79991234567');
  });
  test('falls back to chat_id when phone empty/blank', () => {
    expect(dialogKey({ phone: '', chat_id: 'c1' })).toBe('c1');
    expect(dialogKey({ phone: '   ', chat_id: 'c1' })).toBe('c1');
  });
  test('empty string when neither present', () => {
    expect(dialogKey({})).toBe('');
  });
});

describe('isMedia', () => {
  test('text types are not media', () => {
    expect(isMedia('text')).toBe(false);
    expect(isMedia('formattedText')).toBe(false);
    expect(isMedia('')).toBe(false);
  });
  test('non-text types are media', () => {
    expect(isMedia('document')).toBe(true);
    expect(isMedia('image')).toBe(true);
  });
});

describe('mediaLabel', () => {
  test('maps known types', () => {
    expect(mediaLabel('image')).toBe('📎 Фото');
    expect(mediaLabel('video')).toBe('📎 Видео');
    expect(mediaLabel('voice')).toBe('📎 Аудио');
    expect(mediaLabel('document')).toBe('📎 Документ');
  });
  test('falls back to generic attachment', () => {
    expect(mediaLabel('sticker')).toBe('📎 Вложение');
  });
});

describe('messagePreview', () => {
  test('returns trimmed text for text messages', () => {
    expect(messagePreview({ msg_type: 'text', text: '  привет  ' })).toBe('привет');
  });
  test('returns attachment label for media', () => {
    expect(messagePreview({ msg_type: 'document', text: '' })).toBe('📎 Документ');
  });
  test('empty for null', () => {
    expect(messagePreview(null)).toBe('');
  });
});

describe('parseMessageEvent — WhatsApp nested payload', () => {
  // Реальная форма WhatsApp (проверено на живых данных): customer_id лежит в
  // payload.customer_id, объекта payload.instance НЕТ, сообщение — в new_message.
  const waBody = {
    type: 'whatsapp_incoming_msg',
    payload: {
      customer_id: 46594,
      delivery_id: 1,
      new_message: {
        chat_id: '79200255591@c.us',
        chat_phone: '79200255591',
        sender_phone_number: '79200255591',
        sender_name: 'Зумрудин Гаджиев',
        pushname: 'Зумрудин',
        direction: 'incoming',
        message: { id: 'WA123', type: 'text', text: 'Это тестовое сообщение!', timestamp: 1784365659 },
      },
    },
  };
  test('extracts customer_id from payload.customer_id (no instance object)', () => {
    expect(parseMessageEvent(waBody).customerId).toBe(46594);
  });
  test('extracts the client phone from chat_phone', () => {
    expect(parseMessageEvent(waBody).phone).toBe('79200255591');
  });
  test('WhatsApp не шлёт chat_type → null (группу там ловим по jid @g.us)', () => {
    expect(parseMessageEvent(waBody).chatType).toBeNull();
  });
});

describe('parseMessageEvent — chat_type (гейт группового чата)', () => {
  // Живая плоская форма MAX: группа «Админы PERI CLINIC» шлёт chat_type='group'
  // И номер участника в sender_phone_number — по номеру группу не отличить.
  const groupBody = {
    type: 'max_incoming_msg',
    payload: {
      customer_id: 46594,
      chat_id: '-72962629261478',
      chat_type: 'group',
      chat_name: 'Админы PERI CLINIC',
      direction: 'incoming',
      sender_phone_number: '79250177778',
      timestamp: 1785783150,
      message: { id: '117033084582515339', type: 'text', text: 'Остаток в кассе: 75 358' },
    },
  };
  test('chat_type группы доезжает до нормализованного сообщения', () => {
    expect(parseMessageEvent(groupBody).chatType).toBe('group');
  });
  test('личный чат — person', () => {
    const personBody = { ...groupBody, payload: { ...groupBody.payload, chat_type: 'person', chat_id: '41588932' } };
    expect(parseMessageEvent(personBody).chatType).toBe('person');
  });
});

describe('phoneMatchCandidates', () => {
  test('generates RU prefix variants around the 10-digit core', () => {
    const c = phoneMatchCandidates('79200255591');
    expect(c).toContain('+79200255591');
    expect(c).toContain('79200255591');
    expect(c).toContain('89200255591');
  });
  test('normalizes +7 and 8 inputs to the same core', () => {
    expect(phoneMatchCandidates('+7 (920) 025-55-91')).toContain('+79200255591');
    expect(phoneMatchCandidates('89200255591')).toContain('+79200255591');
  });
  test('returns [] for empty, null or too-short input', () => {
    expect(phoneMatchCandidates('')).toEqual([]);
    expect(phoneMatchCandidates(null)).toEqual([]);
    expect(phoneMatchCandidates('12345')).toEqual([]);
  });
});

describe('dialogKey (группы)', () => {
  test('групповой chat_id (минус) даёт ключ g:<chat_id> и игнорирует phone', () => {
    expect(dialogKey({ phone: '79991234567', chat_id: '-1003759304044' }))
      .toBe('g:-1003759304044');
    expect(dialogKey({ phone: '', chat_id: '-72962629261478' }))
      .toBe('g:-72962629261478');
  });
});

describe('isGroupKey', () => {
  test('распознаёт групповой ключ', () => {
    expect(isGroupKey('g:-100123')).toBe(true);
    expect(isGroupKey('79991234567')).toBe(false);
    expect(isGroupKey('')).toBe(false);
  });
});

describe('defaultChannel', () => {
  test('канал последнего входящего', () => {
    const msgs = [
      { direction: 'incoming', channel: 'whatsapp', msg_ts: 100 },
      { direction: 'outgoing', channel: 'tdlib',    msg_ts: 200 },
      { direction: 'incoming', channel: 'max',      msg_ts: 150 },
    ];
    expect(defaultChannel(msgs)).toBe('max');
  });
  test('без входящих — канал последнего сообщения; пусто — null', () => {
    expect(defaultChannel([{ direction: 'outgoing', channel: 'tdlib', msg_ts: 1 }])).toBe('tdlib');
    expect(defaultChannel([])).toBe(null);
  });
});

describe('recipientParams', () => {
  test('whatsapp — по номеру', () => {
    expect(recipientParams('whatsapp', { phone: '79991234567', chat_id: '79991234567@c.us' }))
      .toEqual({ dispatchRouting: ['whatsapp'], phone: '79991234567' });
  });
  test('tdlib без номера — tdlib_user_id из chat_id', () => {
    expect(recipientParams('tdlib', { phone: '', chat_id: '497419949' }))
      .toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '497419949' });
  });
  test('tdlib группа — tdlib_user_id даже при известном phone отправителя', () => {
    expect(recipientParams('tdlib', { phone: '79991234567', chat_id: '-100123', isGroup: true }))
      .toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '-100123' });
  });
  test('max — phone + max_user_id; telegram_bot маппится в telegram', () => {
    expect(recipientParams('max', { phone: '79999892340', chat_id: '30849437' }))
      .toEqual({ dispatchRouting: ['max'], phone: '79999892340', max_user_id: '30849437' });
    expect(recipientParams('telegram_bot', { phone: '79991234567', chat_id: '1' }).dispatchRouting)
      .toEqual(['telegram']);
  });
  test('нет идентификаторов — null', () => {
    expect(recipientParams('whatsapp', { phone: '', chat_id: '' })).toBe(null);
  });
});

// Chatpush перестал слать эхо наших исходящих WhatsApp (с ~2026-07-26 — только
// message_status без текста), поэтому исходящие в WhatsApp пишем сразу при
// отправке. Эти хелперы связывают отправку и (возможное) эхо, чтобы не задвоить.
describe('deliveryIdFromWhatsappEchoId', () => {
  test('извлекает delivery_id из id нашего API-отправленного WhatsApp-эха', () => {
    expect(deliveryIdFromWhatsappEchoId('true_214490700357823@lid_d371968314THISISBOT'))
      .toBe('371968314');
  });
  test('null для ручного (нативного) WhatsApp-id без метки', () => {
    expect(deliveryIdFromWhatsappEchoId('true_223286927609990@lid_3A582D4461C487E42F50'))
      .toBeNull();
  });
  test('null для не-строки', () => {
    expect(deliveryIdFromWhatsappEchoId(null)).toBeNull();
    expect(deliveryIdFromWhatsappEchoId(371968314)).toBeNull();
  });
});

describe('ownOutgoingExternalId', () => {
  test('префикс api: к delivery_id (строка или число)', () => {
    expect(ownOutgoingExternalId('371968314')).toBe('api:371968314');
    expect(ownOutgoingExternalId(371968314)).toBe('api:371968314');
  });
});
