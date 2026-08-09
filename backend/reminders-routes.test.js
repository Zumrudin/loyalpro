'use strict';
// Валидация тела правила напоминаний (routes/reminders.js). Роутер прямых
// тестов не имеет (как и routes/care.js), но parseRuleBody — чистая функция
// без БД/сети, вынесенная наружу свойством модуля именно ради этого теста.
const { parseRuleBody, summarizeBackfillPlan, parseHistoryQuery } = require('./routes/reminders');

// Минимальное валидное тело — база для мутаций в отдельных тестах.
function validBody(overrides = {}) {
  return {
    title: 'Повтор через месяц',
    conditions: { logic: 'and', items: [{ type: 'category', ids: [1] }] },
    delayDays: 30,
    sendTime: '11:00',
    textMode: 'strict',
    text: '{first_name}, пора повторить визит!',
    attributionDays: 30,
    backfillMaxPerDay: 30,
    bonusEnabled: false,
    bonusTiers: [],
    sendIntervalMin: 3,
    ...overrides,
  };
}

describe('parseRuleBody', () => {
  test('валидное тело проходит без ошибок', () => {
    const r = parseRuleBody(validBody());
    expect(r.error).toBeUndefined();
    expect(r.value.title).toBe('Повтор через месяц');
    expect(r.value.conditions).toEqual({ logic: 'and', items: [{ type: 'category', ids: [1] }] });
  });

  test('пустой title отвергается', () => {
    expect(parseRuleBody(validBody({ title: '  ' })).error).toBe('Название обязательно');
  });

  test('слишком длинный title отвергается', () => {
    expect(parseRuleBody(validBody({ title: 'x'.repeat(256) })).error).toBe('Название слишком длинное');
  });

  test('условия без ни одного заполненного item отвергаются', () => {
    const r = parseRuleBody(validBody({ conditions: { logic: 'and', items: [] } }));
    expect(r.error).toMatch(/хотя бы одно условие/);
  });

  test('item с типом вне списка и item с пустыми ids отфильтровываются, оставляя условия пустыми', () => {
    const r = parseRuleBody(validBody({
      conditions: { logic: 'and', items: [{ type: 'unknown', ids: [1] }, { type: 'staff', ids: [] }] },
    }));
    expect(r.error).toMatch(/хотя бы одно условие/);
  });

  test.each([0, -1, 1.5, 731, NaN])('delayDays=%p отвергается (диапазон 1–730)', (delayDays) => {
    expect(parseRuleBody(validBody({ delayDays })).error).toBe('Задержка 1–730 дней');
  });

  test('пустой текст отвергается', () => {
    expect(parseRuleBody(validBody({ text: '   ' })).error).toBe('Текст напоминания пуст');
  });

  test('слишком длинный текст отвергается', () => {
    expect(parseRuleBody(validBody({ text: 'x'.repeat(2001) })).error).toBe('Текст слишком длинный');
  });

  test.each([0, -1, 366, NaN])('attributionDays=%p отвергается (диапазон 1–365)', (attributionDays) => {
    expect(parseRuleBody(validBody({ attributionDays })).error).toBe('Окно атрибуции 1–365 дней');
  });

  test.each([0, -1, 501, NaN])('backfillMaxPerDay=%p отвергается (диапазон 1–500)', (backfillMaxPerDay) => {
    expect(parseRuleBody(validBody({ backfillMaxPerDay })).error).toBe('Кап догона 1–500 в день');
  });

  test('невалидный sendTime тихо заменяется дефолтом 11:00', () => {
    const r = parseRuleBody(validBody({ sendTime: '25:99' }));
    expect(r.error).toBeUndefined();
    expect(r.value.sendTime).toBe('11:00');
  });

  test('неизвестный textMode тихо заменяется дефолтом strict', () => {
    const r = parseRuleBody(validBody({ textMode: 'wat' }));
    expect(r.error).toBeUndefined();
    expect(r.value.textMode).toBe('strict');
  });

  describe('ступени бонусов', () => {
    // Новый кап — предмет ревью: соседний parseProgramBody (routes/care.js)
    // ограничивает список касаний тем же числом (20).
    test('больше 20 ступеней отвергается', () => {
      const bonusTiers = Array.from({ length: 21 }, (_, i) => ({ upTo: i, action: 'mention', amount: 0 }));
      const r = parseRuleBody(validBody({ bonusEnabled: true, bonusTiers }));
      expect(r.error).toBe('Слишком много ступеней (макс 20)');
    });

    test('ровно 20 ступеней проходит', () => {
      const bonusTiers = Array.from({ length: 20 }, (_, i) => ({ upTo: i, action: 'mention', amount: 0 }));
      const r = parseRuleBody(validBody({ bonusEnabled: true, bonusTiers }));
      expect(r.error).toBeUndefined();
      expect(r.value.bonusTiers).toHaveLength(20);
    });

    test('неизвестное action отвергается', () => {
      const r = parseRuleBody(validBody({
        bonusEnabled: true,
        bonusTiers: [{ upTo: null, action: 'delete_everything', amount: 100 }],
      }));
      expect(r.error).toBe('Ступень 1: неизвестное действие');
    });

    test('accrue с нулевой суммой отвергается', () => {
      const r = parseRuleBody(validBody({
        bonusEnabled: true,
        bonusTiers: [{ upTo: null, action: 'accrue', amount: 0 }],
      }));
      expect(r.error).toBe('Ступень 1: сумма начисления должна быть больше нуля');
    });

    test('сумма больше 100000 отвергается', () => {
      const r = parseRuleBody(validBody({
        bonusEnabled: true,
        bonusTiers: [{ upTo: null, action: 'accrue', amount: 100001 }],
      }));
      expect(r.error).toBe('Ступень 1: сумма начисления слишком велика');
    });

    test('bonusEnabled без единой ступени отвергается', () => {
      const r = parseRuleBody(validBody({ bonusEnabled: true, bonusTiers: [] }));
      expect(r.error).toBe('Бонусы включены, но ни одной ступени не задано');
    });

    test('bonusEnabled=false с пустыми ступенями — валидно', () => {
      const r = parseRuleBody(validBody({ bonusEnabled: false, bonusTiers: [] }));
      expect(r.error).toBeUndefined();
    });
  });
});

// summarizeBackfillPlan — сводка плана догона для ручки превью. Вынесена
// наружу тем же приёмом, что parseRuleBody: maxAt/whenBy появились как
// реакция на готчу «порядок planned НЕ гарантирует возрастания scheduledAt»
// (см. комментарий в services/reminders/backfill.js) — ровно то место, где
// регресс легко внести и невозможно заметить без юнит-теста.
describe('summarizeBackfillPlan', () => {
  test('пустой план → нули и null', () => {
    const s = summarizeBackfillPlan([], []);
    expect(s).toEqual({
      rows: [],
      overdueCount: 0,
      futureCount: 0,
      lastOverdueAt: null,
      lastFutureAt: null,
      lastScheduledAt: null,
    });
  });

  // Порядок массива planned НАРОЧНО такой, что последний элемент — не самая
  // поздняя дата ни в одной из корзин: тест ловит регресс вида
  // `planned[planned.length - 1]` так же надёжно, как Math.max(...arr).
  test('корзины считаются раздельно максимумом, а не последним элементом', () => {
    const rows = [
      { recordId: 1, skipReason: null },
      { recordId: 2, skipReason: null },
      { recordId: 3, skipReason: null },
      { recordId: 4, skipReason: null },
    ];
    const planned = [
      { recordId: 1, scheduledAt: new Date('2026-08-20T08:00:00.000Z'), overdue: true },  // самая поздняя просроченная
      { recordId: 2, scheduledAt: new Date('2026-08-09T08:00:00.000Z'), overdue: true },
      { recordId: 3, scheduledAt: new Date('2026-08-25T08:00:00.000Z'), overdue: false }, // самая поздняя будущая = общий максимум
      { recordId: 4, scheduledAt: new Date('2026-08-11T08:00:00.000Z'), overdue: false }, // последний элемент массива — самый ранний
    ];
    const s = summarizeBackfillPlan(rows, planned);
    expect(s.overdueCount).toBe(2);
    expect(s.futureCount).toBe(2);
    expect(s.lastOverdueAt).toEqual(new Date('2026-08-20T08:00:00.000Z'));
    expect(s.lastFutureAt).toEqual(new Date('2026-08-25T08:00:00.000Z'));
    expect(s.lastScheduledAt).toEqual(new Date('2026-08-25T08:00:00.000Z'));
  });

  test('дата отправки проставляется строке по recordId', () => {
    const rows = [
      { recordId: 100, skipReason: null },
      { recordId: 200, skipReason: null },
    ];
    const planned = [
      { recordId: 100, scheduledAt: new Date('2026-08-10T08:00:00.000Z'), overdue: true },
      { recordId: 200, scheduledAt: new Date('2026-08-12T08:00:00.000Z'), overdue: false },
    ];
    const s = summarizeBackfillPlan(rows, planned);
    expect(s.rows.find(r => r.recordId === 100).scheduledAt).toEqual(new Date('2026-08-10T08:00:00.000Z'));
    expect(s.rows.find(r => r.recordId === 200).scheduledAt).toEqual(new Date('2026-08-12T08:00:00.000Z'));
  });

  // matchBackfillVisits не дедуплицирует записи YClients (сдвиг пагинации —
  // известный класс): у дубля-близнеца с тем же recordId, но skipReason
  // 'superseded', дата в колонке «Отправка» не нужна — он и так не уйдёт.
  test('строка со skipReason не получает дату отправки, даже если её recordId есть в plan', () => {
    const rows = [
      { recordId: 10, phone: '79001112233', skipReason: null },
      { recordId: 10, phone: '79001112233', skipReason: 'superseded' },
    ];
    const planned = [
      { recordId: 10, scheduledAt: new Date('2026-08-15T08:00:00.000Z'), overdue: true },
    ];
    const s = summarizeBackfillPlan(rows, planned);
    expect(s.rows[0].skipReason).toBeNull();
    expect(s.rows[0].scheduledAt).toEqual(new Date('2026-08-15T08:00:00.000Z'));
    expect(s.rows[1].skipReason).toBe('superseded');
    expect(s.rows[1].scheduledAt).toBeNull();
  });
});

// Пауза между сообщениями: 0 — «без задержки», это законное значение, а не
// «поле не задано». Валидация недоверчивая, как и у остальных полей правила.
describe('sendIntervalMin', () => {
  const base = () => ({
    title: 'Эпиляция', conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
    delayDays: 60, text: 'Пора повторить', attributionDays: 14,
    backfillMaxPerDay: 30, sendIntervalMin: 3,
  });

  test('валидное значение проходит', () => {
    expect(parseRuleBody(base()).value.sendIntervalMin).toBe(3);
  });

  test('ноль проходит и означает «без паузы»', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 0 }).value.sendIntervalMin).toBe(0);
  });

  test('отрицательное отвергается', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: -1 }).error).toMatch(/0–120/);
  });

  test('больше 120 отвергается', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 121 }).error).toMatch(/0–120/);
  });

  test('нечисловое отвергается, а не подставляется молча', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: 'быстро' }).error).toMatch(/0–120/);
  });

  test('поле не передано вовсе → безопасный дефолт 3, а не ошибка и не 0', () => {
    const b = base();
    delete b.sendIntervalMin;
    const r = parseRuleBody(b);
    expect(r.error).toBeUndefined();
    expect(r.value.sendIntervalMin).toBe(3);
  });

  test('null → дефолт 3', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: null }).value.sendIntervalMin).toBe(3);
  });

  test('пустая строка → дефолт 3', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: '' }).value.sendIntervalMin).toBe(3);
  });

  test('false отвергается, а не коэрсится в 0', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: false }).error).toMatch(/0–120/);
  });

  test('массив отвергается, а не коэрсится в 0', () => {
    expect(parseRuleBody({ ...base(), sendIntervalMin: [] }).error).toMatch(/0–120/);
  });
});

// ── фильтры журнала (GET /history) ─────────────────────────────
// Разбор вынесен из маршрута в чистую parseHistoryQuery по той же причине, что
// parseRuleBody: тут решается ПОРЯДОК выдачи, а он у запланированных строк
// противоположен журнальному (см. ниже), и проверять это через HTTP нечем.
describe('parseHistoryQuery', () => {
  test('пустой запрос → журнальные дефолты, порядок «свежие сверху»', () => {
    const q = parseHistoryQuery({});
    expect(q).toMatchObject({ limit: 50, offset: 0, ruleId: null, status: null, converted: null, date: null, asc: false });
  });

  test('limit ограничен сверху 200 и снизу 1, мусор → дефолт', () => {
    expect(parseHistoryQuery({ limit: '5000' }).limit).toBe(200);
    expect(parseHistoryQuery({ limit: '0' }).limit).toBe(50);
    expect(parseHistoryQuery({ limit: 'много' }).limit).toBe(50);
  });

  // Догон кладёт в очередь сотни строк на два месяца вперёд. При «свежие
  // сверху» первую страницу занимает САМЫЙ ДАЛЁКИЙ конец очереди, а ближайшая
  // отправка уезжает за предел выдачи — то есть ровно то, ради чего в очередь
  // и заглядывают, увидеть нельзя.
  test('фильтр «Запланировано» переворачивает порядок: ближайшие сверху', () => {
    expect(parseHistoryQuery({ status: 'scheduled' }).asc).toBe(true);
  });

  test('выбранный день тоже даёт хронологию сверху вниз', () => {
    const q = parseHistoryQuery({ date: '2026-08-10' });
    expect(q.date).toBe('2026-08-10');
    expect(q.asc).toBe(true);
  });

  test('битая дата игнорируется как фильтр, а не уходит в SQL', () => {
    expect(parseHistoryQuery({ date: '10.08.2026' }).date).toBeNull();
    expect(parseHistoryQuery({ date: "2026-08-10'; DROP" }).date).toBeNull();
    expect(parseHistoryQuery({ date: '2026-08-10' }).asc).toBe(true);
  });

  test('конверсия трёхзначна: 1 → true, 0 → false, прочее → без фильтра', () => {
    expect(parseHistoryQuery({ converted: '1' }).converted).toBe(true);
    expect(parseHistoryQuery({ converted: '0' }).converted).toBe(false);
    expect(parseHistoryQuery({ converted: 'да' }).converted).toBeNull();
  });

  test('ruleId числом, пустая строка — не ноль, а «все правила»', () => {
    expect(parseHistoryQuery({ ruleId: '7' }).ruleId).toBe(7);
    expect(parseHistoryQuery({ ruleId: '' }).ruleId).toBeNull();
  });
});
