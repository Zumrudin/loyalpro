'use strict';

const {
  buildPhotoFilename,
  validateReorderPayload,
  absolutizeUrl,
} = require('./services/portfolio');

describe('buildPhotoFilename', () => {
  test('category cover filename', () => {
    const name = buildPhotoFilename('category', 12, null, 'photo.JPG', 1714000000000);
    expect(name).toBe('portfolio_cat_12_1714000000000.jpg');
  });

  test('item after-photo filename', () => {
    const name = buildPhotoFilename('item', 45, 'after', 'IMG_1234.png', 1714000000000);
    expect(name).toBe('portfolio_item_45_after_1714000000000.png');
  });

  test('item before-photo filename', () => {
    const name = buildPhotoFilename('item', 45, 'before', 'x.webp', 1714000000000);
    expect(name).toBe('portfolio_item_45_before_1714000000000.webp');
  });

  test('falls back to .jpg if no extension', () => {
    const name = buildPhotoFilename('category', 1, null, 'noext', 1);
    expect(name).toBe('portfolio_cat_1_1.jpg');
  });

  test('rejects unknown kind for item', () => {
    expect(() => buildPhotoFilename('item', 1, 'middle', 'x.jpg', 1))
      .toThrow(/kind/);
  });
});

describe('validateReorderPayload', () => {
  test('valid payload', () => {
    const r = validateReorderPayload([{ id: 1, display_order: 0 }, { id: 2, display_order: 1 }]);
    expect(r.valid).toBe(true);
  });

  test('rejects empty array', () => {
    expect(validateReorderPayload([]).valid).toBe(false);
  });

  test('rejects non-array', () => {
    expect(validateReorderPayload({}).valid).toBe(false);
    expect(validateReorderPayload(null).valid).toBe(false);
  });

  test('rejects entries with non-integer id', () => {
    expect(validateReorderPayload([{ id: 'x', display_order: 0 }]).valid).toBe(false);
  });

  test('rejects entries with non-integer display_order', () => {
    expect(validateReorderPayload([{ id: 1, display_order: 'a' }]).valid).toBe(false);
  });

  test('rejects duplicate ids', () => {
    expect(validateReorderPayload([{ id: 1, display_order: 0 }, { id: 1, display_order: 1 }]).valid).toBe(false);
  });
});

describe('absolutizeUrl', () => {
  test('returns null for null/empty', () => {
    expect(absolutizeUrl('https://api.test', null)).toBeNull();
    expect(absolutizeUrl('https://api.test', '')).toBeNull();
  });

  test('passes through absolute http/https', () => {
    expect(absolutizeUrl('https://api.test', 'http://x/y')).toBe('http://x/y');
    expect(absolutizeUrl('https://api.test', 'https://x/y')).toBe('https://x/y');
  });

  test('prepends base for relative', () => {
    expect(absolutizeUrl('https://api.test', '/uploads/a.jpg')).toBe('https://api.test/uploads/a.jpg');
  });
});
