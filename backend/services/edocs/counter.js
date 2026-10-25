'use strict';
// Номера договоров (спека 2026-10-25 §9). Свой номер пациента главнее счётчика: поле данных для
// документов → поле YClients «Номер договора» (электронная версия того же договора идёт под
// прежним номером) → следующий номер счётчика edoc_counters. Счётчик заводится при первом
// обращении: максимум числовых номеров салона (YClients и client_identity) + 1. Номер, уже занятый
// кем-то из пациентов (его могли выдать вручную в YClients), пропускается.
const { db, withTransaction } = require('../../db');
const { EdocsError } = require('./errors');

const YC_FIELD = 'nomer-dogovra';
const KIND = 'contract';
const MAX_SKIP = 50;   // столько занятых номеров подряд пропускаем, дальше — ошибка (явно что-то не так)
const NUM_RE = '^[0-9]{1,15}$';

const MAX_USED_SQL = `SELECT GREATEST(
    COALESCE((SELECT max(trim(yclients_data->'custom_fields'->>'${YC_FIELD}')::bigint) FROM clients
               WHERE salon_id=$1 AND trim(yclients_data->'custom_fields'->>'${YC_FIELD}') ~ '${NUM_RE}'), 0),
    COALESCE((SELECT max(trim(contract_no)::bigint) FROM client_identity
               WHERE salon_id=$1 AND trim(contract_no) ~ '${NUM_RE}'), 0)
  ) AS max_used`;
const TAKEN_SQL = `SELECT 1 FROM clients WHERE salon_id=$1 AND trim(yclients_data->'custom_fields'->>'${YC_FIELD}')=$2
  UNION ALL SELECT 1 FROM client_identity WHERE salon_id=$1 AND trim(contract_no)=$2 LIMIT 1`;

/** Номер договора из карточки YClients или null. */
function yclientsNumber(client) {
  const custom = client && client.yclients_data && typeof client.yclients_data.custom_fields === 'object'
    ? client.yclients_data.custom_fields : null;
  const v = custom ? custom[YC_FIELD] : null;
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, 50) : null;
}

async function maxUsed(salonId, q = db) {
  const r = await q.query(MAX_USED_SQL, [salonId]);
  return Number((r.rows ? r.rows[0] : r).max_used) || 0;
}

/** Что покажет настройка: следующий номер (без записи в БД) и максимальный уже выданный. */
async function peek(salonId) {
  const row = await db.oneOrNone('SELECT next_value FROM edoc_counters WHERE salon_id=$1 AND kind=$2', [salonId, KIND]);
  const used = await maxUsed(salonId);
  return { next: row ? Number(row.next_value) : used + 1, maxUsed: used };
}

/** Владелец задаёт следующий номер. */
async function setNext(salonId, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999999999999) throw new EdocsError('bad_counter', 'Следующий номер — целое число от 1', 400);
  await db.query(
    `INSERT INTO edoc_counters (salon_id, kind, next_value) VALUES ($1, $2, $3)
     ON CONFLICT (salon_id, kind) DO UPDATE SET next_value=EXCLUDED.next_value, updated_at=NOW()`,
    [salonId, KIND, n],
  );
  return n;
}

/**
 * Номер договора пациента к отправке. Вызывается ДО сборки DOCX; присвоенный номер сразу
 * пишется в client_identity (и дата договора, если пуста) — повтор отправки возьмёт его же.
 * @returns {{ contractNo: string, source: 'identity'|'yclients'|'counter', assigned: boolean }}
 */
async function ensureContractNo({ salonId, clientId, client, docDate }) {
  return withTransaction(async (c) => {
    const row = (await c.query(
      'SELECT contract_no FROM client_identity WHERE salon_id=$1 AND client_id=$2 FOR UPDATE', [salonId, clientId],
    )).rows[0];
    if (!row) throw new EdocsError('missing_fields', 'Сначала сохраните данные пациента', 400);
    const own = String(row.contract_no || '').trim();
    if (own) return { contractNo: own, source: 'identity', assigned: false };
    let no = yclientsNumber(client);
    let source = 'yclients';
    if (!no) {
      source = 'counter';
      await c.query(
        `INSERT INTO edoc_counters (salon_id, kind, next_value) SELECT $1, $2, (${MAX_USED_SQL}) + 1
         ON CONFLICT (salon_id, kind) DO NOTHING`,
        [salonId, KIND],
      );
      for (let i = 0; ; i++) {
        const r = (await c.query(
          `UPDATE edoc_counters SET next_value=next_value+1, updated_at=NOW() WHERE salon_id=$1 AND kind=$2 RETURNING next_value-1 AS no`,
          [salonId, KIND],
        )).rows[0];
        no = String(r.no);
        if (!(await c.query(TAKEN_SQL, [salonId, no])).rows.length) break;
        if (i >= MAX_SKIP) throw new EdocsError('counter_exhausted', `Номера договоров с ${no} заняты подряд — проверьте «Следующий номер» в настройках`, 409);
      }
    }
    await c.query(
      `UPDATE client_identity SET contract_no=$3, contract_date=COALESCE(contract_date, $4::date), updated_at=NOW()
       WHERE salon_id=$1 AND client_id=$2`,
      [salonId, clientId, no, docDate || null],
    );
    return { contractNo: no, source, assigned: true };
  });
}

module.exports = { yclientsNumber, maxUsed, peek, setNext, ensureContractNo, MAX_USED_SQL, YC_FIELD };
