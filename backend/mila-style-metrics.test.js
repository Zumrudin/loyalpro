'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeStyleMetrics, parseArgs } = require('./scripts/mila-style-metrics');

// Счётчики те же, что в разборе 27.10.2026 (спека …-mila-human-tone-design.md,
// раздел 6): сравнивать «до» и «после» одним инструментом.
test('счётчики стиля по синтетическим строкам', () => {
  const rows = [
    { key: 'a', direction: 'incoming', authored_by: null, text: 'Здравствуйте', msg_ts: 1 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Здравствуйте, Полина! Я Мила, виртуальный администратор PERI CLINIC. Спасибо, что подтвердили визит.', msg_ts: 2 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Есть **15:30**, записать вас?', msg_ts: 3 },
    { key: 'a', direction: 'outgoing', authored_by: 'agent', text: 'Если появятся вопросы, пишите 🤍', msg_ts: 4 },
    { key: 'b', direction: 'outgoing', authored_by: 'agent', text: 'Здравствуйте!\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nЧем могу помочь?', msg_ts: 5 },
    { key: 'b', direction: 'outgoing', authored_by: 'system', text: 'Вы записаны', msg_ts: 6 },
  ];
  const m = computeStyleMetrics(rows);
  expect(m).toMatchObject({ replies: 4, dialogs: 2, intros: 2, introsStapled: 1, runs2: 0, runs3plus: 1 });
  expect(m.markdownPct).toBe(25);
  expect(m.lowerAddressPct).toBe(25);
  expect(m.capitalAddressPct).toBe(0);
  expect(m.emojiPct).toBe(25);
  expect(m.endsWithQuestionPct).toBe(50);
  expect(m.medianChars).toBeGreaterThan(0);
});

test('пустой набор не делит на ноль', () => {
  expect(computeStyleMetrics([])).toMatchObject({ replies: 0, dialogs: 0, markdownPct: 0, medianChars: 0 });
});

// ── Правки после ревью координатора ─────────────────────────────────────────
// Новая форма первого сообщения (greeting.js, 27.10.2026): представление на
// собственной строке, суть — после пустой строки. Без этого introsStapled не
// показал бы эффект выката: любое представление с сутью считалось «скрепкой».
const agentRow = text => ({ key: 'k', direction: 'outgoing', authored_by: 'agent', text, msg_ts: 1 });

test('представление на своей строке и суть после пустой строки — не «приклеено»', () => {
  const m = computeStyleMetrics([agentRow('Здравствуйте, Полина!🤍\nЭто Мила, виртуальный администратор PERI CLINIC.\n\nЕсть 15:30, записать Вас?')]);
  expect(m).toMatchObject({ intros: 1, introsStapled: 0 });
});

test('старая склейка в одном абзаце остаётся «приклеенной»', () => {
  expect(computeStyleMetrics([agentRow('Здравствуйте, Полина! Я Мила, виртуальный администратор PERI CLINIC. Есть 15:30.')]))
    .toMatchObject({ intros: 1, introsStapled: 1 });
  // Представление в начале строки, но суть на ТОЙ ЖЕ строке — тоже склейка.
  expect(computeStyleMetrics([agentRow('Я Мила, виртуальный администратор PERI CLINIC. Спасибо, что подтвердили визит.')]))
    .toMatchObject({ intros: 1, introsStapled: 1 });
});

test('«Меня зовут Мила» — представление, как в greeting.INTRO_RE', () => {
  expect(computeStyleMetrics([agentRow('Меня зовут Мила, чем помочь?')])).toMatchObject({ intros: 1 });
});

test('вопрос в конце считается и с хвостовым эмодзи и пробелами', () => {
  expect(computeStyleMetrics([agentRow('Записать Вас? 🤍')]).endsWithQuestionPct).toBe(100);
  expect(computeStyleMetrics([agentRow('Записать Вас?🤍 ✨  ')]).endsWithQuestionPct).toBe(100);
  // Вопрос не в конце — не считается.
  expect(computeStyleMetrics([agentRow('Записать Вас? Жду ответа 🤍')]).endsWithQuestionPct).toBe(0);
});

// Аргументы: форма «--name value» из спеки (раздел 6) раньше молча игнорировалась,
// и `--db loyalpro` читал бы дев, выдавая его за прод.
test('аргументы: «--name=value» и «--name value» равнозначны, значения по умолчанию', () => {
  const expected = { days: 60, salon: 2, db: 'loyalpro' };
  expect(parseArgs(['--days=60', '--salon=2', '--db=loyalpro'])).toEqual(expected);
  expect(parseArgs(['--days', '60', '--salon', '2', '--db', 'loyalpro'])).toEqual(expected);
  expect(parseArgs(['--days', '60', '--db=loyalpro', '--salon=2'])).toEqual(expected);
  expect(parseArgs([])).toEqual({ days: 14, salon: 1, db: null });
});

test('аргументы: опечатка и любой нераспознанный аргумент — ошибка, а не молчаливый дефолт', () => {
  const bad = [
    ['--day=30'], ['--DAYS=7'], ['-d', '7'], ['loyalpro'],           // нераспознанное
    ['--days', '30', 'loyalpro'],                                   // лишнее слово после значения
    ['--db'], ['--db', '--days=30'], ['--days='],                   // нет значения
    ['--days=7', '--days=30'],                                      // повтор
    ['--days=0'], ['--days=400'], ['--days=abc'], ['--salon=1.5'],  // значение вне границ
  ];
  for (const argv of bad) expect(parseArgs(argv)).toHaveProperty('error');
});

test('опечатка в аргументе: usage в stderr и код 2 — до подключения к БД', () => {
  const script = path.join(__dirname, 'scripts', 'mila-style-metrics.js');
  // DATABASE_URL подменён на недостижимый: dotenv чужие переменные не перезаписывает,
  // так что при регрессии разбора тест упадёт на коде 1, а не прочитает настоящую БД.
  const env = { ...process.env, DATABASE_URL: 'postgres://nobody:nopass@127.0.0.1:1/none' };
  const r = spawnSync(process.execPath, [script, '--day=30'], { encoding: 'utf8', timeout: 20000, env });
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/usage:/);
});
