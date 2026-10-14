'use strict';
const { renderTemplate, buildRenderCtx } = require('./services/notifications/render');

describe('renderTemplate', () => {
  const ctx = {
    name: 'Иванова Анна Петровна', date: '20.10.2026', time: '13:30', end_time: '14:30',
    services: 'Пилинг', staff: 'Татьяна', salon: 'PERI CLINIC',
    record_link: 'https://yc.gl/c/x', rating_links: 'Яндекс https://ya.cc/1',
  };

  test('все плейсхолдеры', () => {
    expect(renderTemplate(
      '{first_name}, {date} {time}–{end_time}, {services}, {staff}, {salon}, {record_link}, {rating_links}, {name}',
      ctx
    )).toBe('Анна, 20.10.2026 13:30–14:30, Пилинг, Татьяна, PERI CLINIC, https://yc.gl/c/x, Яндекс https://ya.cc/1, Иванова Анна Петровна');
  });

  test('нет имени → осиротевшая запятая убирается', () => {
    expect(renderTemplate('{first_name}, добрый день!', { name: '79200255591' })).toBe('Добрый день!');
  });

  // Поведение v1 (services/notifications.js) переехало без изменений.
  test('{first_name} — личное имя, а не первое слово ФИО', () => {
    expect(renderTemplate('{first_name}', { name: 'Вихарева Мария Андреевна' })).toBe('Мария');
  });

  test('пустой текст и пустой контекст не ломают шаблон', () => {
    expect(renderTemplate('', ctx)).toBe('');
    expect(renderTemplate(null, ctx)).toBe('');
    expect(renderTemplate('Привет, {first_name}!', {})).toBe('Привет, !');
    expect(renderTemplate('Привет, {date}{end_time}{record_link}{rating_links}!')).toBe('Привет, !');
  });

  // String.replace трактует в СТРОКЕ-заменителе $&, $1, $$, $`, $' как спецпоследовательности
  // («$&» вставило бы сам плейсхолдер, «$$» схлопнулось бы в «$»), а значения приходят
  // извне: имя из карточки, название услуги из YClients, ссылки. Подставлять надо дословно.
  test('значения с $&, $1, $$, $`, $\' подставляются дословно', () => {
    const tricky = {
      name: 'Иванова $$ Анна Петровна', date: '20.10.2026', time: '13:30', end_time: '14:30',
      services: 'Пилинг $$ и маска $1', staff: "Т$'ана $`", salon: 'PERI $& CLINIC',
      record_link: 'https://x/?a=$1&b=$&', rating_links: 'Яндекс https://ya.cc/$$1',
    };
    const out = renderTemplate('{name}|{services}|{staff}|{salon}|{record_link}|{rating_links}', tricky);
    expect(out).toBe([tricky.name, tricky.services, tricky.staff, tricky.salon, tricky.record_link, tricky.rating_links].join('|'));
    // отдельно: «$&» в ссылке не должно вернуть в текст сам плейсхолдер
    expect(renderTemplate('{record_link}', { record_link: 'https://x/?a=$1&b=$&' })).toBe('https://x/?a=$1&b=$&');
  });
});

describe('buildRenderCtx', () => {
  test('собирает контекст из снимка', () => {
    const snap = {
      visitAt: Date.parse('2026-10-20T13:30:00+03:00'), seanceLength: 3600,
      services: [{ id: 1, title: 'Пилинг' }, { id: 2, title: 'Маска' }],
      staffName: 'Татьяна', clientName: 'Анна', shortLink: 'https://yc.gl/c/x',
    };
    const c = buildRenderCtx(snap, { name: 'PERI CLINIC' }, null, {});
    expect(c).toMatchObject({
      date: '20.10.2026', time: '13:30', end_time: '14:30', services: 'Пилинг, Маска',
      staff: 'Татьяна', salon: 'PERI CLINIC', record_link: 'https://yc.gl/c/x', name: 'Анна',
    });
  });

  test('имя из карточки клиента главнее имени в вебхуке', () => {
    const c = buildRenderCtx({ visitAt: null, services: [], clientName: 'Аня' }, { name: 'S' }, { name: 'Иванова Анна' }, {});
    expect(c.name).toBe('Иванова Анна');
  });

  test('extra: словарь имён и ссылки для оценки доезжают до контекста', () => {
    const dict = new Set(['анна']);
    const c = buildRenderCtx({ visitAt: null, services: [] }, null, null, { nameDictionary: dict, rating_links: 'Яндекс https://ya.cc/1' });
    expect(c.nameDictionary).toBe(dict);
    expect(c.rating_links).toBe('Яндекс https://ya.cc/1');
    expect(c).toMatchObject({ name: '', date: '', time: '', end_time: '', services: '', staff: '', salon: '', record_link: '' });
  });
});

// Фасад services/notifications.js обязан остаться совместимым: им пользуются
// «Забота», напоминания, followup Милы, роуты и server.js (Task 4 плана).
describe('фасад services/notifications.js', () => {
  const facade = require('./services/notifications');
  const rules = require('./services/notifications/rules');
  const render = require('./services/notifications/render');

  test('все прежние экспорты на месте', () => {
    for (const name of [
      'handleRecordCreated', 'startNotificationWorker', 'ALLOWED_CHANNELS', 'evaluateRule',
      'renderTemplate', 'resolveRouting', 'splitVisitDatetime', 'getServiceCategoryMap',
      'lastIncomingChannel', '_lastIncomingChannel',
    ]) {
      expect(facade[name]).toBeDefined();
    }
  });

  test('значения — те же объекты, что в модулях (а не копии)', () => {
    expect(facade.renderTemplate).toBe(render.renderTemplate);
    expect(facade.evaluateRule).toBe(rules.evaluateRule);
    expect(facade.resolveRouting).toBe(rules.resolveRouting);
    expect(facade.splitVisitDatetime).toBe(rules.splitVisitDatetime);
    expect(facade.getServiceCategoryMap).toBe(rules.getServiceCategoryMap);
    expect(facade.lastIncomingChannel).toBe(rules.lastIncomingChannel);
    expect(facade._lastIncomingChannel).toBe(rules.lastIncomingChannel);
    expect(facade.ALLOWED_CHANNELS).toBe(rules.ALLOWED_CHANNELS);
  });
});
