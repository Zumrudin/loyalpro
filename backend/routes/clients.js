const router = require('express').Router();
const { pool, db } = require('../db');
const { auth } = require('../middleware/auth');
const { buildClientsQuery } = require('../clients-query');
const { ycGet, ycGetClientCards, ycGetCardTransactions, ycWebSessions } = require('../services/yclients');
const { getLoyaltySettings, getLevel, runSync, sleep } = require('../services/loyalty');


// ── Clients ──────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 50);
    const offset = (page - 1) * limit;
    const { orderCol, orderDir, whereSql, params, nextIdx } =
      buildClientsQuery(req.query, req.user.salonId);

    const total = (await db.one(`SELECT COUNT(*) FROM clients c WHERE ${whereSql}`, params)).count;
    const clients = await db.many(
      `SELECT * FROM clients c WHERE ${whereSql}
       ORDER BY ${orderCol} ${orderDir} NULLS LAST
       LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
      [...params, limit, offset]
    );
    res.json({ clients, total: parseInt(total), page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    const history = await db.many(
      `SELECT id,
              COALESCE(txn_date, created_at) as created_at,
              amount, title as description, type, balance_after, 'card' as source
       FROM loyalty_card_transactions WHERE client_id=$1
       UNION ALL
       SELECT id, created_at, amount, description, type, balance_after, 'manual' as source
       FROM bonus_transactions WHERE client_id=$1 AND description NOT LIKE '%импорт%'
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const records = await db.many(
      'SELECT * FROM records WHERE client_id=$1 ORDER BY visit_date DESC LIMIT 20',
      [req.params.id]
    );
    res.json({ client, history, records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/bonus', auth, async (req, res) => {
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
      `INSERT INTO loyalty_card_transactions
         (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,txn_date,created_at)
       VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),$4,$5,$6,$7,NOW(),NOW())`,
      [req.user.salonId, client.id, client.id,
       amount > 0 ? 'accrual' : 'redemption', amount, newBal,
       description || 'Ручная корректировка']
    );
    await pg.query('COMMIT');
    res.json({ ok: true, newBalance: newBal });
  } catch (e) {
    await pg.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

router.get('/:id/card-transactions', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    const lct = await db.many(
      `SELECT id, txn_date as created_at, amount, title, balance_after, type
       FROM loyalty_card_transactions WHERE client_id=$1
       ORDER BY txn_date DESC NULLS LAST LIMIT 500`,
      [client.id]
    );
    const bonus = await db.many(
      `SELECT id, created_at, amount, description as title, balance_after, type
       FROM bonus_transactions WHERE client_id=$1
       ORDER BY created_at DESC LIMIT 200`,
      [client.id]
    );
    res.json({
      local: lct, bonus, transactions: lct,
      card: { id: client.yclients_card_id, number: client.yclients_card_number, balance: client.yclients_card_balance || client.bonus_balance },
      summary: {
        totalTransactions: lct.length + bonus.length,
        totalAccrued:  [...lct,...bonus].filter(t=>parseFloat(t.amount)>0).reduce((s,t)=>s+parseFloat(t.amount),0),
        totalRedeemed: [...lct,...bonus].filter(t=>parseFloat(t.amount)<0).reduce((s,t)=>s+Math.abs(parseFloat(t.amount)),0),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/sync-card', auth, async (req, res) => {
  try {
    const client = await db.one('SELECT * FROM clients WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    if (!client.yclients_client_id) return res.status(400).json({ error: 'Нет yclients_client_id' });
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_card_type_id) return res.status(400).json({ error: 'Карта лояльности не выбрана в Настройках' });

    const cards = await ycGetClientCards(salon, client.yclients_client_id);
    const card = cards.find(c => c.type?.id === salon.yclients_card_type_id || String(c.type?.id) === String(salon.yclients_card_type_id));
    if (!card) return res.json({ ok: false, message: `Карта типа ${salon.yclients_card_type_id} не найдена` });

    const cardBalance = parseFloat(card.balance || 0);
    const paidAmount  = parseFloat(card.paid_amount || card.sold_amount || client.total_spent || 0);
    const visitsCount = parseInt(card.visits_count || client.visits_count || 0);
    const cardNumber  = card.number || card.loyalty_card_number || null;

    const lsData = await getLoyaltySettings(salon.id);
    const level  = lsData?.levels ? getLevel(paidAmount, lsData.levels) : null;

    await db.query(
      `UPDATE clients SET yclients_card_id=$1,yclients_card_number=$2,yclients_card_balance=$3,
       bonus_balance=$4,total_spent=$5,visits_count=$6,loyalty_level=$7,updated_at=NOW() WHERE id=$8`,
      [card.id, cardNumber, cardBalance, cardBalance, paidAmount, visitsCount, level?.key || client.loyalty_level, client.id]
    );
    const txnsCount = await db.one('SELECT COUNT(*) FROM loyalty_card_transactions WHERE client_id=$1', [client.id]);
    res.json({ ok: true, cardId: card.id, cardNumber, balance: cardBalance, paidAmount, visitsCount, level: level?.key || client.loyalty_level, transactionsInDb: parseInt(txnsCount.count), message: `Карта синхронизирована. Баланс: ${cardBalance.toLocaleString('ru')} ₽` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
