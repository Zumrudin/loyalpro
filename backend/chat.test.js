'use strict';
const { dialogKey, isMedia, mediaLabel, messagePreview } = require('./services/chat');

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
