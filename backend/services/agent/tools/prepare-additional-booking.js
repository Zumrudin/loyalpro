'use strict';

const proposals = require('../additional-proposals');
const listServices = require('./list-services');
const settings = require('../../agent-settings');
const filter = require('../service-filter');
const { sanitizeLine } = require('../sanitize');
const { moscowDateKey, moscowHHMM } = require('../slot-evidence');
const leadTime = require('../lead-time');
const schema = {
  name: 'prepare_additional_booking',
  description: 'Подготовить отдельный дополнительный визит основного пациента с сохранением ВСЕХ прежних записей. Используй только если пациент по смыслу хочет ещё один визит, а не перенос. При неоднозначности сначала уточни намерение. Запись не создаёт: сервер отправит точное предложение, завершит ход и дождётся ответа пациента. При смене даты, времени, услуги или специалиста подготовь новое предложение. После согласия используй create_booking с proposal_id из серверного контекста.',
  input_schema: { type: 'object', additionalProperties: false,
    properties: {
      service_yc_id: { type: 'integer' }, staff_yc_id: { type: 'integer' },
      datetime: { type: 'string', description: 'Точный ISO datetime из проверенных слотов.' },
      seance_length: { type: 'integer', description: 'Длительность слота в секундах, если известна.' },
    }, required: ['service_yc_id', 'staff_yc_id', 'datetime'] },
};
async function run(salonId, input, ctx = {}) {
  const reject = error => ({ invalid_args: true, error });
  if (!ctx.dialogKey || !ctx.clientPhone || !Array.isArray(ctx.liveBookings)
      || !ctx.liveBookings.length || ctx.liveBookings.some(b => !b.record_id || !Array.isArray(b.service_yc_ids) || !b.service_yc_ids.length)) {
    return reject('Сначала проверь номер пациента и его существующие записи. Дополнительный визит пока не подготовлен.');
  }
  if (!Number.isInteger(input.service_yc_id) || input.service_yc_id <= 0
      || !Number.isInteger(input.staff_yc_id) || input.staff_yc_id <= 0
      || !Number.isFinite(Date.parse(input.datetime))
      || (input.seance_length !== undefined && (!Number.isInteger(input.seance_length) || input.seance_length <= 0))) return reject('Некорректные параметры визита.');
  if (!ctx.slotEvidence || !ctx.slotEvidence.has(input.datetime, {
    staffYcId: input.staff_yc_id, serviceYcIds: [input.service_yc_id], requireExact: true,
  })) return reject('Сначала получи доступные слоты для этой услуги и специалиста.');
  const violation = leadTime.violation(leadTime.moscowNow(ctx.nowMs || Date.now()), input.datetime);
  if (violation) return reject(leadTime.violationHint(violation));
  const rules = await settings.loadServiceFilterSafe(salonId);
  if (!filter.isBookable(rules, input.service_yc_id, input.staff_yc_id)) return reject('Услуга у этого специалиста недоступна.');
  const catalog = await listServices.run(salonId);
  const service = catalog && (catalog.services || []).find(s => Number(s.yc_id) === input.service_yc_id);
  const staff = service && (service.staff || []).find(s => Number(s.yc_id) === input.staff_yc_id);
  const title = service && sanitizeLine(service.title, 200);
  const name = staff && sanitizeLine(staff.name, 100);
  if (!title || !name) return reject('Не удалось проверить название услуги и специалиста. Повтори чтение каталога.');
  const date = moscowDateKey(Date.parse(input.datetime)).split('-').reverse().join('.');
  const duration = input.seance_length ? `, длительность ${input.seance_length / 60} мин` : '';
  const text = `Предлагаю дополнительный визит: ${title}, специалист ${name}, ${date} в ${moscowHHMM(input.datetime)}${duration}. Все прежние записи сохраняем. Оформить этот дополнительный визит?`;
  const p = proposals.prepare(salonId, ctx, input, text);
  return { proposal_id: p.id, proposal_text: p.text, awaiting_confirmation: true };
}
module.exports = { schema, run };
