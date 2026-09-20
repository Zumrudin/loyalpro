'use strict';
// Выбор бонусной фразы для напоминания Милы о себе. Чистый модуль.
const { chooseBonusLine, formatBalance, BONUS_MENTION_RE } = require('./services/agent/followup-bonus');

const settings = (over = {}) => ({
  followupBonusText: 'На вашей карте {balance} бонусов 🤍',
  followupWelcomeText: 'При регистрации дарим 500 баллов.',
  followupBonusMinBalance: 100,
  ...over,
});
const base = (over = {}) => ({
  situation: { kind: 'price', bonusOk: true },
  card: { status: 'ok', balance: 3024, cardId: 1 },
  settings: settings(),
  alreadyMentioned: false,
  recentlySent: false,
  nudgeText: 'Подскажите, записать вас?',
  ...over,
});

test('formatBalance: разряды через неразрывный пробел, целое', () => {
  expect(formatBalance(3024)).toBe('3 024');
  expect(formatBalance(950)).toBe('950');
  expect(formatBalance(1234567.9)).toBe('1 234 567');
});

test('держатель карты выше порога → balance с подстановкой', () => {
  expect(chooseBonusLine(base())).toEqual({ kind: 'balance', balance: 3024, text: 'На вашей карте 3 024 бонусов 🤍' });
});
test('баланс ниже порога → ничего (ни баланса, ни приглашения)', () => {
  expect(chooseBonusLine(base({ card: { status: 'ok', balance: 99 } }))).toBe(null);
  expect(chooseBonusLine(base({ card: { status: 'ok', balance: 100 } })).kind).toBe('balance'); // порог включающий
});
test.each(['no_card', 'no_client'])('%s → welcome', (status) => {
  expect(chooseBonusLine(base({ card: { status } }))).toEqual({ kind: 'welcome', text: 'При регистрации дарим 500 баллов.' });
});
test('unavailable → ничего', () => {
  expect(chooseBonusLine(base({ card: { status: 'unavailable', reason: 'x' } }))).toBe(null);
});
test('пустой шаблон ветки выключает только её', () => {
  expect(chooseBonusLine(base({ settings: settings({ followupBonusText: null }) }))).toBe(null);
  expect(chooseBonusLine(base({ card: { status: 'no_card' }, settings: settings({ followupBonusText: null }) })).kind).toBe('welcome');
  expect(chooseBonusLine(base({ card: { status: 'no_card' }, settings: settings({ followupWelcomeText: '' }) }))).toBe(null);
});
test('неуместная ситуация, уже звучало, недавно слали → ничего', () => {
  expect(chooseBonusLine(base({ situation: { kind: 'clarify', bonusOk: false } }))).toBe(null);
  expect(chooseBonusLine(base({ alreadyMentioned: true }))).toBe(null);
  expect(chooseBonusLine(base({ recentlySent: true }))).toBe(null);
});
test('модель сама упомянула бонусы/лояльность → не дублируем', () => {
  expect(chooseBonusLine(base({ nudgeText: 'Напомню, у вас есть бонусы — записать?' }))).toBe(null);
  expect(chooseBonusLine(base({ nudgeText: 'Про программу лояльности расскажу при визите.' }))).toBe(null);
});
test('render применяется ПОСЛЕ подстановки {balance}', () => {
  const render = (t) => t.replace('{first_name}', 'Мария');
  const out = chooseBonusLine(base({ settings: settings({ followupBonusText: '{first_name}, на карте {balance} б.' }), render }));
  expect(out.text).toBe('Мария, на карте 3 024 б.');
});
test('BONUS_MENTION_RE ловит словоформы', () => {
  expect(BONUS_MENTION_RE.test('бонусами')).toBe(true);
  expect(BONUS_MENTION_RE.test('программе лояльности')).toBe(true);
  expect(BONUS_MENTION_RE.test('баланс чека')).toBe(false);
});
