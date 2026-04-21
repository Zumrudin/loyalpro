// ============================================================
// Loyalty & Sync Service
// ============================================================
const { pool, db } = require('../db');
const { ycGet, ycPost, ycGetClientCards, ycAccrueCard } = require('./yclients');
const { createLogger } = require('../logger');
const logger = createLogger('Sync');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getLoyaltySettings(salonId) {
  const row = await db.oneOrNone('SELECT * FROM loyalty_settings WHERE salon_id=$1', [salonId]);
  if (!row) return null;
  if (typeof row.levels === 'string') row.levels = JSON.parse(row.levels);
  if (typeof row.service_cashback === 'string') row.service_cashback = JSON.parse(row.service_cashback);
  return row;
}

function getLevel(totalSpent, levels) {
  const sorted = [...levels].sort((a, b) => b.minSpent - a.minSpent);
  return sorted.find(l => totalSpent >= l.minSpent) || sorted[sorted.length - 1];
}

function calcBonus(visitAmount, serviceIds, level, serviceCashback) {
  let pct = level.cashback || 5;
  if (serviceCashback && serviceIds?.length) {
    const overrides = serviceIds.map(id => serviceCashback[String(id)]).filter(p => p !== undefined);
    if (overrides.length) pct = Math.max(pct, ...overrides);
  }
  return { pct, bonus: Math.floor(visitAmount * pct / 100) };
}

function getRecordCost(ycr) {
  if (ycr.cost !== undefined && ycr.cost !== null) return parseFloat(ycr.cost) || 0;
  if (Array.isArray(ycr.services) && ycr.services.length > 0) {
    return ycr.services.reduce((sum, s) => sum + parseFloat(s.cost_to_pay ?? s.cost ?? s.amount ?? 0), 0);
  }
  return 0;
}

function getRecordStatus(ycr) {
  if (ycr.status_id !== undefined && ycr.status_id !== null) {
    const sid = parseInt(ycr.status_id);
    if (sid === 4) return 'completed';
    if (sid === 3) return 'arrived';
    if (sid === 2) return 'confirmed';
    if (sid === 5) return 'cancelled';
    if (sid === 6) return 'no_show';
    if (sid === 7) return 'deleted';
    return 'waiting';
  }
  if (ycr.deleted) return 'deleted';
  const att = ycr.attendance !== undefined ? parseInt(ycr.attendance) : undefined;
  if (att === 1) return 'arrived';
  if (att === 2) return 'confirmed';
  if (att === -1) return 'no_show';
  if (att === 0) return 'waiting';
  if (ycr.visit_attendance === 1) return 'completed';
  if (ycr.confirmed === 1) return 'confirmed';
  return 'waiting';
}

async function processCompletedRecord(recordId, clientId, ycRec, salonId, settings) {
  const pg = await pool.connect();
  try {
    await pg.query('BEGIN');
    const client = (await pg.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId])).rows[0];
    if (!client) { await pg.query('ROLLBACK'); return 0; }

    const cost     = getRecordCost(ycRec);
    const newSpent = parseFloat(client.total_spent || 0) + cost;
    const level    = getLevel(newSpent, settings.levels);
    const svcIds   = (ycRec.services || []).map(s => s.id);
    const { pct, bonus } = calcBonus(cost, svcIds, level, settings.service_cashback);
    const accrual  = settings.bonuses_enabled === false ? 0 : bonus;

    await pg.query(
      `UPDATE clients SET
         bonus_balance = bonus_balance + $1,
         total_spent   = total_spent + $2,
         visits_count  = visits_count + 1,
         loyalty_level = $3,
         last_visit_at = $4,
         updated_at    = NOW()
       WHERE id = $5`,
      [accrual, cost, level.key, ycRec.date || new Date(), clientId]
    );

    if (accrual > 0) {
      await pg.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,
            balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,
           (SELECT yclients_card_id FROM clients WHERE id=$3),
           'accrual',$4,$5,$6,$7,NOW(),NOW())`,
        [salonId, clientId, clientId, accrual,
         client.bonus_balance + accrual,
         `Кэшбэк ${pct}% за визит ${String(ycRec.date || '').split(' ')[0]}`,
         recordId]
      );
    }

    await pg.query(
      'UPDATE records SET bonus_accrued=$1,cashback_pct=$2,bonus_processed=TRUE WHERE id=$3',
      [accrual, accrual > 0 ? pct : 0, recordId]
    );

    await pg.query('COMMIT');
    return accrual;
  } catch (e) {
    await pg.query('ROLLBACK');
    logger.error(`processRecord: ${e.message}`);
    return 0;
  } finally {
    pg.release();
  }
}

async function cancelRecordBonuses(recordId, clientId, salonId) {
  const record = await db.oneOrNone('SELECT * FROM records WHERE id=$1', [recordId]);
  if (!record?.bonus_accrued || record.bonus_accrued <= 0) return;
  const client = await db.oneOrNone('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!client) return;
  const deduct = Math.min(record.bonus_accrued, client.bonus_balance);
  await db.query('UPDATE clients SET bonus_balance=bonus_balance-$1,updated_at=NOW() WHERE id=$2', [deduct, clientId]);
  await db.query(
    `INSERT INTO loyalty_card_transactions
       (salon_id,client_id,yclients_card_id,type,amount,
        balance_after,title,record_id,txn_date,created_at)
     VALUES ($1,$2,
       (SELECT yclients_card_id FROM clients WHERE id=$3),
       'redemption',$4,$5,$6,$7,NOW(),NOW())`,
    [salonId, clientId, clientId, -deduct,
     client.bonus_balance - deduct,
     'Отмена начисления', recordId]
  );
  await db.query(
    'UPDATE records SET bonus_processed=FALSE,bonus_accrued=0,status=$1 WHERE id=$2',
    ['cancelled', recordId]
  );
}

async function runSync(salon, syncType, userId) {
  const log = await db.one(
    `INSERT INTO sync_logs (salon_id,sync_type,status,initiated_by)
     VALUES ($1,$2,'running',$3) RETURNING id`,
    [salon.id, syncType, userId || null]
  );
  let cs = 0, rs = 0, ba = 0, nc = 0;

  try {
    const settings = await getLoyaltySettings(salon.id);
    const endDate   = new Date().toISOString().split('T')[0];
    const syncDays  = parseInt(process.env.SYNC_DAYS || '730');
    const startDate = new Date(Date.now() - syncDays * 86400000).toISOString().split('T')[0];
    logger.info(`── Step 1: Fetching ALL records ${startDate} → ${endDate} ──`);

    let allRecs = [], rPage = 1;
    for (;;) {
      let chunk = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          chunk = await ycGet(salon, `/records/${salon.yclients_company_id}`, {
            start_date: startDate, end_date: endDate, page: rPage, count: 200
          });
          break;
        } catch (e) {
          logger.info(`Records page ${rPage} attempt ${attempt} failed: ${e.message}`);
          if (attempt < 3) await sleep(3000 * attempt);
          else throw e;
        }
      }
      if (!chunk?.length) break;
      allRecs = allRecs.concat(chunk);
      logger.info(`Records page ${rPage}: ${chunk.length} (total: ${allRecs.length})`);
      if (chunk.length < 200) break;
      rPage++;
      await sleep(300);
    }
    logger.info(`Total records fetched: ${allRecs.length}`);

    if (allRecs.length > 0) {
      const sample = allRecs[0];
      logger.info(`Sample record keys: ${Object.keys(sample).join(', ')}`);
      logger.info(`Sample record status fields: status_id=${sample.status_id} attendance=${sample.attendance} visit_attendance=${sample.visit_attendance} deleted=${sample.deleted} confirmed=${sample.confirmed}`);
      logger.info(`Sample record → getRecordStatus = "${getRecordStatus(sample)}" | date="${sample.date}" cost=${sample.cost} computed_cost=${getRecordCost(sample)} services=${Array.isArray(sample.services)?sample.services.length:'none'}`);
    }

    const recordsByClient = {};
    const orphanRecords = [];
    for (const rec of allRecs) {
      const cid = rec.client?.id;
      if (cid) {
        if (!recordsByClient[cid]) recordsByClient[cid] = [];
        recordsByClient[cid].push(rec);
      } else {
        orphanRecords.push(rec);
      }
    }
    logger.info(`Records indexed: ${Object.keys(recordsByClient).length} clients, ${orphanRecords.length} without client`);
    await sleep(2000);

    logger.info(`── Step 2: Collecting client IDs ──`);
    let page = 1, allIds = [];
    for (;;) {
      let chunk = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ids = await ycPost(salon, `/company/${salon.yclients_company_id}/clients/search`, {
            page, count: 25, filters: []
          });
          chunk = Array.isArray(ids) ? ids : [];
          break;
        } catch (e) {
          logger.info(`Client IDs page ${page} attempt ${attempt} failed: ${e.message}`);
          if (attempt < 3) await sleep(3000 * attempt);
          else throw e;
        }
      }
      if (!chunk.length) break;
      allIds = allIds.concat(chunk.map(i => i.id));
      if (chunk.length < 25) break;
      page++;
      await sleep(300);
    }
    logger.info(`Total client IDs: ${allIds.length}`);

    logger.info(`── Step 3: Processing clients one-by-one ──`);
    let retryCount = 0;
    const MAX_RETRIES = 3;

    for (let idx = 0; idx < allIds.length; idx++) {
      const ycClientId = allIds[idx];
      await sleep(400);

      try {
        const ycc = await ycGet(salon, `/client/${salon.yclients_company_id}/${ycClientId}`);
        if (!ycc) continue;

        const fullName = [ycc.name, ycc.surname, ycc.patronymic]
          .filter(Boolean).join(' ').trim() || ycc.display_name || ycc.phone || 'Клиент';
        const phone        = ycc.phone || null;
        const totalSpent   = parseFloat(ycc.spent || ycc.paid || 0);
        const visitsCount  = parseInt(ycc.visits || 0);
        const lastVisitAt  = ycc.last_change_date ? new Date(ycc.last_change_date) : null;

        const ex = await db.oneOrNone(
          'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, ycc.id]
        );
        let dbClientId;
        if (ex) {
          dbClientId = ex.id;
          await db.query(
            `UPDATE clients SET
               name=$1, phone=$2, email=$3, birthday=$4, yclients_data=$5,
               total_spent=$6, visits_count=$7, last_visit_at=$8,
               synced_at=NOW(), updated_at=NOW()
             WHERE id=$9`,
            [fullName, phone, ycc.email||null, ycc.birth_date||null, JSON.stringify(ycc),
             totalSpent, visitsCount, lastVisitAt, ex.id]
          );
        } else {
          const ins = await db.one(
            `INSERT INTO clients
               (salon_id, yclients_client_id, name, phone, email, birthday,
                total_spent, visits_count, last_visit_at, yclients_data, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
             ON CONFLICT (salon_id, yclients_client_id) DO UPDATE SET synced_at=NOW()
             RETURNING id`,
            [salon.id, ycc.id, fullName, phone, ycc.email||null, ycc.birth_date||null,
             totalSpent, visitsCount, lastVisitAt, JSON.stringify(ycc)]
          );
          dbClientId = ins?.id;
          if (!dbClientId) {
            const found = await db.oneOrNone('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, ycc.id]);
            dbClientId = found?.id;
          }
          nc++;
        }
        cs++;

        if (salon.yclients_card_type_id && dbClientId) {
          try {
            const cards = await ycGetClientCards(salon, ycc.id);
            const card = cards.find(c => c.type?.id === salon.yclients_card_type_id
                                      || String(c.type?.id) === String(salon.yclients_card_type_id));
            if (card) {
              const cardBalance = parseFloat(card.balance || 0);
              const paidAmount  = parseFloat(card.paid_amount || card.sold_amount || totalSpent || 0);
              await db.query(
                `UPDATE clients SET
                   yclients_card_id=$1, yclients_card_number=$2, yclients_card_balance=$3,
                   bonus_balance=$4, updated_at=NOW()
                 WHERE id=$5`,
                [card.id, card.number || card.loyalty_card_number || null,
                 cardBalance, cardBalance, dbClientId]
              );
              if (settings?.levels && paidAmount > 0) {
                const lvl = getLevel(paidAmount, settings.levels);
                await db.query('UPDATE clients SET loyalty_level=$1 WHERE id=$2', [lvl.key, dbClientId]);
              }
            }
          } catch (cardErr) { /* not critical */ }
        }

        const clientRecords = recordsByClient[ycc.id] || [];
        let clientRecs = 0, clientBonus = 0;

        for (const ycr of clientRecords) {
          const status = getRecordStatus(ycr);
          const exRec = await db.oneOrNone(
            'SELECT id,status,bonus_processed FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
            [salon.id, ycr.id]
          );

          if (exRec) {
            const recCost = getRecordCost(ycr);
            await db.query(
              `UPDATE records SET status=$1, raw_payload=$2, amount=$3,
               visit_datetime=$4, visit_date=$5,
               services=$6, staff=$7, client_id=$8, updated_at=NOW() WHERE id=$9`,
              [status, JSON.stringify(ycr), recCost,
               ycr.date || null,
               String(ycr.date || '').split(' ')[0] || null,
               JSON.stringify(ycr.services || []), JSON.stringify(ycr.staff || []),
               dbClientId, exRec.id]
            );
            if (status === 'completed' && !exRec.bonus_processed
                && dbClientId && settings && recCost > 0) {
              clientBonus += await processCompletedRecord(exRec.id, dbClientId, ycr, salon.id, settings);
            }
            if (status === 'cancelled' && exRec.bonus_processed && dbClientId) {
              await cancelRecordBonuses(exRec.id, dbClientId, salon.id);
            }
          } else {
            const recCost = getRecordCost(ycr);
            const ins = await db.one(
              `INSERT INTO records
                 (salon_id,yclients_record_id,client_id,yclients_client_id,
                  visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync',$11) RETURNING id`,
              [salon.id, ycr.id, dbClientId || null, ycr.client?.id || null,
               String(ycr.date || '').split(' ')[0] || null, ycr.date || null,
               recCost, JSON.stringify(ycr.services || []),
               JSON.stringify(ycr.staff || []), status, JSON.stringify(ycr)]
            );
            if (ins && status === 'completed' && dbClientId && settings && recCost > 0) {
              clientBonus += await processCompletedRecord(ins.id, dbClientId, ycr, salon.id, settings);
            }
            clientRecs++;
          }
        }

        rs += clientRecs;
        ba += clientBonus;

        if (dbClientId) {
          await db.query(`
            UPDATE loyalty_card_transactions lct
            SET record_id = sub.record_id
            FROM (
              SELECT DISTINCT ON (lct2.id)
                     lct2.id AS txn_id,
                     r.id    AS record_id
              FROM   loyalty_card_transactions lct2
              JOIN   records r
                ON   r.client_id  = lct2.client_id
                AND  r.salon_id   = lct2.salon_id
                AND  r.visit_date  = lct2.txn_date::date
              WHERE  lct2.client_id  = $1
                AND  lct2.record_id  IS NULL
                AND  lct2.txn_date   IS NOT NULL
                AND  r.visit_date    IS NOT NULL
                AND  r.status        IN ('completed','confirmed')
              ORDER BY lct2.id, r.visit_datetime DESC
            ) sub
            WHERE lct.id = sub.txn_id
          `, [dbClientId]);
        }

        retryCount = 0;
        if (cs % 25 === 0 || clientRecs > 0 || clientBonus > 0) {
          logger.info(`${cs}/${allIds.length} ${fullName}: records=${clientRecs} bonus=${clientBonus} (total: r=${rs} b=${ba})`);
        }

      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('429')) {
          logger.warn(`429 rate limit, waiting 10s...`);
          await sleep(10000);
          if (retryCount < MAX_RETRIES) { retryCount++; idx--; } else { retryCount = 0; logger.warn(`Max retries for ${ycClientId}, skipping`); }
        } else if (msg.includes('socket hang up') || msg.includes('ECONNRESET')
                || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
          logger.warn(`Network error for ${ycClientId}: ${msg}, retrying in 5s...`);
          await sleep(5000);
          if (retryCount < MAX_RETRIES) { retryCount++; idx--; } else { retryCount = 0; logger.warn(`Max retries for ${ycClientId}, skipping`); }
        } else {
          retryCount = 0;
          logger.info(`Skip client ${ycClientId}: ${msg}`);
        }
      }
    }

    if (orphanRecords.length > 0) {
      logger.info(`Processing ${orphanRecords.length} orphan records (no client)...`);
      for (const ycr of orphanRecords) {
        const status = getRecordStatus(ycr);
        const recCost = getRecordCost(ycr);
        const exRec = await db.oneOrNone(
          'SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
          [salon.id, ycr.id]
        );
        if (exRec) {
          await db.query(
            `UPDATE records SET status=$1, raw_payload=$2, amount=$3,
             services=$4, staff=$5, updated_at=NOW() WHERE id=$6`,
            [status, JSON.stringify(ycr), recCost,
             JSON.stringify(ycr.services || []), JSON.stringify(ycr.staff || []), exRec.id]
          );
        } else {
          await db.query(
            `INSERT INTO records
               (salon_id,yclients_record_id,client_id,yclients_client_id,
                visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
             VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,'sync',$10)`,
            [salon.id, ycr.id, ycr.client?.id || null,
             String(ycr.date || '').split(' ')[0] || null, ycr.date || null,
             recCost, JSON.stringify(ycr.services || []),
             JSON.stringify(ycr.staff || []), status, JSON.stringify(ycr)]
          );
          rs++;
        }
      }
    }

    logger.info('Updating last_visit_at from records...');
    await db.query(`
      UPDATE clients c
      SET last_visit_at = sub.last_visit, updated_at = NOW()
      FROM (
        SELECT client_id, MAX(visit_datetime) AS last_visit
        FROM   records
        WHERE  salon_id = $1 AND status = 'completed' AND client_id IS NOT NULL
        GROUP  BY client_id
      ) sub
      WHERE c.id = sub.client_id AND c.salon_id = $1
    `, [salon.id]);

    await db.query(
      `UPDATE sync_logs SET status='success',clients_synced=$1,records_synced=$2,
       bonuses_accrued=$3,new_clients=$4,finished_at=NOW() WHERE id=$5`,
      [cs, rs, ba, nc, log.id]
    );
    logger.info(`✓ Done: clients=${cs} records=${rs} bonuses=${ba} new=${nc}`);
    return { ok: true, clientsSynced: cs, recordsSynced: rs, bonusesAccrued: ba, newClients: nc };

  } catch (e) {
    await db.query(
      `UPDATE sync_logs SET status='error',error_message=$1,finished_at=NOW() WHERE id=$2`,
      [e.message, log.id]
    );
    throw e;
  }
}

async function claimRecordProcessing(salonId, ycRecordId, clientId) {
  const r = await db.query(
    `INSERT INTO finances_log (salon_id, yclients_record_id, client_id, event_status, cashback_amount, processed)
     VALUES ($1, $2, $3, 'create', -1, FALSE)
     ON CONFLICT (yclients_record_id) DO NOTHING`,
    [salonId, ycRecordId, clientId]
  );
  return r.rowCount === 1;
}

async function popCashbackAmount(ycRecordId) {
  const r = await db.query(
    `DELETE FROM finances_log WHERE yclients_record_id=$1 RETURNING cashback_amount, client_id, salon_id`,
    [ycRecordId]
  );
  if (!r.rows.length) return null;
  return r.rows[0];
}

async function getCashbackByRecord(ycRecordId) {
  return db.oneOrNone(`SELECT cashback_amount FROM finances_log WHERE yclients_record_id=$1`, [ycRecordId]);
}

async function revertCashback(ycRecordId, salon, clientYcId) {
  const popped = await popCashbackAmount(ycRecordId);
  if (!popped) { logger.info(`nothing to revert for record=${ycRecordId}`); return; }
  const cashbackAmount = parseFloat(popped.cashback_amount);
  if (cashbackAmount <= 0) { logger.info(`skip revert record=${ycRecordId} amount=${cashbackAmount}`); return; }

  const client = await db.oneOrNone(
    'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
    [salon.id, clientYcId]
  );
  if (!client) { logger.info(`client not found yclients_id=${clientYcId}`); return; }

  const deduct = Math.min(cashbackAmount, parseFloat(client.bonus_balance || 0));
  if (client.yclients_card_id && deduct > 0) {
    try {
      await ycAccrueCard(salon, client.yclients_card_id, -deduct,
        `Отмена кэшбэка по записи #${ycRecordId}`);
    } catch (e) { logger.error(`Revert card deduct error: ${e.message}`); }
  }

  await db.query(
    'UPDATE clients SET bonus_balance=GREATEST(0,bonus_balance-$1),updated_at=NOW() WHERE id=$2',
    [deduct, client.id]
  );

  const dbRecord = await db.oneOrNone('SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);
  await db.query(
    `INSERT INTO loyalty_card_transactions
       (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
     VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),'redemption',$4,$5,$6,$7,NOW(),NOW())`,
    [salon.id, client.id, client.id, -deduct,
     Math.max(0, client.bonus_balance - deduct),
     `Отмена кэшбэка за визит #${ycRecordId}`,
     dbRecord?.id || ycRecordId]
  );
  logger.info(`reverted ${deduct} for client ${client.name}, record #${ycRecordId}`);
}

async function processRecordEvent(payload, salon, settings) {
  const data = payload.data || {};
  const status = payload.status;
  const ycRecordId = data.id;
  const clientYcId = data.client?.id;

  if (!ycRecordId || !clientYcId) return;

  const recStatus = getRecordStatus(data);
  let client = await db.oneOrNone(
    'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
    [salon.id, clientYcId]
  );

  if (!client) {
    await db.query(
      `INSERT INTO clients (salon_id,yclients_client_id,name,phone,synced_at)
       VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT DO NOTHING`,
      [salon.id, clientYcId, data.client?.name || 'Клиент', data.client?.phone || null]
    );
    client = await db.oneOrNone('SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, clientYcId]);
  }

  let record = await db.oneOrNone('SELECT * FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);
  if (!record) {
    record = await db.one(
      `INSERT INTO records
         (salon_id,yclients_record_id,client_id,yclients_client_id,
          visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'webhook',$11) RETURNING *`,
      [salon.id, ycRecordId, client?.id||null, clientYcId,
       String(data.date||'').split(' ')[0]||null, data.date||null,
       getRecordCost(data), JSON.stringify(data.services||[]),
       JSON.stringify(data.staff||[]), recStatus, JSON.stringify(data)]
    );
  } else {
    await db.query(
      'UPDATE records SET status=$1,raw_payload=$2,amount=$3,updated_at=NOW() WHERE id=$4',
      [recStatus, JSON.stringify(data), getRecordCost(data), record.id]
    );
  }

  if (status === 'delete' || data.deleted === true) {
    await revertCashback(ycRecordId, salon, clientYcId);
    return;
  }

  if (data.paid_full !== 1 || (data.attendance !== 1 && data.attendance !== 2)) {
    logger.info(`skip accrual record=${ycRecordId} paid_full=${data.paid_full} attendance=${data.attendance}`);
    return;
  }

  const claimed = await claimRecordProcessing(salon.id, ycRecordId, client?.id);
  if (!claimed) {
    // Record already processed — on update events re-check if discount appeared and revert cashback if needed
    const existing = await getCashbackByRecord(ycRecordId);
    const alreadyGiven = parseFloat(existing?.cashback_amount || 0);
    if (alreadyGiven > 0) {
      let services = data.services || [];
      if (!services.length) {
        try {
          const ycRecord = await ycGet(salon, `/record/${salon.yclients_company_id}/${ycRecordId}`);
          services = ycRecord.services || [];
        } catch(e) { /* ignore */ }
      }
      const hasDiscountNow = services.some(s => parseFloat(s.discount||0) > 0 || parseFloat(s.cost_to_pay ?? s.cost ?? 0) < parseFloat(s.cost||0));
      // Only check redemption tied to this specific record (not date-based — too broad)
      const hasRedemption = await db.oneOrNone(
        `SELECT 1 FROM loyalty_card_transactions WHERE client_id=$1 AND amount<0 AND record_id=$2 LIMIT 1`,
        [client?.id, record?.id]
      );
      if (hasDiscountNow || hasRedemption) {
        logger.info(`update detected discount/redemption — reverting cashback record=${ycRecordId}`);
        await revertCashback(ycRecordId, salon, clientYcId);
      }
    } else if (existing && existing.cashback_amount === 0) {
      // Previous attempt denied — delete stale lock so this event can be re-evaluated
      await db.query('DELETE FROM finances_log WHERE yclients_record_id=$1', [ycRecordId]);
      logger.info(`retry: removed stale denial lock for record=${ycRecordId}`);
      // Re-claim so we fall through to accrual logic below
      const reClaimed = await claimRecordProcessing(salon.id, ycRecordId, client?.id);
      if (!reClaimed) { logger.info(`retry claim failed record=${ycRecordId}`); return; }
    } else {
      logger.info(`duplicate record=${ycRecordId} existing_cashback=${existing?.cashback_amount}`);
      return;
    }
  }

  try {
    let services = data.services || [];
    if (!services.length) {
      try {
        const ycRecord = await ycGet(salon, `/record/${salon.yclients_company_id}/${ycRecordId}`);
        services = ycRecord.services || [];
      } catch(e) { logger.info(`ycGet failed: ${e.message}`); }
    }

    // Check for redemption tied specifically to this record (date-based match is too broad)
    const hasRedemptionTx = await db.oneOrNone(
      `SELECT 1 FROM loyalty_card_transactions WHERE client_id=$1 AND amount<0 AND record_id=$2 LIMIT 1`,
      [client?.id, record?.id]
    );

    let paidAmount = 0;
    let hasDiscount = false;
    for (const s of services) {
      const cost    = parseFloat(s.cost || 0);
      const costPay = parseFloat(s.cost_to_pay ?? cost);
      const disc    = parseFloat(s.discount || 0);
      if (disc > 0 || costPay < cost) { hasDiscount = true; break; }
      paidAmount += costPay;
    }

    // Fallback: if services array is empty (missing from payload and ycGet failed),
    // use the record-level cost so we don't silently deny a full-price visit
    if (!hasDiscount && paidAmount === 0 && services.length === 0) {
      paidAmount = getRecordCost(data);
      logger.info(`record=${ycRecordId} services unavailable — using record-level cost=${paidAmount}`);
    }

    logger.info(`record=${ycRecordId} hasDiscount=${hasDiscount} hasRedemption=${!!hasRedemptionTx} paidAmount=${paidAmount}`);

    if (hasDiscount || hasRedemptionTx || paidAmount <= 0) {
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=TRUE WHERE yclients_record_id=$1', [ycRecordId]);
      logger.info(`denied record=${ycRecordId} (hasDiscount=${hasDiscount} hasRedemption=${!!hasRedemptionTx} paidAmount=${paidAmount})`);
      return;
    }

    if (settings && settings.bonuses_enabled === false) {
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=FALSE WHERE yclients_record_id=$1', [ycRecordId]);
      logger.info(`bonuses DISABLED — logged only for record=${ycRecordId}`);
      return;
    }

    const level = getLevel(parseFloat(client.total_spent || 0), settings.levels);
    const { pct, bonus: cashback } = calcBonus(paidAmount, services.map(s=>s.id), level, settings.service_cashback);

    if (cashback <= 0) {
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=TRUE WHERE yclients_record_id=$1', [ycRecordId]);
      return;
    }

    if (client.yclients_card_id && salon.yclients_card_type_id) {
      try {
        await ycAccrueCard(salon, client.yclients_card_id, cashback, `Кэшбэк ${pct}% по записи #${ycRecordId}`);
      } catch(e) { logger.error(`Card accrual error: ${e.message}`); }
    }

    await db.query(
      `UPDATE clients SET bonus_balance=bonus_balance+$1, total_spent=total_spent+$2,
       visits_count=visits_count+1, loyalty_level=$3, last_visit_at=$4, updated_at=NOW() WHERE id=$5`,
      [cashback, paidAmount, level.key, data.date || new Date(), client.id]
    );

    await db.query(
      `INSERT INTO loyalty_card_transactions
         (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
       VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),'accrual',$4,$5,$6,$7,NOW(),NOW())`,
      [salon.id, client.id, client.id, cashback,
       client.bonus_balance + cashback,
       `Кэшбэк ${pct}% за визит #${ycRecordId}`, record.id]
    );

    await db.query(
      'UPDATE finances_log SET cashback_amount=$1, cashback_pct=$2, paid_amount=$3, processed=TRUE WHERE yclients_record_id=$4',
      [cashback, pct, paidAmount, ycRecordId]
    );
    logger.info(`Accrued ${cashback} (${pct}%) for client ${client.name}, record #${ycRecordId}`);

  } catch(e) {
    await db.query('DELETE FROM finances_log WHERE yclients_record_id=$1 AND cashback_amount=-1', [ycRecordId]);
    throw e;
  }
}

async function processFinancesOperation(payload, salon) {
  const status = payload.status;
  const data = payload.data || {};
  const ycRecordId = data.record_id || data.record?.id;
  const clientYcId = data.client?.id;

  if (!ycRecordId || !clientYcId) return;
  logger.info(`FinOp status=${status} clientYcId=${clientYcId} ycRecordId=${ycRecordId}`);

  if (status === 'delete') {
    await revertCashback(ycRecordId, salon, clientYcId);
    const client = await db.one(
      'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    if (!client || !client.yclients_card_id) return;
    try {
      const cards = await ycGetClientCards(salon, clientYcId);
      const card = cards.find(c => String(c.id) === String(client.yclients_card_id));
      if (!card) return;
      const newBalance = parseFloat(card.balance || 0);
      const oldBalance = parseFloat(client.bonus_balance || 0);
      const delta = newBalance - oldBalance;
      logger.info(`FinOp delete: card balance old=${oldBalance} new=${newBalance} delta=${delta}`);
      if (Math.abs(delta) < 1) return;
      await db.query(
        'UPDATE clients SET bonus_balance=$1::numeric, yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2',
        [newBalance, client.id]
      );
      const dbRecord = await db.oneOrNone('SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);
      const txnType = delta >= 0 ? 'accrual' : 'redemption';
      await db.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [salon.id, client.id, client.yclients_card_id, txnType, delta, newBalance,
         delta > 0 ? `Возврат бонусов при отмене оплаты визита #${ycRecordId}` : `Списание бонусов при отмене визита #${ycRecordId}`,
         dbRecord?.id || null]
      );
      logger.info(`FinOp delete: synced balance ${oldBalance} → ${newBalance} for client ${client.name}`);
    } catch(e) { logger.error(`FinOp delete: card sync error: ${e.message}`); }
    return;
  }

  if (status === 'create') {
    const client = await db.one(
      'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    if (!client || !client.yclients_card_id) { logger.info(`FinOp create: no client or card`); return; }
    try {
      const cards = await ycGetClientCards(salon, clientYcId);
      const card = cards.find(c => String(c.id) === String(client.yclients_card_id));
      if (!card) { logger.info(`FinOp create: card not found`); return; }
      const newBalance = parseFloat(card.balance || 0);
      const oldBalance = parseFloat(client.bonus_balance || 0);
      const delta = newBalance - oldBalance;
      logger.info(`FinOp create: card balance old=${oldBalance} new=${newBalance} delta=${delta}`);
      if (Math.abs(delta) < 1) { logger.info(`FinOp create: balance unchanged, skip`); return; }

      const dbRecord = await db.oneOrNone('SELECT id, raw_payload FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);

      // If delta > 0 (accrual), check if visit has any manual discount — if so, skip accrual per business rules
      if (delta > 0) {
        const services = dbRecord?.raw_payload?.services || [];
        const hasDiscount = services.some(s => parseFloat(s.discount || 0) > 0 || parseFloat(s.cost_to_pay ?? s.cost ?? 0) < parseFloat(s.cost || 0));
        if (hasDiscount) {
          logger.info(`FinOp create: record=${ycRecordId} has manual discount — skipping accrual sync (delta=${delta})`);
          return;
        }
      }

      await db.query(
        'UPDATE clients SET bonus_balance=$1::numeric, yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2',
        [newBalance, client.id]
      );
      const txnType = delta >= 0 ? 'accrual' : 'redemption';
      await db.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [salon.id, client.id, client.yclients_card_id, txnType, delta, newBalance,
         delta < 0 ? `Списание бонусов при оплате визита #${ycRecordId}` : `Начисление бонусов (YClients) #${ycRecordId}`,
         dbRecord?.id || null]
      );
      logger.info(`FinOp create: synced balance ${oldBalance} → ${newBalance} for client ${client.name}`);
    } catch(e) { logger.error(`FinOp create: card sync error: ${e.message}`); }
    return;
  }

  logger.info(`FinOp status=${status} — ignored`);
}

module.exports = {
  sleep,
  getLoyaltySettings, getLevel, calcBonus, getRecordCost, getRecordStatus,
  processCompletedRecord, cancelRecordBonuses,
  runSync,
  claimRecordProcessing, popCashbackAmount, getCashbackByRecord, revertCashback,
  processRecordEvent, processFinancesOperation,
};
