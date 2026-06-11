'use strict';
const { monthBounds, elapsedDaysInMonth, forecastMonthEnd } = require('./services/staff-goals');

describe('monthBounds', () => {
  test('обычный месяц', () => {
    expect(monthBounds('2026-06')).toEqual({ from: '2026-06-01', to: '2026-06-30', daysTotal: 30 });
  });
  test('февраль невисокосный', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28', daysTotal: 28 });
  });
  test('февраль високосный', () => {
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29', daysTotal: 29 });
  });
  test('декабрь — граница года', () => {
    expect(monthBounds('2025-12')).toEqual({ from: '2025-12-01', to: '2025-12-31', daysTotal: 31 });
  });
});

describe('elapsedDaysInMonth', () => {
  test('середина месяца — включая сегодня', () => {
    expect(elapsedDaysInMonth('2026-06', '2026-06-11')).toBe(11);
  });
  test('месяц ещё не начался → 0', () => {
    expect(elapsedDaysInMonth('2026-07', '2026-06-11')).toBe(0);
  });
  test('месяц уже закончился → daysTotal', () => {
    expect(elapsedDaysInMonth('2026-05', '2026-06-11')).toBe(31);
  });
  test('последний день месяца → daysTotal', () => {
    expect(elapsedDaysInMonth('2026-06', '2026-06-30')).toBe(30);
  });
  test('первый день месяца → 1', () => {
    expect(elapsedDaysInMonth('2026-06', '2026-06-01')).toBe(1);
  });
});

describe('forecastMonthEnd', () => {
  test('по рабочим дням: 100к за 10 из 20 раб. дней → 200к', () => {
    expect(forecastMonthEnd(100000, 10, 20, 11, 30)).toBe(200000);
  });
  test('фолбэк на календарь, если расписания нет', () => {
    expect(forecastMonthEnd(100000, 0, 0, 10, 30)).toBe(300000);
  });
  test('месяц закончился (worked=planned) → прогноз = факт', () => {
    expect(forecastMonthEnd(150000, 20, 20, 30, 30)).toBe(150000);
  });
  test('нет данных вовсе → 0', () => {
    expect(forecastMonthEnd(0, 0, 0, 0, 30)).toBe(0);
  });
  test('факт 0 при прошедших днях → 0', () => {
    expect(forecastMonthEnd(0, 5, 20, 11, 30)).toBe(0);
  });
  test('округление до целого рубля', () => {
    expect(forecastMonthEnd(1000, 3, 20, 11, 30)).toBe(6667);
  });
});
