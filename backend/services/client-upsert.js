'use strict';
// Одно правило разбора карточки клиента YClients → строка `clients`.
//
// ЗАЧЕМ. До 25.09.2026 траты/визиты/уровень/yclients_data писал ТОЛЬКО runSync
// (полный обход 4 300 клиентов раз в 3 часа; сломан лимитом YClients с 26.06),
// а client-вебхук — он приходит на КАЖДЫЙ оплаченный визит и на каждую правку
// карточки и несёт те же поля (spent/paid/visits/surname/patronymic/birth_date) —
// сохранял только ФИО/телефон/почту/ДР. Теперь вебхук и ночная сверка
// (services/yclients-reconcile.js) пишут клиента через ЭТУ функцию.
//
// Что НЕ трогаем намеренно: bonus_balance/yclients_card_* — это карта лояльности,
// её ведут начисление и finances_operation; поле `balance` в карточке клиента —
// депозит/долг, не карта. YClients — источник правды: total_spent ПРИСВАИВАЕТСЯ,
// а не максимизируется (отменённый платёж уменьшает spent, и это верно).
const { db } = require('../db');
const { buildClientFio } = require('../utils/client-name');
const { getLevel } = require('./loyalty');

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

/** Чистый разбор объекта клиента YClients (вебхук или /client/{cid}/{id}). */
function clientFieldsFromYc(yc, levels) {
  const spent = yc.spent != null && yc.spent !== '' ? num(yc.spent) : num(yc.paid);
  const totalSpent = spent;
  const visitsCount = parseInt(yc.visits, 10) || 0;
  const level = Array.isArray(levels) && levels.length ? getLevel(totalSpent, levels).key : null;
  return {
    name: buildClientFio(yc),
    phone: yc.phone || null,
    email: yc.email || null,
    birthday: yc.birth_date || null,
    totalSpent, visitsCount, level,
    ycData: yc,
  };
}

/**
 * Upsert клиента по (salon_id, yclients_client_id). Возвращает строку clients
 * или null, если у объекта нет id. Уровень пишется COALESCE — без настроенных
 * уровней существующий не затирается.
 */
async function upsertClientFromYc(salonId, yc, settings) {
  if (!yc || yc.id == null) return null;
  const f = clientFieldsFromYc(yc, settings?.levels);
  return db.one(
    `INSERT INTO clients
       (salon_id, yclients_client_id, name, phone, email, birthday,
        total_spent, visits_count, loyalty_level, yclients_data, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'bronze'),$10,NOW())
     ON CONFLICT (salon_id, yclients_client_id) DO UPDATE SET
       name=$3, phone=$4, email=$5, birthday=$6,
       total_spent=$7, visits_count=$8,
       loyalty_level=COALESCE($9, clients.loyalty_level),
       yclients_data=$10, synced_at=NOW(), updated_at=NOW()
     RETURNING *`,
    [salonId, yc.id, f.name, f.phone, f.email, f.birthday,
     f.totalSpent, f.visitsCount, f.level, JSON.stringify(yc)]
  );
}

module.exports = { clientFieldsFromYc, upsertClientFromYc };
