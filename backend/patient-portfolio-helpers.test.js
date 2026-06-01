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

describe('stageFlags', () => {
  const { stageFlags } = require('./services/patient-portfolio');
  const photo = (stage) => ({ stage });
  test('обе стадии присутствуют', () => {
    expect(stageFlags([photo('before'), photo('after')])).toEqual({ has_before: true, has_after: true });
  });
  test('только before', () => {
    expect(stageFlags([photo('before'), photo('in_progress')])).toEqual({ has_before: true, has_after: false });
  });
  test('только after', () => {
    expect(stageFlags([photo('after')])).toEqual({ has_before: false, has_after: true });
  });
  test('пусто/не массив', () => {
    expect(stageFlags([])).toEqual({ has_before: false, has_after: false });
    expect(stageFlags(null)).toEqual({ has_before: false, has_after: false });
  });
});

describe('pickPreviewSet', () => {
  const { pickPreviewSet } = require('./services/patient-portfolio');
  const p = (id, stage) => ({ id, stage });

  test('по одному из каждой стадии в порядке before → in_progress → after', () => {
    const photos = [p(1,'before'), p(2,'in_progress'), p(3,'after')];
    expect(pickPreviewSet(photos).map(x => x.id)).toEqual([1, 2, 3]);
  });
  test('только before — недостающие добиваем из той же стадии', () => {
    const photos = [p(1,'before'), p(2,'before'), p(3,'before')];
    expect(pickPreviewSet(photos).map(x => x.id)).toEqual([1, 2, 3]);
  });
  test('две стадии, in_progress пуст — третий слот из лишних', () => {
    const photos = [p(1,'before'), p(2,'before'), p(3,'after')];
    expect(pickPreviewSet(photos).map(x => x.id)).toEqual([1, 3, 2]);
  });
  test('меньше трёх всего — возвращаем что есть', () => {
    expect(pickPreviewSet([p(1,'before')]).map(x => x.id)).toEqual([1]);
    expect(pickPreviewSet([p(1,'after'), p(2,'after')]).map(x => x.id)).toEqual([1, 2]);
  });
  test('пусто / не массив', () => {
    expect(pickPreviewSet([])).toEqual([]);
    expect(pickPreviewSet(null)).toEqual([]);
  });
  test('max параметр уважается', () => {
    const photos = [p(1,'before'), p(2,'in_progress'), p(3,'after'), p(4,'after')];
    expect(pickPreviewSet(photos, 2).map(x => x.id)).toEqual([1, 2]);
  });
  test('первый из стадии — это первый по порядку (sort_order, id)', () => {
    // если before имеет несколько, берём первый из массива
    const photos = [p(5,'before'), p(1,'before'), p(9,'after')];
    expect(pickPreviewSet(photos).map(x => x.id)).toEqual([5, 9, 1]);
  });
});
