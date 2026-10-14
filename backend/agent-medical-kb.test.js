'use strict';
const mk = require('./services/agent/medical-kb');
const { HANDOVER_ANNOUNCED_RE } = require('./services/agent/admin-hours');

describe('detectRedFlag — всегда', () => {
  test.each([
    ['После филлера побелела кожа на губе', 'skin_blanching'],
    ['кожа посинела вокруг укола', 'skin_blanching'],
    ['Кожа какая-то мраморная стала', 'skin_blanching'],
    ['Мне трудно дышать', 'breathing'],
    ['задыхаюсь', 'breathing'],
    ['отекает горло', 'breathing'],
    ['язык опух', 'breathing'],
    ['ухудшилось зрение', 'vision'],
    ['двоится в глазах', 'vision'],
    ['пелена перед глазами', 'vision'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'После Lumecca потемнели пятна',
    'синяк побледнел',
    'После губ синяк',
    'хочу больше объёма губ',
    'Добрый вечер',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });

  test('метка времени и не-строка не ломают детектор', () => {
    expect(mk.detectRedFlag('[13.10 22:01] задыхаюсь')).toEqual({ kind: 'breathing' });
    expect(mk.detectRedFlag(null)).toBeNull();
    expect(mk.detectRedFlag(['задыхаюсь'])).toBeNull();
  });
});

describe('detectRedFlag — только при контексте процедуры', () => {
  test.each([
    ['После губ поднялась температура', 'fever'],
    ['сделала ботокс, температура 38,5', 'fever'],
    ['вчера делали биоревитализацию, озноб', 'fever'],
    ['После чистки гноится', 'pus'],
    ['после укола нагноение', 'pus'],
    ['после процедуры резкая боль', 'severe_pain'],
    ['После филлера боль нарастает', 'severe_pain'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'температура 38, можно ли прийти на чистку?',
    'Можно ли после процедуры в баню, там высокие температуры?',
    'гной на подбородке, поможет ли чистка?',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });
});

describe('buildRedFlagReply', () => {
  test.each([false, true])('adminOff=%s: объявляет перевод (диспетчер не дошлёт вторую фразу)', (adminOff) => {
    expect(mk.buildRedFlagReply({ adminOff })).toMatch(HANDOVER_ANNOUNCED_RE);
  });
  test('нерабочее время — неотложная помощь 103/112', () => {
    expect(mk.buildRedFlagReply({ adminOff: true })).toMatch(/103 или 112/);
    expect(mk.buildRedFlagReply({ adminOff: false })).not.toMatch(/103/);
  });
});

describe('wantsMedicalKb', () => {
  test.each([
    'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?',
    'Кормлю грудью, можно мне био?',
    'У меня диабет, можно био?',
    'Как проходит лазерная эпиляция, больно?',
    'После Lumecca покраснение 2 дня, это нормально?',
    'После губ бугорок',
    'какие противопоказания у ботокса',
    'на ГВ можно?',
    'болит место укола',
    'боль после чистки',
    'Сколько стоит био при беременности?',
  ])('«%s» → да', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(true);
  });

  test.each([
    'хочу больше объёма губ',
    'Можно ли записаться на био в пятницу?',
    'Можно ли перенести запись на субботу?',
    'Сколько стоит курс биоревитализации?',
    'Здравствуйте!',
    '',
  ])('«%s» → нет', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(false);
  });

  test('не-строка → false', () => {
    expect(mk.wantsMedicalKb(null)).toBe(false);
    expect(mk.wantsMedicalKb(['болит'])).toBe(false);
  });
});
