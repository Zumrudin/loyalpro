'use strict';

const { db } = require('../../../db');
const bookingModify = require('../booking-modify');
const identity = require('../identity');
const { ycFindServiceIdByTitle } = require('../../yclients-records');

const schema = {
  name: 'cancel_booking',
  description: 'ОТМЕНИТЬ запись пациента. Вызывать ТОЛЬКО после того, как пациент подтвердил ' +
    'отмену И отказался от переноса (сначала всегда предлагай перенос — см. сценарий отмены/переноса ' +
    'в промпте). record_id бери из list_client_bookings — НИКОГДА не придумывай.',
  input_schema: {
    type: 'object',
    properties: {
      record_id: { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
    },
    required: ['record_id'],
    additionalProperties: false,
  },
};

// Услуга-флаг «Запрет на отправку» глушит уведомления YClients по записи.
// Ищем её в ПОЛНОМ каталоге салона по нормализованному названию (отдельной
// настройки нет). Важно: НЕ через list_services — тот в allowlist-режиме
// (feat/agent-service-filter) отдаёт только услуги из белого списка и режет
// технические услуги с ценой 0, поэтому «Запрет на отправку» там не находится.
const NO_NOTIFY_TITLE = 'запрет на отправку';

async function findNoNotifyServiceId(salonId) {
  let salon;
  try {
    salon = await db.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
  } catch (_) { return null; }
  if (!salon.yclients_company_id) return null;
  try { return await ycFindServiceIdByTitle(salon, NO_NOTIFY_TITLE); }
  catch (_) { return null; }
}

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  if (!recordId) return { invalid_args: true, error: 'Нужен record_id из list_client_bookings.' };

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  // Fail-closed: без подтверждённого клиента отмену не делаем (иначе гейт
  // принадлежности в booking-modify открывается — можно было бы отменить чужую
  // запись по выдуманному record_id). Клиент без синхронизированной истории
  // сюда не попадёт (list_client_bookings тоже вернёт client_not_found).
  if (!expectedYcClientId) {
    return { unverified: true,
      error: 'Не удалось подтвердить, что запись принадлежит этому пациенту. ' +
        'Уточни номер телефона или переведи диалог на администратора.' };
  }
  const noNotifyServiceId = await findNoNotifyServiceId(salonId);

  const res = await bookingModify.cancelBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    noNotifyServiceId,
  });
  if (!res.ok) return { error: res.error, foreign: res.foreign };
  return {
    cancelled: true,
    record_id: res.record_id,
    already: !!res.already,
    // услуга «Запрет на отправку» не найдена в каталоге → уведомления могли не заглушиться
    no_notify_warning: !noNotifyServiceId,
  };
}

module.exports = { schema, run };
