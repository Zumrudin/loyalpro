// ============================================================
// LoyalPro — Backend Server v4.0
// ============================================================
require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const axios    = require('axios');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── DB helpers ────────────────────────────────────────────────
const db = {
  query: (sql, p) => pool.query(sql, p),
  one:   async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many:  async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

// ── Auth middleware ───────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'loyalpro_dev_secret_change_in_production';

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// ── YClients API ──────────────────────────────────────────────
const YC = 'https://api.yclients.com/api/v1';

function ycHeaders(salon) {
  return {
    'Accept': 'application/vnd.yclients.v2+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${salon.yclients_partner_token}, User ${salon.yclients_user_token}`,
  };
}

async function ycGet(salon, endpoint, params = {}) {
  const url = new URL(`${YC}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const { data } = await axios.get(url.toString(), { headers: ycHeaders(salon), timeout: 30000 });
  if (!data.success) throw new Error(data.meta?.message || 'YClients API error');
  return data.data;
}

async function ycPost(salon, endpoint, body = {}) {
  const { data } = await axios.post(`${YC}${endpoint}`, body, {
    headers: ycHeaders(salon), timeout: 30000
  });
  if (!data.success) throw new Error(data.meta?.message || 'YClients API error');
  return data.data;
}

async function ycAuth(partnerToken, login, password) {
  const { data } = await axios.post(`${YC}/auth`,
    { login, password, application_id: partnerToken },
    { headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.yclients.v2+json',
        'Authorization': `Bearer ${partnerToken}`
      }, timeout: 15000 }
  );
  if (!data.success) throw new Error(data.meta?.message || 'Неверный логин или пароль');
  return data.data;
}

// ── YClients Loyalty Card API ─────────────────────────────────

// Получить типы карт лояльности компании
async function ycGetCardTypes(salon) {
  const { data } = await axios.get(
    `${YC}/loyalty/card_types/salon/${salon.yclients_company_id}`,
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) return [];
  return data.data || [];
}

// Получить карты клиента
async function ycGetClientCards(salon, yclClientsId) {
  try {
    const { data } = await axios.get(
      `${YC}/loyalty/client_cards/${yclClientsId}`,
      { headers: ycHeaders(salon), timeout: 15000 }
    );
    console.log(`[Cards] client=${yclClientsId} success=${data.success} count=${Array.isArray(data.data)?data.data.length:'n/a'}`);
    if (Array.isArray(data.data) && data.data.length > 0) {
      console.log(`[Cards] first card keys:`, Object.keys(data.data[0]).join(','));
      console.log(`[Cards] first card sample:`, JSON.stringify(data.data[0]).slice(0,400));
    }
    if (!data.success) return [];
    return data.data || [];
  } catch (e) {
    console.error(`[Cards] error for client ${yclClientsId}:`, e.message);
    return [];
  }
}

// Получить транзакции по карте — пробуем несколько вариантов endpoint
async function ycGetCardTransactions(salon, cardId, page = 1, count = 200) {
  const endpoints = [
    `${YC}/company/${salon.yclients_company_id}/loyalty/cards/${cardId}/transactions`,
    `${YC}/loyalty/cards/${cardId}/transactions`,
    `${YC}/loyalty/client_card_transactions/${cardId}`,
    `${YC}/company/${salon.yclients_company_id}/loyalty/card_transactions/${cardId}`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url,
        { headers: ycHeaders(salon), params: { page, count }, timeout: 15000 }
      );
      console.log(`[CardTxns] url=${url} success=${data.success} count=${Array.isArray(data.data)?data.data.length:'n/a'}`);
      if (data.success) {
        if (Array.isArray(data.data) && data.data.length > 0) {
          console.log(`[CardTxns] ✓ WORKS! keys:`, Object.keys(data.data[0]).join(','));
          console.log(`[CardTxns] sample:`, JSON.stringify(data.data[0]).slice(0,400));
        } else {
          console.log(`[CardTxns] success but empty. raw:`, JSON.stringify(data).slice(0,200));
        }
        return data.data || [];
      }
    } catch (e) {
      console.log(`[CardTxns] ${url} → ${e.response?.status||e.message}`);
    }
  }

  console.log(`[CardTxns] All endpoints failed for card ${cardId}`);
  return [];
}

// Начислить/списать бонусы на карту
async function ycAccrueCard(salon, cardId, amount, title) {
  const { data } = await axios.post(
    `${YC}/company/${salon.yclients_company_id}/loyalty/cards/${cardId}/manual_transaction`,
    { amount, title },
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) throw new Error(data.meta?.message || 'Card transaction failed');
  return data.data;
}


const sleep = ms => new Promise(r => setTimeout(r, ms));
// ── Loyalty helpers ───────────────────────────────────────────
async function getLoyaltySettings(salonId) {
  const row = await db.one('SELECT * FROM loyalty_settings WHERE salon_id=$1', [salonId]);
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

// ── Process completed visit ───────────────────────────────────
async function processCompletedRecord(recordId, clientId, ycRec, salonId, settings) {
  const pg = await pool.connect();
  try {
    await pg.query('BEGIN');
    const client = (await pg.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId])).rows[0];
    if (!client) { await pg.query('ROLLBACK'); return 0; }

    const cost     = parseFloat(ycRec.cost || 0);
    const newSpent = parseFloat(client.total_spent || 0) + cost;
    const level    = getLevel(newSpent, settings.levels);
    const svcIds   = (ycRec.services || []).map(s => s.id);
    const { pct, bonus } = calcBonus(cost, svcIds, level, settings.service_cashback);

    await pg.query(
      `UPDATE clients SET
         bonus_balance = bonus_balance + $1,
         total_spent   = total_spent + $2,
         visits_count  = visits_count + 1,
         loyalty_level = $3,
         last_visit_at = $4,
         updated_at    = NOW()
       WHERE id = $5`,
      [bonus, cost, level.key, ycRec.date || new Date(), clientId]
    );

    await pg.query(
      `INSERT INTO bonus_transactions
         (salon_id,client_id,record_id,type,amount,balance_before,balance_after,
          visit_amount,cashback_pct,description,created_at)
       VALUES ($1,$2,$3,'accrual',$4,$5,$6,$7,$8,$9,NOW())`,
      [salonId, clientId, recordId, bonus,
       client.bonus_balance, client.bonus_balance + bonus,
       cost, pct, `Начисление за визит ${String(ycRec.date || '').split(' ')[0]}`]
    );

    await pg.query(
      'UPDATE records SET bonus_accrued=$1,cashback_pct=$2,bonus_processed=TRUE WHERE id=$3',
      [bonus, pct, recordId]
    );

    await pg.query('COMMIT');
    return bonus;
  } catch (e) {
    await pg.query('ROLLBACK');
    console.error('[processRecord]', e.message);
    return 0;
  } finally {
    pg.release();
  }
}

// ── Cancel bonuses on record cancellation ────────────────────
async function cancelRecordBonuses(recordId, clientId, salonId) {
  const record = await db.one('SELECT * FROM records WHERE id=$1', [recordId]);
  if (!record?.bonus_accrued || record.bonus_accrued <= 0) return;
  const client = await db.one('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!client) return;
  const deduct = Math.min(record.bonus_accrued, client.bonus_balance);
  await db.query('UPDATE clients SET bonus_balance=bonus_balance-$1,updated_at=NOW() WHERE id=$2', [deduct, clientId]);
  await db.query(
    `INSERT INTO bonus_transactions
       (salon_id,client_id,record_id,type,amount,balance_before,balance_after,description,created_at)
     VALUES ($1,$2,$3,'cancellation',$4,$5,$6,$7,NOW())`,
    [salonId, clientId, recordId, -deduct,
     client.bonus_balance, client.bonus_balance - deduct, 'Отмена начисления']
  );
  await db.query(
    'UPDATE records SET bonus_processed=FALSE,bonus_accrued=0,status=$1 WHERE id=$2',
    ['cancelled', recordId]
  );
}

// ── SYNC ──────────────────────────────────────────────────────
async function runSync(salon, syncType, userId) {
  const log = await db.one(
    `INSERT INTO sync_logs (salon_id,sync_type,status,initiated_by)
     VALUES ($1,$2,'running',$3) RETURNING id`,
    [salon.id, syncType, userId || null]
  );
  let cs = 0, rs = 0, ba = 0, nc = 0;

  try {
    // ── 1. Клиенты: сначала все ID, потом детали с задержкой ──
    let page = 1, allIds = [];

    // Шаг 1: собираем все ID (быстро, без лимитов)
    for (;;) {
      const ids = await ycPost(salon, `/company/${salon.yclients_company_id}/clients/search`, {
        page, count: 25, filters: []
      });
      const chunk = Array.isArray(ids) ? ids : [];
      const pageIds = chunk.map(i => i.id);
      console.log(`[Sync] IDs page ${page}: ${chunk.length} → ${pageIds.slice(0,3).join(',')}`);
      if (!chunk.length) break;
      allIds = allIds.concat(pageIds);
      if (chunk.length < 25) break;
      page++;
      await sleep(200);
    }
    console.log(`[Sync] Total IDs collected: ${allIds.length}`);

// Шаг 2: загружаем детали и сразу сохраняем в БД
    let allClients = [];
    for (let idx = 0; idx < allIds.length; idx++) {
      const clientId = allIds[idx];
      await sleep(400);
      try {
        const ycc = await ycGet(salon, `/client/${salon.yclients_company_id}/${clientId}`);
        if (!ycc) continue;
        allClients.push(ycc);

        // Сразу сохраняем в БД
        const fullName = [ycc.name, ycc.surname, ycc.patronymic]
          .filter(Boolean).join(' ').trim() || ycc.display_name || ycc.phone || 'Клиент';
        const phone        = ycc.phone || null;
        const totalSpent   = parseFloat(ycc.spent || ycc.paid || 0);
        const visitsCount  = parseInt(ycc.visits || 0);
        // last_change_date — дата последнего визита из YClients
        const lastVisitAt  = ycc.last_change_date ? new Date(ycc.last_change_date) : null;

        const ex = await db.one(
          'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, ycc.id]
        );
        if (ex) {
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
          await db.query(
            `INSERT INTO clients
               (salon_id, yclients_client_id, name, phone, email, birthday,
                total_spent, visits_count, last_visit_at, yclients_data, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
             ON CONFLICT DO NOTHING`,
            [salon.id, ycc.id, fullName, phone, ycc.email||null, ycc.birth_date||null,
             totalSpent, visitsCount, lastVisitAt, JSON.stringify(ycc)]
          );
          nc++;
        }
        cs++;
        if (cs % 25 === 0) console.log(`[Sync] Saved ${cs}/${allIds.length} clients to DB`);

        // ── Загружаем карту лояльности клиента ──
        if (salon.yclients_card_type_id) {
          try {
            const cards = await ycGetClientCards(salon, ycc.id);
            const card = cards.find(c => c.type?.id === salon.yclients_card_type_id
                                      || String(c.type?.id) === String(salon.yclients_card_type_id));
            if (card) {
              const dbClient = await db.one(
                'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
                [salon.id, ycc.id]
              );
              if (dbClient) {
                await db.query(
                  `UPDATE clients SET
                     yclients_card_id=$1, yclients_card_number=$2, yclients_card_balance=$3,
                     bonus_balance=$4, updated_at=NOW()
                   WHERE id=$5`,
                  [card.id, card.number || card.loyalty_card_number || null,
                   parseFloat(card.balance || 0), parseFloat(card.balance || 0), dbClient.id]
                );
                // Определяем уровень по сумме трат
                const lsData = await getLoyaltySettings(salon.id);
                if (lsData?.levels && totalSpent > 0) {
                  const lvl = getLevel(totalSpent, lsData.levels);
                  await db.query(
                    'UPDATE clients SET loyalty_level=$1 WHERE id=$2',
                    [lvl.key, dbClient.id]
                  );
                }
              }
            }
          } catch (cardErr) {
            // Не критично — пропускаем
          }
        }

      } catch (e) {
        if (e.message.includes('429')) {
          console.log(`[Sync] 429, waiting 10s...`);
          await sleep(10000);
          idx--; // повторить этого клиента
        } else {
          console.log(`[Sync] Skip ${clientId}: ${e.message}`);
        }
      }
    }
    console.log(`[Sync] Clients done: total=${cs} new=${nc}`);

    console.log(`[Sync] DB save done: ${cs} clients, ${nc} new`);

    // ── 2. Записи: последние 90 дней ──
    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const settings  = await getLoyaltySettings(salon.id);
    let allRecs = [], rPage = 1;

    for (;;) {
      const chunk = await ycGet(salon, `/records/${salon.yclients_company_id}`, {
        start_date: startDate, end_date: endDate, page: rPage, count: 200
      });
      if (!chunk?.length) break;
      allRecs = allRecs.concat(chunk);
      console.log(`[Sync] Records page ${rPage}: ${chunk.length} records`);
      if (chunk.length < 200) break;
      rPage++;
    }
    console.log(`[Sync] Total records: ${allRecs.length}`);

    for (const ycr of allRecs) {
      const status = ycr.status_id === 1 ? 'completed'
                   : ycr.status_id === 3 ? 'cancelled' : 'pending';
      const client = ycr.client?.id
        ? await db.one('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, ycr.client.id])
        : null;
      const ex = await db.one(
        'SELECT id,status,bonus_processed FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
        [salon.id, ycr.id]
      );

      if (ex) {
        if (ex.status !== status) {
          await db.query('UPDATE records SET status=$1,updated_at=NOW() WHERE id=$2', [status, ex.id]);
          if (status === 'completed' && !ex.bonus_processed && client && settings && parseFloat(ycr.cost || 0) > 0) {
            ba += await processCompletedRecord(ex.id, client.id, ycr, salon.id, settings);
          }
          if (status === 'cancelled' && ex.bonus_processed && client) {
            await cancelRecordBonuses(ex.id, client.id, salon.id);
          }
        }
      } else {
        const ins = await db.one(
          `INSERT INTO records
             (salon_id,yclients_record_id,client_id,yclients_client_id,
              visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync',$11) RETURNING id`,
          [salon.id, ycr.id, client?.id || null, ycr.client?.id || null,
           String(ycr.date || '').split(' ')[0] || null, ycr.date || null,
           ycr.cost || 0, JSON.stringify(ycr.services || []),
           JSON.stringify(ycr.staff || []), status, JSON.stringify(ycr)]
        );
        if (ins && status === 'completed' && client && settings && parseFloat(ycr.cost || 0) > 0) {
          ba += await processCompletedRecord(ins.id, client.id, ycr, salon.id, settings);
        }
        rs++;
      }
    }

    await db.query(
      `UPDATE sync_logs SET status='success',clients_synced=$1,records_synced=$2,
       bonuses_accrued=$3,new_clients=$4,finished_at=NOW() WHERE id=$5`,
      [cs, rs, ba, nc, log.id]
    );
    
    // ── 3. Обновляем last_visit_at из реальных записей ──
    console.log('[Sync] Updating last_visit_at from records...');
    await db.query(`
      UPDATE clients c
      SET last_visit_at = sub.last_visit,
          updated_at    = NOW()
      FROM (
        SELECT client_id,
               MAX(visit_datetime) AS last_visit
        FROM   records
        WHERE  salon_id = $1
          AND  status   = 'completed'
          AND  client_id IS NOT NULL
        GROUP  BY client_id
      ) sub
      WHERE c.id       = sub.client_id
        AND c.salon_id = $1
    `, [salon.id]);
    console.log('[Sync] last_visit_at updated');
    
    console.log(`[Sync] Done: clients=${cs} records=${rs} bonuses=${ba} new=${nc}`);
    return { ok: true, clientsSynced: cs, recordsSynced: rs, bonusesAccrued: ba, newClients: nc };

  } catch (e) {
    await db.query(
      `UPDATE sync_logs SET status='error',error_message=$1,finished_at=NOW() WHERE id=$2`,
      [e.message, log.id]
    );
    throw e;
  }
}


// ============================================================
// FINANCES OPERATION — обработка оплаты через карту YClients
// ============================================================
async function processFinancesOperation(payload, salon) {
  const data     = payload.data || {};
  const status   = payload.status; // create | delete
  const clientId = data.client?.id;
  const recordId = data.record_id || data.record?.id;

  if (!clientId || !recordId) return;

  const settings = await getLoyaltySettings(salon.id);
  if (!settings) return;

  // Найти клиента в нашей БД
  const client = await db.one(
    'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
    [salon.id, clientId]
  );
  if (!client) return;

  // ── СОЗДАНИЕ ОПЛАТЫ → начисляем кэшбэк ──
  if (status === 'create') {
    // Проверяем что оплата полная
    const record = data.record || {};
    if (record.paid_full !== 1) return;

    // Проверка на дубль
    const dup = await db.one(
      "SELECT id FROM finances_log WHERE yclients_record_id=$1 AND event_status='create'",
      [recordId]
    );
    if (dup) return;

    // Получаем полные данные записи из YC
    let ycRecord = {};
    try {
      ycRecord = await ycGet(salon, `/record/${salon.yclients_company_id}/${recordId}`);
    } catch { return; }

    const services = ycRecord.services || [];
    // Проверяем что нет скидок и оплата полная
    let paidAmount = 0;
    let hasDiscount = false;
    for (const s of services) {
      const cost     = parseFloat(s.cost || 0);
      const costPay  = parseFloat(s.cost_to_pay ?? cost);
      const discount = parseFloat(s.discount || 0);
      if (discount > 0 || costPay < cost) { hasDiscount = true; break; }
      paidAmount += costPay;
    }

    if (hasDiscount || paidAmount <= 0) {
      await db.query(
        `INSERT INTO finances_log (salon_id,yclients_record_id,client_id,event_status,
         paid_amount,cashback_pct,cashback_amount,raw_payload)
         VALUES ($1,$2,$3,'create',$4,0,0,$5) ON CONFLICT DO NOTHING`,
        [salon.id, recordId, client.id, paidAmount, JSON.stringify(payload)]
      );
      return;
    }

    // Определяем % кэшбэка по уровню клиента
    const level     = getLevel(parseFloat(client.total_spent || 0), settings.levels);
    const cashbackPct = level.cashback || 5;
    const cashback  = Math.floor(paidAmount * cashbackPct / 100);

    if (cashback <= 0) return;

    // Начисляем на карту YClients
    if (client.yclients_card_id && salon.yclients_card_type_id) {
      try {
        await ycAccrueCard(salon, client.yclients_card_id, cashback,
          `Кэшбэк ${cashbackPct}% по записи #${recordId}`);
      } catch (e) {
        console.error('[FinOp] Card accrual error:', e.message);
      }
    }

    // Обновляем баланс в нашей БД
    await db.query(
      'UPDATE clients SET bonus_balance=bonus_balance+$1, updated_at=NOW() WHERE id=$2',
      [cashback, client.id]
    );
    await db.query(
      `INSERT INTO bonus_transactions
         (salon_id,client_id,type,amount,balance_before,balance_after,
          visit_amount,cashback_pct,description,created_at)
       VALUES ($1,$2,'accrual',$3,$4,$5,$6,$7,$8,NOW())`,
      [salon.id, client.id, cashback,
       client.bonus_balance, client.bonus_balance + cashback,
       paidAmount, cashbackPct,
       `Кэшбэк за визит #${recordId}`]
    );

    // Логируем
    await db.query(
      `INSERT INTO finances_log
         (salon_id,yclients_record_id,client_id,event_status,
          paid_amount,cashback_pct,cashback_amount,card_id,processed,raw_payload)
       VALUES ($1,$2,$3,'create',$4,$5,$6,$7,TRUE,$8) ON CONFLICT DO NOTHING`,
      [salon.id, recordId, client.id, paidAmount, cashbackPct, cashback,
       client.yclients_card_id, JSON.stringify(payload)]
    );
    console.log(`[FinOp] Accrued ${cashback} (${cashbackPct}%) for client ${client.name}, record #${recordId}`);
  }

  // ── УДАЛЕНИЕ ОПЛАТЫ → отменяем кэшбэк ──
  if (status === 'delete') {
    const log = await db.one(
      "SELECT * FROM finances_log WHERE yclients_record_id=$1 AND event_status='create'",
      [recordId]
    );
    if (!log || !log.cashback_amount || log.cashback_amount <= 0) return;

    const deduct = Math.min(parseFloat(log.cashback_amount), parseFloat(client.bonus_balance || 0));

    // Снимаем с карты YClients
    if (client.yclients_card_id && deduct > 0) {
      try {
        await ycAccrueCard(salon, client.yclients_card_id, -deduct,
          `Отмена кэшбэка по записи #${recordId}`);
      } catch (e) {
        console.error('[FinOp] Card deduct error:', e.message);
      }
    }

    // Обновляем баланс в нашей БД
    await db.query(
      'UPDATE clients SET bonus_balance=GREATEST(0,bonus_balance-$1),updated_at=NOW() WHERE id=$2',
      [deduct, client.id]
    );
    await db.query(
      `INSERT INTO bonus_transactions
         (salon_id,client_id,type,amount,balance_before,balance_after,description,created_at)
       VALUES ($1,$2,'cancellation',$3,$4,$5,$6,NOW())`,
      [salon.id, client.id, -deduct,
       client.bonus_balance, Math.max(0, client.bonus_balance - deduct),
       `Отмена кэшбэка за визит #${recordId}`]
    );

    await db.query(
      "DELETE FROM finances_log WHERE yclients_record_id=$1 AND event_status='create'",
      [recordId]
    );
    console.log(`[FinOp] Reverted ${deduct} for client ${client.name}, record #${recordId}`);
  }
}

// ============================================================
// WEBHOOK
// ============================================================
app.post('/api/webhook/yclients/:companyId', async (req, res) => {
  res.json({ ok: true });
  const t0 = Date.now();
  const salon = await db.one(
    'SELECT * FROM salons WHERE yclients_company_id=$1 AND is_active=TRUE',
    [req.params.companyId]
  );
  if (!salon) return;

  const payload = req.body;
  const wlog = await db.one(
    `INSERT INTO webhook_logs (salon_id,event_type,resource_id,payload)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [salon.id, payload.resource_type, payload.data?.id || null, JSON.stringify(payload)]
  );

  try {
    const settings = await getLoyaltySettings(salon.id);
    const ycRec = payload.data;

    if (payload.resource_type === 'record' && ycRec) {
      const status = ycRec.status_id === 1 ? 'completed'
                   : ycRec.status_id === 3 ? 'cancelled' : 'pending';

      let client = null;
      if (ycRec.client?.id) {
        client = await db.one(
          'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, ycRec.client.id]
        );
        if (!client) {
          await db.query(
            `INSERT INTO clients (salon_id,yclients_client_id,name,phone,synced_at)
             VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT DO NOTHING`,
            [salon.id, ycRec.client.id, ycRec.client.name || 'Клиент', ycRec.client.phone || null]
          );
          client = await db.one(
            'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
            [salon.id, ycRec.client.id]
          );
        }
      }

      let record = await db.one(
        'SELECT * FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
        [salon.id, ycRec.id]
      );
      if (!record) {
        record = await db.one(
          `INSERT INTO records
             (salon_id,yclients_record_id,client_id,yclients_client_id,
              visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'webhook',$11) RETURNING *`,
          [salon.id, ycRec.id, client?.id || null, ycRec.client?.id || null,
           String(ycRec.date || '').split(' ')[0] || null, ycRec.date || null,
           ycRec.cost || 0, JSON.stringify(ycRec.services || []),
           JSON.stringify(ycRec.staff || []), status, JSON.stringify(ycRec)]
        );
      } else {
        await db.query(
          'UPDATE records SET status=$1,raw_payload=$2,updated_at=NOW() WHERE id=$3',
          [status, JSON.stringify(ycRec), record.id]
        );
        if (status === 'cancelled' && record.bonus_processed && client) {
          await cancelRecordBonuses(record.id, client.id, salon.id);
        }
      }

      if (status === 'completed' && !record.bonus_processed && client && settings && parseFloat(ycRec.cost || 0) > 0) {
        await processCompletedRecord(record.id, client.id, ycRec, salon.id, settings);
      }
    }

    if (payload.resource_type === 'client' && ycRec) {
      await db.query(
        `INSERT INTO clients (salon_id,yclients_client_id,name,phone,email,birthday,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (salon_id,yclients_client_id)
         DO UPDATE SET name=$3,phone=$4,email=$5,birthday=$6,synced_at=NOW()`,
        [salon.id, ycRec.id, ycRec.name || 'Клиент', ycRec.phone,
         ycRec.email || null, ycRec.birth_date || null]
      );
    }

    // ── finances_operation — оплата/отмена оплаты через карту YClients ──
    if (payload.resource === 'finances_operation' && payload.data) {
      await processFinancesOperation(payload, salon);
    }

    await db.query(
      'UPDATE webhook_logs SET processed=TRUE,processing_ms=$1 WHERE id=$2',
      [Date.now() - t0, wlog.id]
    );
  } catch (e) {
    console.error('[Webhook]', e.message);
    await db.query(
      'UPDATE webhook_logs SET error_message=$1,processing_ms=$2 WHERE id=$3',
      [e.message, Date.now() - t0, wlog.id]
    );
  }
});

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  const pg = await pool.connect();
  try {
    const { salonName, city, email, password } = req.body;
    if (!salonName || !email || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    await pg.query('BEGIN');
    const salon = (await pg.query(
      'INSERT INTO salons (name,city) VALUES ($1,$2) RETURNING id',
      [salonName, city || null]
    )).rows[0];
    await pg.query('INSERT INTO loyalty_settings (salon_id) VALUES ($1)', [salon.id]);
    const hash = await bcrypt.hash(password, 12);
    const user = (await pg.query(
      `INSERT INTO users (salon_id,email,password_hash,name,role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id,name,email,role`,
      [salon.id, email.toLowerCase().trim(), hash, salonName]
    )).rows[0];
    await pg.query('COMMIT');

    const token = jwt.sign(
      { userId: user.id, salonId: salon.id, role: 'owner' },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: { ...user, salonName } });
  } catch (e) {
    await pg.query('ROLLBACK');
    if (e.code === '23505')
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Укажите email и пароль' });
    const user = await db.one(
      `SELECT u.*,s.name as salon_name FROM users u
       JOIN salons s ON s.id=u.salon_id
       WHERE u.email=$1 AND u.is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = jwt.sign(
      { userId: user.id, salonId: user.salon_id, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, salonName: user.salon_name
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  await db.query('DELETE FROM sessions WHERE token=$1', [token]).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await db.one(
      `SELECT u.id,u.name,u.email,u.role,s.name as salon_name,s.yclients_company_id
       FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.id=$1`,
      [req.user.userId]
    );
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SALON
// ============================================================
app.get('/api/salon', auth, async (req, res) => {
  try { res.json(await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/salon', auth, async (req, res) => {
  try {
    const { name, city, timezone, yclients_company_id,
            yclients_card_type_id, yclients_card_type_name } = req.body;
    await db.query(
      `UPDATE salons SET name=$1,city=$2,timezone=$3,yclients_company_id=$4,
       yclients_card_type_id=$5,yclients_card_type_name=$6,updated_at=NOW() WHERE id=$7`,
      [name, city, timezone, yclients_company_id,
       yclients_card_type_id || null, yclients_card_type_name || null,
       req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salon/yclients-auth', auth, async (req, res) => {
  try {
    const { partnerToken, login, password } = req.body;
    const d = await ycAuth(partnerToken, login, password);
    await db.query(
      'UPDATE salons SET yclients_partner_token=$1,yclients_user_token=$2,updated_at=NOW() WHERE id=$3',
      [partnerToken, d.user_token, req.user.salonId]
    );
    res.json({ ok: true, userToken: d.user_token });
  } catch (e) {
    console.error('[YC Auth error]', e.message, e.response?.data);
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// LOYALTY SETTINGS
// ============================================================
app.get('/api/loyalty-settings', auth, async (req, res) => {
  try { res.json(await getLoyaltySettings(req.user.salonId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/loyalty-settings', auth, async (req, res) => {
  try {
    const { levels, service_cashback, birthday_bonus, birthday_days_before, birthday_enabled,
            referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days } = req.body;
    await db.query(
      `INSERT INTO loyalty_settings
         (salon_id,levels,service_cashback,birthday_bonus,birthday_days_before,birthday_enabled,
          referral_enabled,referral_bonus_sender,referral_bonus_receiver,bonus_expiry_days,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (salon_id) DO UPDATE SET
         levels=$2,service_cashback=$3,birthday_bonus=$4,birthday_days_before=$5,
         birthday_enabled=$6,referral_enabled=$7,referral_bonus_sender=$8,
         referral_bonus_receiver=$9,bonus_expiry_days=$10,updated_at=NOW()`,
      [req.user.salonId, JSON.stringify(levels), JSON.stringify(service_cashback || {}),
       birthday_bonus, birthday_days_before, birthday_enabled,
       referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days || 0]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CLIENTS
// ============================================================
app.get('/api/clients', auth, async (req, res) => {
  try {
    const { search, level, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = ['c.salon_id=$1'], params = [req.user.salonId], i = 2;
    if (search) {
      where.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i})`);
      params.push('%' + search + '%'); i++;
    }
    if (level) { where.push(`c.loyalty_level=$${i}`); params.push(level); i++; }
    if (status === 'sleeping') where.push(`c.last_visit_at < NOW()-INTERVAL '60 days' AND c.visits_count>0`);
    if (status === 'risk')     where.push(`c.last_visit_at < NOW()-INTERVAL '30 days' AND c.last_visit_at > NOW()-INTERVAL '60 days'`);
    if (status === 'new')      where.push(`c.created_at > NOW()-INTERVAL '30 days'`);
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) FROM clients c WHERE ${w}`, params)).count;
    const clients = await db.many(
      `SELECT * FROM clients c WHERE ${w}
       ORDER BY c.last_visit_at DESC NULLS LAST
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );
    res.json({ clients, total: parseInt(total), page: parseInt(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    const history = await db.many(
      'SELECT * FROM bonus_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 30',
      [req.params.id]
    );
    const records = await db.many(
      'SELECT * FROM records WHERE client_id=$1 ORDER BY visit_date DESC LIMIT 20',
      [req.params.id]
    );
    res.json({ client, history, records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/bonus', auth, async (req, res) => {
  const pg = await pool.connect();
  try {
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'Укажите сумму' });
    await pg.query('BEGIN');
    const client = (await pg.query(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2 FOR UPDATE',
      [req.params.id, req.user.salonId]
    )).rows[0];
    if (!client) { await pg.query('ROLLBACK'); return res.status(404).json({ error: 'Клиент не найден' }); }
    const newBal = Math.max(0, client.bonus_balance + amount);
    await pg.query('UPDATE clients SET bonus_balance=$1,updated_at=NOW() WHERE id=$2', [newBal, client.id]);
    await pg.query(
      `INSERT INTO bonus_transactions
         (salon_id,client_id,type,amount,balance_before,balance_after,description,created_by_user,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [req.user.salonId, client.id, amount > 0 ? 'manual' : 'redemption',
       amount, client.bonus_balance, newBal,
       description || 'Ручная корректировка', req.user.userId]
    );
    await pg.query('COMMIT');
    res.json({ ok: true, newBalance: newBal });
  } catch (e) {
    await pg.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

// ============================================================
// RECORDS
// ============================================================
app.get('/api/records', auth, async (req, res) => {
  try {
    const { dateFrom, dateTo, status, limit = 200 } = req.query;
    let where = ['r.salon_id=$1'], params = [req.user.salonId], i = 2;
    if (dateFrom) { where.push(`r.visit_date>=$${i}`); params.push(dateFrom); i++; }
    if (dateTo)   { where.push(`r.visit_date<=$${i}`); params.push(dateTo); i++; }
    if (status)   { where.push(`r.status=$${i}`); params.push(status); i++; }
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) FROM records r WHERE ${w}`, params)).count;
    const records = await db.many(
      `SELECT r.*,c.name as client_name,c.phone as client_phone
       FROM records r LEFT JOIN clients c ON c.id=r.client_id
       WHERE ${w} ORDER BY r.visit_date DESC,r.id DESC LIMIT $${i}`,
      [...params, limit]
    );
    res.json({ records, total: parseInt(total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ANALYTICS
// ============================================================
app.get('/api/analytics/dashboard', auth, async (req, res) => {
  try {
    const sid  = req.user.salonId;
    const days = parseInt(req.query.period || 30);
    const [tc, ac, slp, nc, bs, rev, topSvc, lvlDist, daily, recentTx, lastSync] = await Promise.all([
      db.one('SELECT COUNT(*) FROM clients WHERE salon_id=$1', [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at>NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at<NOW()-INTERVAL '60 days' AND visits_count>0`, [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND created_at>NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(`SELECT COALESCE(SUM(bonus_balance),0) as tb,COALESCE(SUM(total_spent),0) as ts FROM clients WHERE salon_id=$1`, [sid]),
      db.one(`SELECT COUNT(*) as rc,COALESCE(SUM(amount),0) as rv,COALESCE(SUM(bonus_accrued),0) as ba FROM records WHERE salon_id=$1 AND status='completed' AND visit_date>=NOW()-INTERVAL '${days} days'`, [sid]),
      db.many(`SELECT svc->>'title' as service_name,COUNT(*) as cnt,SUM(r.amount) as total_amount FROM records r,jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc WHERE r.salon_id=$1 AND r.status='completed' AND r.visit_date>=NOW()-INTERVAL '${days} days' GROUP BY svc->>'title' ORDER BY cnt DESC LIMIT 8`, [sid]),
      db.many(`SELECT loyalty_level,COUNT(*) as cnt FROM clients WHERE salon_id=$1 GROUP BY loyalty_level`, [sid]),
      db.many(`SELECT visit_date::text,COUNT(*) as records,COALESCE(SUM(amount),0) as revenue,COALESCE(SUM(bonus_accrued),0) as bonuses FROM records WHERE salon_id=$1 AND status='completed' AND visit_date>=NOW()-INTERVAL '${days} days' GROUP BY visit_date ORDER BY visit_date`, [sid]),
      db.many(`SELECT bt.*,c.name as client_name FROM bonus_transactions bt JOIN clients c ON c.id=bt.client_id WHERE bt.salon_id=$1 ORDER BY bt.created_at DESC LIMIT 15`, [sid]),
      db.one(`SELECT * FROM sync_logs WHERE salon_id=$1 ORDER BY started_at DESC LIMIT 1`, [sid]),
    ]);
    res.json({
      stats: {
        totalClients:      parseInt(tc.count),
        activeClients:     parseInt(ac.count),
        sleepingClients:   parseInt(slp.count),
        newClients:        parseInt(nc.count),
        totalBonusBalance: parseFloat(bs.tb),
        totalSpent:        parseFloat(bs.ts),
        periodRevenue:     parseFloat(rev.rv),
        periodRecords:     parseInt(rev.rc),
        periodBonuses:     parseFloat(rev.ba),
      },
      levelDist: lvlDist, topServices: topSvc, dailyRevenue: daily,
      recentTxns: recentTx, syncStatus: lastSync,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/bonuses', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.period || 30);
    const rows = await db.many(
      `SELECT DATE_TRUNC('day',created_at)::date as day,type,
         SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as accrued,
         SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as redeemed
       FROM bonus_transactions WHERE salon_id=$1 AND created_at>=NOW()-INTERVAL '${days} days'
       GROUP BY day,type ORDER BY day`,
      [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/retention', auth, async (req, res) => {
  try {
    const rows = await db.many(
      `SELECT DATE_TRUNC('month',first_visit) as cohort_month,COUNT(DISTINCT client_id) as total,
         COUNT(DISTINCT CASE WHEN months_since>=1 THEN client_id END) as m1,
         COUNT(DISTINCT CASE WHEN months_since>=2 THEN client_id END) as m2,
         COUNT(DISTINCT CASE WHEN months_since>=3 THEN client_id END) as m3
       FROM (
         SELECT client_id,MIN(visit_date) OVER (PARTITION BY client_id) as first_visit,
                EXTRACT(MONTH FROM AGE(visit_date,MIN(visit_date) OVER (PARTITION BY client_id))) as months_since
         FROM records WHERE salon_id=$1 AND status='completed' AND client_id IS NOT NULL
       ) t GROUP BY cohort_month ORDER BY cohort_month DESC LIMIT 6`,
      [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SYNC API
// ============================================================
app.post('/api/sync', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id || !salon.yclients_user_token) {
      return res.status(400).json({ error: 'YClients не настроен. Укажите токены в Настройках.' });
    }
    res.json({ ok: true, message: 'Синхронизация запущена' });
    runSync(salon, 'manual', req.user.userId).catch(e => console.error('[Sync]', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sync/logs', auth, async (req, res) => {
  try {
    res.json(await db.many(
      `SELECT sl.*,u.name as user_name FROM sync_logs sl
       LEFT JOIN users u ON u.id=sl.initiated_by
       WHERE sl.salon_id=$1 ORDER BY sl.started_at DESC LIMIT 20`,
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/webhook-logs', auth, async (req, res) => {
  try {
    res.json(await db.many(
      'SELECT * FROM webhook_logs WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/yclients/services', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    res.json(await ycGet(salon, `/services/${salon.yclients_company_id}`));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Получить типы карт лояльности из YClients
app.get('/api/yclients/card-types', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    const types = await ycGetCardTypes(salon);
    res.json(types);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Получить историю транзакций карты клиента
app.get('/api/clients/:id/card-transactions', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });

    // Из нашей БД
    const localTxns = await db.many(
      'SELECT * FROM loyalty_card_transactions WHERE client_id=$1 ORDER BY txn_date DESC LIMIT 100',
      [client.id]
    );

    // Если карта есть — подгружаем свежие из YClients
    let ycTxns = [];
    if (client.yclients_card_id) {
      const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
      ycTxns = await ycGetCardTransactions(salon, client.yclients_card_id);
    }

    res.json({ local: localTxns, yclients: ycTxns, card: {
      id:      client.yclients_card_id,
      number:  client.yclients_card_number,
      balance: client.yclients_card_balance,
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Синхронизировать историю карты клиента
app.post('/api/clients/:id/sync-card', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    if (!client.yclients_client_id) return res.status(400).json({ error: 'Нет yclients_client_id' });

    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_card_type_id) return res.status(400).json({ error: 'Карта лояльности не выбрана в Настройках' });

    // Загрузить карты клиента
    console.log(`[SyncCard] client=${client.id} yclients_id=${client.yclients_client_id} card_type=${salon.yclients_card_type_id}`);
    const cards = await ycGetClientCards(salon, client.yclients_client_id);
    console.log(`[SyncCard] found ${cards.length} cards for client`);
    cards.forEach((c,i) => console.log(`[SyncCard] card[${i}]: id=${c.id} type_id=${c.type?.id} type_title=${c.type?.title} balance=${c.balance} number=${c.number||c.loyalty_card_number}`));

    const card  = cards.find(c =>
      c.type?.id === salon.yclients_card_type_id ||
      String(c.type?.id) === String(salon.yclients_card_type_id)
    );
    if (!card) {
      console.log(`[SyncCard] card type ${salon.yclients_card_type_id} NOT found. Available types: ${cards.map(c=>c.type?.id).join(',')}`);
      return res.json({ ok: false, message: `Карта типа ${salon.yclients_card_type_id} не найдена. Доступно: ${cards.map(c=>c.type?.title||c.type?.id).join(', ')||'нет карт'}` });
    }
    console.log(`[SyncCard] matched card: id=${card.id} balance=${card.balance}`);

    // Обновить данные карты
    await db.query(
      `UPDATE clients SET
         yclients_card_id=$1, yclients_card_number=$2, yclients_card_balance=$3,
         bonus_balance=$4, updated_at=NOW()
       WHERE id=$5`,
      [card.id, card.number || card.loyalty_card_number || null,
       parseFloat(card.balance || 0), parseFloat(card.balance || 0), client.id]
    );

    // Загрузить историю транзакций
    let page = 1, imported = 0;
    for (;;) {
      const txns = await ycGetCardTransactions(salon, card.id, page, 200);
      if (!txns?.length) break;
      for (const t of txns) {
        await db.query(
          `INSERT INTO loyalty_card_transactions
             (salon_id,client_id,yclients_card_id,yclients_txn_id,type,amount,
              balance_after,title,record_id,txn_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (yclients_txn_id) DO NOTHING`,
          [salon.id, client.id, card.id, t.id,
           parseFloat(t.amount || 0) >= 0 ? 'accrual' : 'redemption',
           parseFloat(t.amount || 0), parseFloat(t.balance_after || 0),
           t.title || t.comment || null,
           t.record_id || null,
           t.created_at || t.date || null]
        );
        imported++;
      }
      if (txns.length < 200) break;
      page++;
    }

    res.json({ ok: true, cardId: card.id, balance: card.balance, transactionsImported: imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Лог финансовых операций
app.get('/api/finances-log', auth, async (req, res) => {
  try {
    const rows = await db.many(
      `SELECT fl.*,c.name as client_name FROM finances_log fl
       LEFT JOIN clients c ON c.id=fl.client_id
       WHERE fl.salon_id=$1 ORDER BY fl.created_at DESC LIMIT 50`,
      [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CRON
// ============================================================
cron.schedule('0 10 * * *', async () => {
  console.log('[Cron] Birthday bonuses...');
  try {
    const salons = await db.many(
      `SELECT s.*,ls.birthday_bonus,ls.birthday_days_before
       FROM salons s JOIN loyalty_settings ls ON ls.salon_id=s.id
       WHERE s.is_active=TRUE AND ls.birthday_enabled=TRUE`
    );
    for (const salon of salons) {
      const target = new Date();
      target.setDate(target.getDate() + (salon.birthday_days_before || 3));
      const clients = await db.many(
        `SELECT * FROM clients WHERE salon_id=$1
         AND EXTRACT(MONTH FROM birthday)=$2 AND EXTRACT(DAY FROM birthday)=$3`,
        [salon.id, target.getMonth() + 1, target.getDate()]
      );
      for (const c of clients) {
        const already = await db.one(
          `SELECT id FROM bonus_transactions WHERE client_id=$1 AND type='birthday'
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW())`,
          [c.id]
        );
        if (already) continue;
        const bonus = salon.birthday_bonus || 500;
        await db.query('UPDATE clients SET bonus_balance=bonus_balance+$1 WHERE id=$2', [bonus, c.id]);
        await db.query(
          `INSERT INTO bonus_transactions
             (salon_id,client_id,type,amount,balance_before,balance_after,description,created_at)
           VALUES ($1,$2,'birthday',$3,$4,$5,'🎂 Подарок на день рождения',NOW())`,
          [salon.id, c.id, bonus, c.bonus_balance, c.bonus_balance + bonus]
        );
        console.log(`[Birthday] ${c.name} +${bonus}`);
      }
    }
  } catch (e) { console.error('[Cron birthday]', e.message); }
}, { timezone: 'Europe/Moscow' });

cron.schedule('0 */3 * * *', async () => {
  console.log('[Cron] Auto-sync...');
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE
       AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      runSync(salon, 'auto').catch(e => console.error(`[AutoSync ${salon.id}]`, e.message));
    }
  } catch (e) { console.error('[Cron sync]', e.message); }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3001;
pool.connect()
  .then(client => {
    client.release();
    app.listen(PORT, () => {
      console.log(`✓ LoyalPro server running on port ${PORT}`);
      console.log(`  Webhook endpoint: POST /api/webhook/yclients/:companyId`);
      console.log(`  Register: POST /api/auth/register`);
    });
  })
  .catch(e => {
    console.error('✗ PostgreSQL error:', e.message);
    app.listen(PORT, () => console.log(`⚠ Server started WITHOUT DB on port ${PORT}`));
  });
