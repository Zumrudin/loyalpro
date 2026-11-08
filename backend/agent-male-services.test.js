'use strict';
// Мужской прайс клиники — ОТДЕЛЬНЫЕ услуги с приставкой «Муж.» в названии
// («Муж. Комплекс 5в1 …» = 24 700 ₽ против 19 000 ₽ у женской «5в1Лоб+брови…»).
// Инцидент 2026-08-01: пациенту-мужчине названа женская цена.
const { isMaleService, hasMalePriceList } = require('./services/agent/male-services');

describe('isMaleService — приставка «Муж.» в начале названия', () => {
  test('услуги мужского прайса из каталога PERI', () => {
    expect(isMaleService('Муж. Комплекс 5в1 лоб+межбровье+глаза+нос')).toBe(true);
    expect(isMaleService('Муж. Уголки глаз "Гусиные лапки"')).toBe(true);
    expect(isMaleService('  муж. подбородок')).toBe(true);
    expect(isMaleService('Мужская ботулинотерапия')).toBe(true);
  });
  test('женские и общие услуги — false', () => {
    expect(isMaleService('Ботулинотерапия Кончик носа')).toBe(false);
    expect(isMaleService('5в1Лоб+брови+межбровье+глаза+нос')).toBe(false);
    // Приставка — именно в НАЧАЛЕ: упоминание внутри названия не признак прайса.
    expect(isMaleService('Комплекс для мужчин и женщин')).toBe(false);
    expect(isMaleService(null)).toBe(false);
    expect(isMaleService(undefined)).toBe(false);
  });
});

describe('hasMalePriceList — в направлении услуги есть мужской прайс', () => {
  const path = ['Инъекционная косметология', 'Ботулинотерапия'];
  const female = { yc_id: 15394018, title: '5в1Лоб+брови+межбровье+глаза+нос', category_path: path };
  const male = { yc_id: 17987378, title: 'Муж. Комплекс 5в1 лоб+межбровье+глаза+нос', category_path: path };
  const other = { yc_id: 9, title: 'Комбинированная чистка лица', category_path: ['Эстетическая косметология', 'Чистки'] };

  test('женская услуга + мужской близнец в том же направлении → true', () => {
    expect(hasMalePriceList([female, male, other], female)).toBe(true);
  });
  test('сама мужская услуга → false (подсказка ей не нужна)', () => {
    expect(hasMalePriceList([female, male], male)).toBe(false);
  });
  test('в направлении мужских услуг нет → false', () => {
    expect(hasMalePriceList([female, male, other], other)).toBe(false);
  });
  test('направление сравнивается ПОЛНЫМ путём, а не первым уровнем', () => {
    // Обе — «Инъекционная косметология», но подкатегории разные: мужской прайс
    // ботулинотерапии не делает мужской биоревитализацию.
    const bio = { yc_id: 10, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'] };
    expect(hasMalePriceList([bio, male], bio)).toBe(false);
  });
  test('услуга без направления → false (сравнивать не с чем, не гадаем)', () => {
    const noPath = { yc_id: 11, title: 'Услуга', category_path: [] };
    expect(hasMalePriceList([noPath, { ...male, category_path: [] }], noPath)).toBe(false);
  });
});

// Решение владельца 08.11.2026: отдельных услуг «Муж.» у лазерной эпиляции нет
// (дубли удалены в YClients), мужчине цена = стандартная +30 %. Считает КОД —
// арифметику модель делает хуже кода (тот же принцип, что у диапазонов цен).
describe('мужская цена лазерной эпиляции = стандартная +30 %', () => {
  const { hasMaleMarkup, isIntimateZone, maleMarkupApplies, maleMarkupPrice } = require('./services/agent/male-services');
  const laser = (title) => ({ yc_id: 1, title, category_path: ['Лазерная эпиляция'] });

  test('maleMarkupPrice: ровно ×1,3 без дополнительного округления (как прежний мужской прайс клиники)', () => {
    expect(maleMarkupPrice(3500)).toBe(4550);
    expect(maleMarkupPrice(1100)).toBe(1430);   // 1100×1,3 в float = 1430.0000000000002
    expect(maleMarkupPrice(2500)).toBe(3250);
    expect(maleMarkupPrice(19000)).toBe(24700);
  });

  test('hasMaleMarkup: только направление «Лазерная эпиляция», в любом месте пути', () => {
    expect(hasMaleMarkup(laser('Спина полностью'))).toBe(true);
    expect(hasMaleMarkup({ title: 'Спина', category_path: ['Аппаратная косметология', 'Лазерная эпиляция'] })).toBe(true);
    expect(hasMaleMarkup({ title: 'Комбинированная чистка лица', category_path: ['Эстетическая косметология'] })).toBe(false);
    expect(hasMaleMarkup({ title: 'Ботулинотерапия Лоб', category_path: ['Инъекционная косметология'] })).toBe(false);
    expect(hasMaleMarkup({ title: 'Спина', category_path: [] })).toBe(false);   // пути нет — не гадаем
    expect(hasMaleMarkup(null)).toBe(false);
  });

  test('hasMaleMarkup: услуга «Муж.» уже мужская — наценка к ней не применяется', () => {
    expect(hasMaleMarkup(laser('Муж. Ягодицы'))).toBe(false);
  });

  test('isIntimateZone: любые виды бикини, межъягодичная зона и комплексы с ними', () => {
    for (const t of ['Классическое бикини', 'Тотальное бикини', 'Межъягодичная зона', 'Межьягодичная зона',
      '№4 Бикини тотальное + подмышки', '№6: руки полностью + ноги полностью + подмышки + глубокое бикини + поясница',
      '№7: все зоны на лице и теле']) expect(isIntimateZone(t)).toBe(true);
    for (const t of ['Спина полностью', 'Ягодицы', 'Ореолы', 'Малая зона (верхняя губа\\подбородок\\межбровье)',
      'Подмышки 1', 'Ноги полностью']) expect(isIntimateZone(t)).toBe(false);
  });

  test('maleMarkupApplies: лазерная эпиляция вне интимных зон', () => {
    expect(maleMarkupApplies(laser('Спина полностью'))).toBe(true);
    expect(maleMarkupApplies(laser('Ягодицы'))).toBe(true);
    expect(maleMarkupApplies(laser('Тотальное бикини'))).toBe(false);
    expect(maleMarkupApplies({ title: 'Чистка', category_path: ['Уходы'] })).toBe(false);
  });
});
