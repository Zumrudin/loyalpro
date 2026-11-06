'use strict';
// Трактовка статуса доставки: у Chatpush и нашего шлюза один контракт ответа, но РАЗНЫЕ таблицы
// кодов. Фикстуры Chatpush — живые ответы GET /api/v1/delivery/:id по рассылке №3 (06.11.2026).
const ds = require('./services/messaging/delivery-status');

const st = (status_id, description, extra = {}) => ({ status: { status_id, description }, ...extra });
const kind = (delivery, deliveryId) => ds.classifyDelivery(delivery, { deliveryId }).kind;

describe('isGatewayDeliveryId', () => {
  test('шлюз — g<число>, Chatpush — число', () => {
    expect(ds.isGatewayDeliveryId('g123')).toBe(true);
    expect(ds.isGatewayDeliveryId('408628094')).toBe(false);
    expect(ds.isGatewayDeliveryId(408628094)).toBe(false);
    expect(ds.isGatewayDeliveryId('g')).toBe(false);
    expect(ds.isGatewayDeliveryId('xg12')).toBe(false);
    expect(ds.isGatewayDeliveryId(null)).toBe(false);
    expect(ds.isGatewayDeliveryId(undefined)).toBe(false);
  });
});

describe('Chatpush (id числом)', () => {
  const id = '408631458';
  test('2 «Доставлено» и 16 «Прочитано» — доставлено', () => {
    expect(kind(st(2, 'Доставлено'), id)).toBe('delivered');
    expect(kind(st(16, 'Прочитано'), id)).toBe('delivered');
  });
  test('6 «Принято» и 1 «Передано оператору» — в пути', () => {
    expect(kind(st(6, 'Принято'), id)).toBe('pending');
    expect(kind(st(1, 'Передано оператору'), id)).toBe('pending');
  });
  test('55/58 — адресата нет в мессенджере', () => {
    expect(kind(st(55, 'Клиент не зарегистрирован в MAX'), id)).toBe('not_registered');
    expect(kind(st(58, 'Пользователь не найден в Telegram'), id)).toBe('not_registered');
  });
  test('неизвестный код с текстом «не зарегистрирован/не найден» — тоже нет в мессенджере', () => {
    expect(kind(st(57, 'Клиент не зарегистрирован в WhatsApp'), id)).toBe('not_registered');
    expect(kind(st(99, 'Пользователь  НЕ НАЙДЕН'), id)).toBe('not_registered');
  });
  test('5 «Невозможно доставить» — undeliverable как есть (доказанность решает вызывающий)', () => {
    expect(kind(st(5, 'Невозможно доставить'), id)).toBe('undeliverable');
  });
  test('коды шлюза 3/4 у Chatpush не значат «доставлено» — в пути', () => {
    expect(kind(st(3, 'Что-то своё'), id)).toBe('pending');
    expect(kind(st(4), id)).toBe('pending');
  });
  test('код строкой разбирается', () => {
    expect(kind(st('16', 'Прочитано'), id)).toBe('delivered');
  });
});

describe('шлюз (id g<n>)', () => {
  const id = 'g42';
  test('2 «Отправлено», 3 «Доставлено», 4 «Прочитано» — доставлено', () => {
    expect(kind(st(2, 'Отправлено'), id)).toBe('delivered');
    expect(kind(st(3, 'Доставлено'), id)).toBe('delivered');
    expect(kind(st(4, 'Прочитано'), id)).toBe('delivered');
  });
  test('1 «Принято» — в пути, 5 — undeliverable', () => {
    expect(kind(st(1, 'Принято'), id)).toBe('pending');
    expect(kind(st(5, 'Невозможно доставить', { error: 'шлюз перезапущен, исход неизвестен' }), id)).toBe('undeliverable');
  });
  test('коды Chatpush 16/55 у шлюза ничего не значат — в пути', () => {
    expect(kind(st(16, 'Прочитано'), id)).toBe('pending');
    expect(kind(st(55), id)).toBe('pending');
  });
});

describe('нет статуса', () => {
  test('null, пустой объект, без status — unknown', () => {
    expect(kind(null, '1')).toBe('unknown');
    expect(kind(undefined, 'g1')).toBe('unknown');
    expect(kind({}, '1')).toBe('unknown');
  });
  test('возвращает код и описание', () => {
    expect(ds.classifyDelivery(st(58, 'Пользователь не найден в Telegram'), { deliveryId: '1' }))
      .toEqual({ kind: 'not_registered', statusId: 58, description: 'Пользователь не найден в Telegram' });
    expect(ds.classifyDelivery(null)).toEqual({ kind: 'unknown', statusId: null, description: '' });
  });
});
