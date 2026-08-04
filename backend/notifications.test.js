'use strict';
const {
  evaluateRule, renderTemplate, resolveRouting, splitVisitDatetime,
} = require('./services/notifications');

describe('evaluateRule', () => {
  const ctx = { staffId: 3356928, serviceIds: [9536765, 15393808], categoryIds: ['111', '222'] };

  test('пустые условия → любая запись подходит', () => {
    expect(evaluateRule({ logic: 'and', items: [] }, ctx)).toBe(true);
    expect(evaluateRule(null, ctx)).toBe(true);
    expect(evaluateRule({}, ctx)).toBe(true);
  });

  test('staff: совпадение по id (числа и строки эквивалентны)', () => {
    expect(evaluateRule({ items: [{ type: 'staff', ids: ['3356928'] }] }, ctx)).toBe(true);
    expect(evaluateRule({ items: [{ type: 'staff', ids: [999] }] }, ctx)).toBe(false);
  });

  test('service: ИЛИ внутри набора значений', () => {
    expect(evaluateRule({ items: [{ type: 'service', ids: [1, 9536765] }] }, ctx)).toBe(true);
    expect(evaluateRule({ items: [{ type: 'service', ids: [1, 2] }] }, ctx)).toBe(false);
  });

  test('category: через маппинг serviceId→categoryId', () => {
    expect(evaluateRule({ items: [{ type: 'category', ids: [222] }] }, ctx)).toBe(true);
    expect(evaluateRule({ items: [{ type: 'category', ids: [333] }] }, ctx)).toBe(false);
  });

  test('логика И: все условия должны совпасть', () => {
    const items = [
      { type: 'staff', ids: [3356928] },
      { type: 'service', ids: [123] },
    ];
    expect(evaluateRule({ logic: 'and', items }, ctx)).toBe(false);
  });

  test('логика ИЛИ: достаточно одного условия', () => {
    const items = [
      { type: 'staff', ids: [999] },
      { type: 'service', ids: [9536765] },
    ];
    expect(evaluateRule({ logic: 'or', items }, ctx)).toBe(true);
    expect(evaluateRule({ logic: 'or', items: [{ type: 'staff', ids: [999] }, { type: 'service', ids: [1] }] }, ctx)).toBe(false);
  });

  test('условие с пустым набором значений не ограничивает', () => {
    expect(evaluateRule({ logic: 'and', items: [{ type: 'staff', ids: [] }] }, ctx)).toBe(true);
  });

  test('неизвестный тип условия не пропускает запись', () => {
    expect(evaluateRule({ logic: 'and', items: [{ type: 'weird', ids: [1] }] }, ctx)).toBe(false);
  });

  test('запись без мастера не проходит staff-условие', () => {
    const noStaff = { ...ctx, staffId: null };
    expect(evaluateRule({ items: [{ type: 'staff', ids: [3356928] }] }, noStaff)).toBe(false);
  });
});

describe('renderTemplate', () => {
  const ctx = {
    name: 'Иванова Мария', date: '02.08.2026', time: '14:00',
    services: 'Чистка лица', staff: 'Богатырева Татьяна', salon: 'PERI',
  };

  test('все плейсхолдеры подставляются', () => {
    const out = renderTemplate('{first_name}, ждём вас {date} в {time} на «{services}» к {staff} ({salon}), {name}!', ctx);
    expect(out).toBe('Мария, ждём вас 02.08.2026 в 14:00 на «Чистка лица» к Богатырева Татьяна (PERI), Иванова Мария!');
  });

  // 77% карточек прода — «Фамилия Имя Отчество» одной строкой: первое слово
  // это ФАМИЛИЯ, и {first_name} слал пациенту «Вихарева, добрый вечер!».
  test('{first_name} — личное имя, а не первое слово ФИО', () => {
    expect(renderTemplate('{first_name}', { name: 'Вихарева Мария Андреевна' })).toBe('Мария');
    expect(renderTemplate('{first_name}', { name: 'Писковецкая Карина Александровна' })).toBe('Карина');
  });

  test('имя не распознано → обращение исчезает целиком, а не «, добрый день»', () => {
    expect(renderTemplate('{first_name}, добрый день!', { name: '79265303607' })).toBe('Добрый день!');
    expect(renderTemplate('{first_name}, добрый день!', {})).toBe('Добрый день!');
  });

  test('пустой контекст не ломает шаблон', () => {
    expect(renderTemplate('Привет, {first_name}!', {})).toBe('Привет, !');
  });

  test('эмодзи проходят как есть', () => {
    expect(renderTemplate('✨ {name} 💜', ctx)).toBe('✨ Иванова Мария 💜');
  });
});

describe('resolveRouting', () => {
  test('клиент писал → его канал первый, остальные каскадом', () => {
    expect(resolveRouting(['telegram', 'whatsapp'], true, 'whatsapp'))
      .toEqual(['whatsapp', 'telegram']);
  });

  test('последний канал уже первый → порядок не меняется', () => {
    expect(resolveRouting(['telegram', 'whatsapp'], true, 'telegram'))
      .toEqual(['telegram', 'whatsapp']);
  });

  test('клиент не писал → каскад правила как настроен', () => {
    expect(resolveRouting(['telegram', 'whatsapp'], true, null))
      .toEqual(['telegram', 'whatsapp']);
  });

  test('prefer_last_channel=false игнорирует последний канал', () => {
    expect(resolveRouting(['telegram', 'whatsapp'], false, 'whatsapp'))
      .toEqual(['telegram', 'whatsapp']);
  });

  test('последний канал не из списка правила → добавляется первым', () => {
    expect(resolveRouting(['whatsapp'], true, 'tdlib')).toEqual(['tdlib', 'whatsapp']);
  });

  test('мусорные каналы отбрасываются, пусто → дефолт telegram,whatsapp', () => {
    expect(resolveRouting(['sms', 'ватсап'], true, null)).toEqual(['telegram', 'whatsapp']);
    expect(resolveRouting(null, false, null)).toEqual(['telegram', 'whatsapp']);
  });
});

describe('splitVisitDatetime', () => {
  test('строка YClients → дата и время', () => {
    expect(splitVisitDatetime('2026-08-02 14:00:00')).toEqual({ date: '02.08.2026', time: '14:00' });
  });
  test('ISO с T тоже разбирается', () => {
    expect(splitVisitDatetime('2026-08-02T09:05:00')).toEqual({ date: '02.08.2026', time: '09:05' });
  });
  test('мусор → пустые строки', () => {
    expect(splitVisitDatetime(null)).toEqual({ date: '', time: '' });
    expect(splitVisitDatetime('завтра')).toEqual({ date: '', time: '' });
  });
});
