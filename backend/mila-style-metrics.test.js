'use strict';

const { computeStyleMetrics } = require('./scripts/mila-style-metrics');

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
