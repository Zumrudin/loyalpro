'use strict';

const { SALES_MODULES, PRICE_FOLLOWTHROUGH, renderSalesTail } = require('./services/agent/sales-modules');
const { SCENARIOS } = require('./services/agent/prompt-scenarios');

describe('sales-modules', () => {
  test('есть модули ровно для objection и undecided', () => {
    expect(Object.keys(SALES_MODULES).sort()).toEqual([SCENARIOS.OBJECTION, SCENARIOS.UNDECIDED].sort());
  });

  // allowedTimes reply-guard засевается всем текстом после «ТЕКУЩИЙ КОНТЕКСТ:»,
  // а хвостовой блок v1 стоит именно там: время в примере стало бы «подтверждённым».
  test('в текстах модулей нет времени ЧЧ:ММ и цен', () => {
    const all = [...Object.values(SALES_MODULES), PRICE_FOLLOWTHROUGH].join('\n');
    expect(all).not.toMatch(/\d{1,2}:\d{2}/);
    expect(all).not.toMatch(/\d\s?₽/);
  });

  test('модуль сомнения ставит запись выше разбора и закрывает «напишу сама»', () => {
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/запис/i);
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/напишу сам/i);
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/не спорь/i);
  });

  test('модуль нерешительности оставляет подбор процедуры врачу', () => {
    expect(SALES_MODULES[SCENARIOS.UNDECIDED]).toMatch(/врач/i);
    expect(SALES_MODULES[SCENARIOS.UNDECIDED]).toMatch(/один вопрос/i);
  });

  test('renderSalesTail: пусто без сценариев продаж, иначе заголовок + модули', () => {
    expect(renderSalesTail([SCENARIOS.BOOKING])).toEqual([]);
    const lines = renderSalesTail([SCENARIOS.BOOKING, SCENARIOS.OBJECTION]);
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ (КОНСУЛЬТАТИВНАЯ ПРОДАЖА):');
    expect(lines.join('\n')).toContain(SALES_MODULES[SCENARIOS.OBJECTION]);
    expect(renderSalesTail(null)).toEqual([]);
  });
});
