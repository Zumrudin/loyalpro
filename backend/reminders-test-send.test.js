'use strict';
// Тестовая отправка напоминания на свой номер: чистая часть (выбор якорного
// визита + сборка строки очереди). БД и сеть не трогаются.
const { pickAnchorVisit, buildTestRow, TEST_LEAD_MS } = require('./services/reminders/test-send');

const RULE = { id: 5, salon_id: 1, title: 'Эпиляция раз в месяц', delay_days: 30 };
const CLIENT = { id: 42, yclients_client_id: 777, name: 'Мария' };
const NOW = Date.parse('2026-08-08T09:00:00.000Z');

describe('pickAnchorVisit', () => {
  const rec = (over) => ({
    id: 1, datetime: '2026-07-08 11:00:00', attendance: 1, deleted: false,
    staff: { name: 'Юлия' }, services: [{ id: 101, title: 'Лазерная эпиляция' }], ...over,
  });

  test('берёт САМЫЙ СВЕЖИЙ состоявшийся визит', () => {
    const got = pickAnchorVisit([
      rec({ id: 1, datetime: '2026-06-01 11:00:00' }),
      rec({ id: 2, datetime: '2026-07-20 15:30:00' }),
      rec({ id: 3, datetime: '2026-07-08 11:00:00' }),
    ], NOW);
    expect(got.recordId).toBe(2);
    expect(got.staffName).toBe('Юлия');
    expect(got.services).toEqual([{ id: 101, title: 'Лазерная эпиляция' }]);
  });

  // Те же три признака, что у visitReallyHappened: неявка, удалённая запись и
  // ещё не состоявшийся визит якорем быть не могут — иначе {дней} и {услуга}
  // отрендерятся по визиту, которого не было.
  test('неявку, удалённую запись и будущий визит якорем не берёт', () => {
    expect(pickAnchorVisit([rec({ attendance: -1 })], NOW)).toBeNull();
    expect(pickAnchorVisit([rec({ deleted: true })], NOW)).toBeNull();
    expect(pickAnchorVisit([rec({ datetime: '2026-09-01 11:00:00' })], NOW)).toBeNull();
    expect(pickAnchorVisit([], NOW)).toBeNull();
  });

  test('мастер приходит и полем staff_name, и объектом staff', () => {
    expect(pickAnchorVisit([rec({ staff: null, staff_name: 'Татьяна' })], NOW).staffName).toBe('Татьяна');
  });

  // В бою якорь по определению прошёл evaluateRule (его планирует enroll.js).
  // Тест без этого фильтра брал ЛЮБОЙ последний визит и давал модели
  // противоречивое задание («напоминание про эпиляцию, последний визит: филлер»),
  // на котором она законно отказывалась писать — инцидент 08.08.2026.
  describe('условия правила', () => {
    const CONDITIONS = { logic: 'and', items: [{ type: 'service', ids: [101] }] };

    test('берёт свежий визит ПОД УСЛОВИЯ, а не просто последний', () => {
      const got = pickAnchorVisit([
        rec({ id: 1, datetime: '2026-07-01 11:00:00' }),
        rec({ id: 2, datetime: '2026-07-31 15:25:00', services: [{ id: 999, title: 'Stylage M Lidocaine' }] }),
      ], NOW, { conditions: CONDITIONS });
      expect(got.recordId).toBe(1);
    });

    test('подходящих визитов нет → null (откат на «любой визит» запрещён)', () => {
      const got = pickAnchorVisit([
        rec({ id: 2, services: [{ id: 999, title: 'Stylage M Lidocaine' }] }),
      ], NOW, { conditions: CONDITIONS });
      expect(got).toBeNull();
    });

    test('условие по категории считается через карту категорий', () => {
      const byCat = { logic: 'and', items: [{ type: 'category', ids: [9] }] };
      const catMap = new Map([['101', 9]]);
      expect(pickAnchorVisit([rec()], NOW, { conditions: byCat, catMap }).recordId).toBe(1);
      expect(pickAnchorVisit([rec()], NOW, { conditions: byCat, catMap: new Map() })).toBeNull();
    });

    test('без условий фильтр не применяется (совместимость вызова)', () => {
      expect(pickAnchorVisit([rec()], NOW).recordId).toBe(1);
    });
  });
});

describe('buildTestRow', () => {
  const anchor = {
    recordId: 900, visitAt: new Date('2026-07-08T11:00:00.000Z'),
    staffName: 'Юлия', services: [{ id: 101, title: 'Лазерная эпиляция' }],
  };

  // ГЛАВНОЕ свойство тестовой строки: боевой тик арендует только строки с
  // scheduled_at <= NOW(), поэтому тестовая ставится в БУДУЩЕЕ — забрать её
  // может только адресная аренда по id (processTestRow). Иначе между вставкой
  // и запуском теста строку перехватил бы боевой воркер со СВОИМИ deps:
  // реальным начислением бонусов и реальным анти-повтором.
  test('строка ставится в будущее и помечена source=test', () => {
    const row = buildTestRow({ rule: RULE, client: CLIENT, phone: '79200255591', anchor, nowMs: NOW });
    expect(new Date(row.scheduled_at).getTime()).toBe(NOW + TEST_LEAD_MS);
    expect(TEST_LEAD_MS).toBeGreaterThan(0);
    expect(row.source).toBe('test');
  });

  // UNIQUE (rule_id, anchor_record_id): реальный id визита в тестовой строке
  // столкнулся бы с уже запланированной боевой строкой того же визита (INSERT
  // упал бы) и испортил бы атрибуцию. NULL в UNIQUE не конфликтует ни с чем.
  test('якорный record_id не занимает боевой ключ', () => {
    const row = buildTestRow({ rule: RULE, client: CLIENT, phone: '79200255591', anchor, nowMs: NOW });
    expect(row.anchor_record_id).toBeNull();
    expect(row.anchor_visit_at).toEqual(anchor.visitAt);
    expect(row.anchor_staff_name).toBe('Юлия');
    expect(row.anchor_services).toEqual(anchor.services);
    expect(row.client_id).toBe(42);
    expect(row.yclients_client_id).toBe(777);
    expect(row.rule_title).toBe('Эпиляция раз в месяц');
  });

  // Клиента без визитов тоже надо уметь протестировать: {дней} должен
  // отрендериться ровно тем числом, которое даёт правило.
  test('без якорного визита дата берётся из задержки правила', () => {
    const row = buildTestRow({ rule: RULE, client: CLIENT, phone: '79200255591', anchor: null, nowMs: NOW });
    expect(new Date(row.anchor_visit_at).getTime()).toBe(NOW - 30 * 86400000);
    expect(row.anchor_staff_name).toBeNull();
    expect(row.anchor_services).toEqual([]);
  });

  // Без yclients_client_id applyBonus детерминированно возвращает no_bonus:
  // тест показал бы «бонусы недоступны» там, где в бою они начислились бы.
  // Карточка в clients есть не всегда (или без этого поля), а id клиента YClients
  // резолвится и по истории записей — он и должен побеждать пустое поле карточки.
  test('yclients_client_id берётся из резолвера, если в карточке его нет', () => {
    const row = buildTestRow({
      rule: RULE, client: { id: 42, yclients_client_id: null }, phone: '79200255591',
      anchor: null, ycClientId: 134014107, nowMs: NOW,
    });
    expect(row.yclients_client_id).toBe(134014107);
    expect(row.client_id).toBe(42);
  });

  test('без карточки клиента строка всё равно собирается', () => {
    const row = buildTestRow({ rule: RULE, client: null, phone: '79200255591', anchor: null, nowMs: NOW });
    expect(row.client_id).toBeNull();
    expect(row.yclients_client_id).toBeNull();
    expect(row.phone).toBe('79200255591');
  });
});
