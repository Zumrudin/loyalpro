'use strict';

const { buildSystemPrompt } = require('./services/agent/system-prompt');

describe('buildSystemPrompt', () => {
  test('подставляет имя салона и часы', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', workingHours: '09:00–21:00', today: '2026-07-18' });
    expect(p).toContain('PERI CLINIC');
    expect(p).toContain('09:00–21:00');
    expect(p).toContain('2026-07-18');
  });

  test('запрещает выдумывать факты и требует инструменты', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/НИКОГДА не выдумыв/i);
    expect(p).toContain('search_knowledge_base');
  });

  test('требует согласие перед create_booking', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('create_booking');
    expect(p).toMatch(/подтвер|соглас/i);
  });

  test('описывает правило эскалации', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('escalate_to_operator');
  });

  test('Сценарий 3 — двухшаговая де-эскалация: спасти диалог, затем явный перевод', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('ШАГ А');
    expect(p).toContain('ШАГ Б');
    expect(p).toMatch(/извин/i);             // сначала извиниться
    expect(p).toMatch(/НИКОГДА не замолк/i); // запрет уходить в тишину
  });

  test('по умолчанию НЕТ блока «диалог вернул администратор»', () => {
    const p = buildSystemPrompt({});
    expect(p).not.toMatch(/ВЕРНУЛ ТЕБЕ АДМИНИСТРАТОР/i);
  });

  test('resumedFromEscalation → блок против ре-эскалации на разрешённом конфликте', () => {
    const p = buildSystemPrompt({ resumedFromEscalation: true });
    expect(p).toMatch(/ВЕРНУЛ ТЕБЕ АДМИНИСТРАТОР/i);
    expect(p).toMatch(/РАЗРЕШ[ЁЕ]ННЫ/i);           // конфликт считается разрешённым
    expect(p).toMatch(/НЕ вызывай escalate_to_operator заново/i);
  });

  test('передаёт текущее московское время (не предлагать прошедшее)', () => {
    const p = buildSystemPrompt({ now: '14:35' });
    expect(p).toContain('14:35');
    expect(p).toMatch(/не предлагай окно, которое уже прошло/i);
  });

  test('правило: цена зависит от мастера — сверять и называть по мастерам', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/ЦЕНА ЗАВИСИТ ОТ МАСТЕРА/i);
    expect(p).toMatch(/price_min|цена каждого|каждого мастера/i);
  });

  test('график конкретного мастера — только через get_available_dates, не часы клиники', () => {
    const p = buildSystemPrompt({ workingHours: '10:00–22:00' });
    expect(p).toMatch(/ГРАФИК КОНКРЕТНОГО МАСТЕРА/i);
    expect(p).toContain('get_available_dates');
    expect(p).toMatch(/часы клиники ≠ график мастера/i);
    // Часы клиники явно помечены как НЕ график мастера
    expect(p).toMatch(/Часы работы КЛИНИКИ/i);
  });

  test('стоп-темы: блок с приоритетом над каталогом и запретом обходных путей', () => {
    const p = buildSystemPrompt({ stopTopics: ['Новообразования кожи: родинки, папилломы, невусы'] });
    expect(p).toMatch(/СТОП-ТЕМЫ/);
    expect(p).toContain('Новообразования кожи: родинки, папилломы, невусы');
    expect(p).toMatch(/ПРИОРИТЕТ ВЫШЕ КАТАЛОГА/i);
    expect(p).toMatch(/НЕ предлагай взамен НИКАКУЮ/i);
    expect(p).toMatch(/Не оформляй запись по этой теме/i);
    expect(p).toMatch(/не спорь/i);
  });

  test('без стоп-тем блок не рендерится', () => {
    expect(buildSystemPrompt({})).not.toMatch(/СТОП-ТЕМЫ/);
    expect(buildSystemPrompt({ stopTopics: [] })).not.toMatch(/СТОП-ТЕМЫ/);
    expect(buildSystemPrompt({ stopTopics: ['  ', ''] })).not.toMatch(/СТОП-ТЕМЫ/);
  });

  test('нельзя выдумывать услугу, которой нет в каталоге; не спорить', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/ТОЛЬКО ПО КАТАЛОГУ/i);
    expect(p).toMatch(/НЕ придумывай|не выдумыв/i);
    expect(p).toMatch(/list_services/);
    expect(p).toMatch(/НЕ спорь|не настаивай/i);
  });

  test('запрет раскрывать внутреннюю кухню (база знаний, каталог, инструмент)', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/не раскрывай пациенту внутреннюю кухню/i);
    expect(p).toMatch(/база знаний|нет статьи/i);
  });

  test('консультация в подарок при процедуре в тот же день — деликатно, один раз', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/КОНСУЛЬТАЦИЯ В ПОДАРОК/i);
    expect(p).toMatch(/в подарок|бесплатно/i);
    expect(p).toMatch(/ОДИН раз|деликатно|не навязыв/i);
  });

  test('образец приветствия и запрет тавтологии', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC' });
    expect(p).toContain('виртуальный администратор PERI CLINIC');
    expect(p).toMatch(/тавтолог/i);
  });

  test('без опций не падает и даёт дефолтное имя', () => {
    const p = buildSystemPrompt();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(50);
  });
});

// Экономия tool-итераций: каждый лишний вызов приближает ход к лимиту и немому ответу.
describe('экономия вызовов инструментов', () => {
  test('запрещает повторный вызов инструмента с теми же аргументами', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/повторно.*с теми же аргументами|не вызывай один и тот же инструмент/i);
  });

  test('объясняет, что list_staff не нужен ради мастеров и цен конкретной услуги', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/list_staff/);
    expect(p).toMatch(/не вызывай list_staff/i);
  });

  test('требует отвечать, когда данных уже достаточно', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/данных уже достаточно/i);
  });
});
