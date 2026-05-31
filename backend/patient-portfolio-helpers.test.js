'use strict';
const {
  buildS3Key, parseStage, normalizePhone, pickThumbForCard, assertCanMutate
} = require('./services/patient-portfolio');

describe('buildS3Key', () => {
  test('собирает ключ по схеме salon/client/visit/photo_variant', () => {
    expect(buildS3Key(1, 42, 7, 100, 'orig'))
      .toBe('salon_1/client_42/visit_7/100_orig.jpg');
    expect(buildS3Key(1, 42, 7, 100, 'med'))
      .toBe('salon_1/client_42/visit_7/100_med.jpg');
    expect(buildS3Key(1, 42, 7, 100, 'thumb'))
      .toBe('salon_1/client_42/visit_7/100_thumb.jpg');
  });
  test('бросает на невалидный variant', () => {
    expect(() => buildS3Key(1, 1, 1, 1, 'huge')).toThrow();
  });
});

describe('parseStage', () => {
  test.each(['before','in_progress','after'])('принимает %s', (s) => {
    expect(parseStage(s)).toBe(s);
  });
  test('тримит и нижний регистр', () => {
    expect(parseStage('  AFTER ')).toBe('after');
  });
  test.each([null, undefined, '', 'maybe', 'до', 42])('отклоняет %p', (v) => {
    expect(() => parseStage(v)).toThrow();
  });
});

describe('normalizePhone', () => {
  test.each([
    ['+7 (999) 123-45-67', '9991234567'],
    ['8(999)1234567',      '9991234567'],
    ['79991234567',        '9991234567'],
    ['9991234567',         '9991234567'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
  test('возвращает null на короткое', () => {
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('pickThumbForCard', () => {
  const photo = (stage, id) => ({ stage, id, s3_key_thumb: `t${id}` });
  test('предпочитает after', () => {
    expect(pickThumbForCard([photo('before',1), photo('after',2), photo('in_progress',3)]).id).toBe(2);
  });
  test('падает на in_progress если нет after', () => {
    expect(pickThumbForCard([photo('before',1), photo('in_progress',3)]).id).toBe(3);
  });
  test('берёт before если только он есть', () => {
    expect(pickThumbForCard([photo('before',1)]).id).toBe(1);
  });
  test('null на пустом массиве', () => {
    expect(pickThumbForCard([])).toBeNull();
  });
});

describe('assertCanMutate', () => {
  const ownerOk = (role) => { assertCanMutate({ id: 5, role }, 99); };       // другой автор
  const selfOk  = (role) => { assertCanMutate({ id: 5, role }, 5);  };       // свой
  test('owner всегда может', () => { expect(() => ownerOk('owner')).not.toThrow(); });
  test('admin всегда может', () => { expect(() => ownerOk('admin')).not.toThrow(); });
  test('specialist на своём — ок', () => { expect(() => selfOk('specialist')).not.toThrow(); });
  test('specialist на чужом — 403', () => { expect(() => ownerOk('specialist')).toThrow(/Forbidden|Only the author/); });
  test('owner на NULL author — ок', () => { expect(() => assertCanMutate({ id: 5, role: 'owner' }, null)).not.toThrow(); });
  test('specialist на NULL author — 403', () => { expect(() => assertCanMutate({ id: 5, role: 'specialist' }, null)).toThrow(); });
});
