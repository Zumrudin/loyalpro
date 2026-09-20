'use strict';
// Класс ситуации хода-якоря для бонусного довода. Первое совпадение сверху
// побеждает: modify > clarify > choice > price > unknown.
const { classifySituation, lastOwnReply, BONUS_OK } = require('./services/agent/followup-situation');
const { OPERATOR_MARK } = require('./services/agent/history');

const ev = (tool, result = {}, is_error = false) => ({ tool, input: {}, result, is_error });

describe('classifySituation', () => {
  test('пустой журнал и нейтральный текст → unknown, без довода', () => {
    expect(classifySituation({ events: [], ownText: 'Уточню у врача и вернусь.' }))
      .toEqual({ kind: 'unknown', bonusOk: false });
  });
  test('слоты в выдаче → choice', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [{ time: '12:00' }] })] }))
      .toEqual({ kind: 'choice', bonusOk: true });
  });
  test.each([
    ['offer_slots', { offer_slots: [{}] }], ['staff_options', { staff_options: [{}] }],
    ['alternative_staff', { alternative_staff: [{}] }], ['free_day', { free_day: true, slots: [] }],
    ['variants (sequential)', { variants: [{}] }], ['starts (parallel)', { starts: [{}] }],
    ['schedule (dates)', { schedule: [{}] }],
  ])('непустая выдача по ключу %s → choice', (_n, result) => {
    expect(classifySituation({ events: [ev('get_sequential_slots', result)] }).kind).toBe('choice');
  });
  test('пустая выдача слотов и is_error — не choice', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [] })] }).kind).toBe('unknown');
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [{}] }, true)] }).kind).toBe('unknown');
  });
  test('get_service_masters / send_price_list → price', () => {
    expect(classifySituation({ events: [ev('get_service_masters', { price_min: 1 })] })).toEqual({ kind: 'price', bonusOk: true });
    expect(classifySituation({ events: [ev('send_price_list', { attached: true })] }).kind).toBe('price');
  });
  test('сумма с валютой в реплике Милы → price даже без инструментов', () => {
    expect(classifySituation({ events: [], ownText: 'Чистка у Юлии стоит от 4500 ₽.' }).kind).toBe('price');
    expect(classifySituation({ events: [], ownText: 'Это 12 000 руб.' }).kind).toBe('price');
  });
  test('hint-флаг create_booking → clarify, перекрывает choice', () => {
    const events = [ev('get_available_slots', { slots: [{}] }), ev('create_booking', { needs_phone: true, invalid_args: true })];
    expect(classifySituation({ events })).toEqual({ kind: 'clarify', bonusOk: false });
    expect(classifySituation({ events: [ev('book_chain', { generic_service_hint: true })] }).kind).toBe('clarify');
  });
  test('перенос/отмена инструментом или словом → modify, перекрывает всё', () => {
    const events = [ev('get_available_slots', { slots: [{}] }), ev('reschedule_booking', { needs_confirmation: true })];
    expect(classifySituation({ events })).toEqual({ kind: 'modify', bonusOk: false });
    expect(classifySituation({ events: [ev('get_service_masters', {})], ownText: 'Перенесла бы вас на 15:00, подтверждаете?' }).kind).toBe('modify');
    expect(classifySituation({ events: [], ownText: 'Отменить запись?' }).kind).toBe('modify');
  });
  test('«переносица» словом переноса не считается', () => {
    expect(classifySituation({ events: [], ownText: 'Зона переносицы стоит 3000 ₽.' }).kind).toBe('price');
  });
  test('результат-заглушка truncated не роняет', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { truncated: true, preview: '…' })] }).kind).toBe('unknown');
  });
  test('BONUS_OK перечисляет ровно choice и price', () => {
    expect([...BONUS_OK].sort()).toEqual(['choice', 'price']);
  });
});

describe('lastOwnReply', () => {
  test('последний assistant-блок без строк администратора', () => {
    const messages = [
      { role: 'user', content: 'Сколько стоит?' },
      { role: 'assistant', content: `От 4500 ₽.\n${OPERATOR_MARK} Перенесла вашу запись.` },
    ];
    expect(lastOwnReply(messages)).toBe('От 4500 ₽.');
  });
  test('транскрипт кончается клиентом или пуст → пустая строка', () => {
    expect(lastOwnReply([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }])).toBe('');
    expect(lastOwnReply([])).toBe('');
    expect(lastOwnReply(null)).toBe('');
  });
});
