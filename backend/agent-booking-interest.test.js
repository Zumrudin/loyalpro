'use strict';
const { bookingInterest, applyContextualOffer, STEP_QUESTION, hasBookingInvitation, removeRepeatedOffer } = require('./services/agent/booking-interest');
const NOW = Date.parse('2026-10-09T20:00:00+03:00');
const row = (direction, text, seconds = 0, authored_by = direction === 'outgoing' ? 'agent' : null) =>
  ({ direction, text, msg_ts: NOW / 1000 + seconds, authored_by });
const initial = [row('incoming', 'Расскажите про чистку', -180),
  row('outgoing', 'Процедура включает несколько этапов очищения.', -150)];
const ask = 'А пилинг входит?';
const answer = 'Пилинг оплачивается отдельно.';
const options = (extra = {}) => ({ conversation: [...initial, row('incoming', ask)],
  patientLastText: ask, replyText: answer, hasServiceEvidence: true, nowMs: NOW, ...extra });

test('после двух ходов интереса отвечает и приглашает, после первого — только отвечает', () => {
  expect(applyContextualOffer([answer], bookingInterest(options()))).toEqual([`${answer} ${STEP_QUESTION}`]);
  const policy = bookingInterest(options({ conversation: [row('incoming', ask)] }));
  expect(applyContextualOffer([answer], policy)).toEqual([answer]);
});

test('серия входящих без ответа — один ход, не накопленный интерес', () => {
  const conversation = [row('incoming', 'Расскажите про чистку', -30), row('incoming', ask)];
  expect(bookingInterest(options({ conversation })).contextual).toBe(false);
});

test('последующие уточнения и другая цена не получают повторного приглашения', () => {
  const conversation = [...initial, row('outgoing', STEP_QUESTION, -90), row('incoming', ask)];
  expect(bookingInterest(options({ conversation })).reason).toBe('already_offered');
  expect(bookingInterest(options({ conversation, patientLastText: 'А сколько стоит пилинг?' })).allowStep).toBe(false);
});

test.each(['Подобрать время?', 'Могу предложить удобный день.', 'Хотите записаться?',
  'Записать Вас на консультацию?', 'Какой день Вам удобен?', 'Предлагаю консультацию врача.'])
('узнаёт предложение модели или администратора: %s', text => {
  const conversation = [...initial, row('outgoing', text, -60, 'operator')];
  expect(hasBookingInvitation(text)).toBe(true);
  expect(bookingInterest(options({ conversation })).allowStep).toBe(false);
});

test.each(['Входит уход.', 'Процедура длится час.', 'Расскажу подробнее о процедуре.'])
('описание не является предложением записи: %s', text => expect(hasBookingInvitation(text)).toBe(false));

test.each(['Подумаю', 'Напишу сама', 'Нет, спасибо', 'Пока не нужно', 'Не предлагайте запись',
  'Я просто узнаю', 'Не хочу записываться'])
('отказ сохраняется на следующем информационном ходе: %s', text => {
  const conversation = [...initial, row('incoming', text, -60), row('outgoing', 'Хорошо.', -30), row('incoming', ask)];
  expect(bookingInterest(options({ conversation })).reason).toBe('declined');
});

test.each(['После процедуры болит лицо', 'Сколько стоит чистка при беременности?',
  'Какая подготовка нужна?', 'Можно ли мне при аллергии?', 'Хочу пожаловаться администратору',
  'Сколько стоит? Перенесите мою запись', 'Вы хамите', 'Я уже записана, что входит?'])
('не продаёт в неподходящий момент: %s', patientLastText => {
  expect(bookingInterest(options({ patientLastText })).allowStep).toBe(false);
});

test.each(['Эту процедуру мы не проводим.', 'Такой услуги у нас нет.',
  'Решает врач после осмотра.', 'Вы записаны на приём.'])
('к отказу или медицинскому ограничению не добавляется запись: %s', replyText => {
  expect(bookingInterest(options({ replyText })).allowStep).toBe(false);
});

test('свежая запись, поиск слотов и стоп-тема закрывают инициативу', () => {
  for (const extra of [{ hasBookings: true }, { bookingInProgress: true }, { stopTopics: ['пилинг'] }]) {
    expect(bookingInterest(options(extra)).allowStep).toBe(false);
  }
});

test('названный день не получает лишний вопрос о подборе времени', () => {
  expect(bookingInterest(options({ patientLastText: 'Как проходит чистка завтра?' })).allowStep).toBe(false);
});

test('личное медицинское ограничение не забывается на следующем вопросе о цене', () => {
  const conversation = [row('incoming', 'У меня аллергия', -120),
    row('outgoing', 'Это нужно обсудить с врачом.', -90), row('incoming', 'Сколько стоит чистка?')];
  expect(bookingInterest(options({ conversation, patientLastText: 'Сколько стоит чистка?' })).reason).toBe('medical_context');
});

test('отказ в текущем сообщении позволяет убрать повторное приглашение модели', () => {
  const policy = bookingInterest(options({ patientLastText: 'Подумаю, а пилинг входит?' }));
  expect(removeRepeatedOffer([`${answer} ${STEP_QUESTION}`], policy)).toEqual([answer]);
});

test('вопрос модели сначала требует ответа; своё приглашение не дублируется', () => {
  const policy = bookingInterest(options());
  for (const text of ['Какая зона Вас интересует?', `${answer} Хотите записаться?`, 'Предлагаю подобрать день.']) {
    expect(applyContextualOffer([text], policy)).toEqual([text]);
  }
});

test('отсутствие проверенных фактов и нерелевантная реплика не создают интерес', () => {
  expect(bookingInterest(options({ hasServiceEvidence: false })).contextual).toBe(false);
  expect(bookingInterest(options({ patientLastText: 'Добрый вечер' })).contextual).toBe(false);
});

test('после шестичасового разрыва старые интерес и отказы не переносятся', () => {
  const conversation = initial.map(r => ({ ...r, msg_ts: r.msg_ts - 7 * 3600 }));
  conversation.push(row('outgoing', STEP_QUESTION, -7 * 3600), row('incoming', ask));
  const policy = bookingInterest(options({ conversation }));
  expect(policy.allowStep).toBe(true);
  expect(policy.contextual).toBe(false);
});

test('уведомления не считаются ответами на вопросы и не создают второй ход', () => {
  const conversation = [initial[0], row('outgoing', 'Уведомление клиники.', -60, 'system'), row('incoming', ask)];
  expect(bookingInterest(options({ conversation })).contextual).toBe(false);
});

test('неполная история не создаёт многоходовый интерес', () => {
  const conversation = initial.map(r => ({ ...r, msg_ts: null }));
  expect(bookingInterest(options({ conversation })).contextual).toBe(false);
  expect(bookingInterest(options({ conversation: undefined })).contextual).toBe(false);
});

test('повторное шаблонное приглашение модели убирается, содержательный ответ остаётся', () => {
  const policy = { reason: 'already_offered' };
  expect(removeRepeatedOffer([`${answer} ${STEP_QUESTION}`], policy)).toEqual([answer]);
  expect(removeRepeatedOffer([answer, 'Хотите записаться?'], { reason: 'declined' })).toEqual([answer]);
  for (const reply of ['Записать Вас на чистку в 15:00?', 'Какой пилинг Вас интересует?', STEP_QUESTION]) {
    expect(removeRepeatedOffer([reply], policy)).toEqual([reply]);
  }
  expect(removeRepeatedOffer([`${answer} ${STEP_QUESTION}`], { reason: 'sensitive_or_active' }))
    .toEqual([`${answer} ${STEP_QUESTION}`]);
});
