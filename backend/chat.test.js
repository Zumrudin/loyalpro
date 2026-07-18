'use strict';
const { dialogKey, isMedia, mediaLabel, messagePreview, phoneMatchCandidates } = require('./services/chat');
const { parseMessageEvent } = require('./services/chatpush');

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
