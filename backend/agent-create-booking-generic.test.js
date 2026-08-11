'use strict';

// Интеграция generic-booking-guard в create_booking. Все внешние зависимости
// инструмента застаблены — тест проверяет ровно порядок гейтов и hint-ответ.
jest.mock('./services/agent/booking', () => ({
  createBookingRecord: jest.fn(async () => ({ created: true, record_id: 777 })),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));

const booking = require('./services/agent/booking');
const listServices = require('./services/agent/tools/list-services');
const tool = require('./services/agent/tools/create-booking');

beforeEach(() => jest.clearAllMocks());

const CATALOG = { services: [
  { yc_id: 99, title: 'Биоревитализация', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
  { yc_id: 10, title: 'Биоревитализация Revi Silk 1 ml', category_path: ['Инъекционная косметология', 'Биоревитализация'],
    staff: [{ yc_id: 5, name: 'Пери' }] },
] };

// nowMs фиксирован, слот заведомо за пределами lead-time (правило «впритык»).
const CTX = { clientPhone: '79001112233', dialogKey: '79001112233',
  nowMs: Date.parse('2026-08-10T10:00:00+03:00'), patientText: 'хочу биоревитализацию' };
const INPUT = { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-08-14T15:00:00+03:00' };

describe('create_booking × generic-booking-guard', () => {
  test('препарат не назван пациентом → hint без записи, с id обобщённой услуги', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, INPUT, CTX);
    expect(res.generic_service_hint).toBe(true);
    expect(res.error).toContain('service_yc_id=99');
    expect(res.error).toContain('patient_named_service');
    expect(booking.createBookingRecord).not.toHaveBeenCalled();
  });

  test('пациент называл бренд → запись проходит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, INPUT, { ...CTX, patientText: 'хочу Revi Silk' });
    expect(res.created).toBe(true);
    expect(booking.createBookingRecord).toHaveBeenCalled();
  });

  test('обход patient_named_service:true → запись проходит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, { ...INPUT, patient_named_service: true }, CTX);
    expect(res.created).toBe(true);
  });

  test('без patientText в ctx (например book_chain) → guard молчит', async () => {
    listServices.run.mockResolvedValue(CATALOG);
    const { patientText, ...ctx } = CTX;
    const res = await tool.run(1, INPUT, ctx);
    expect(res.created).toBe(true);
  });

  test('имя правила, процитированное в hint, существует в системном промпте дословно', async () => {
    // Связывающий тест: hint ссылается на правило по имени, и переименование
    // правила в system-prompt.js без правки hint оставило бы модель с битой ссылкой.
    const { buildSystemPrompt } = require('./services/agent/system-prompt');
    listServices.run.mockResolvedValue(CATALOG);
    const res = await tool.run(1, INPUT, CTX);
    const m = String(res.error).match(/По правилу «([^»]+)»/);
    expect(m).not.toBe(null);
    expect(buildSystemPrompt({})).toContain(m[1]);
  });
});
