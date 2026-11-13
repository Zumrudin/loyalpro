'use strict';
const ledger = require('../bonus-ledger');
const finance = require('../finance-ops');

function createMirror(store, salonId) {
  const q = store.q;
  async function sync(phone, registration, card) {
    if (!card || String(card.id) !== registration.cardId || !Number.isFinite(Number(card.balance))) {
      throw new Error('Card not available for synchronization');
    }
    await q('BEGIN');
    try {
      const existing = (await q(`SELECT synced FROM max_loyalty_registrations
        WHERE salon_id=$1 AND phone=$2 FOR UPDATE`, [salonId, phone])).rows[0];
      if (!existing) throw new Error('Registration journal missing');
      if (existing.synced) { await q('COMMIT'); return; }
      const c = (await q(`INSERT INTO clients(salon_id,yclients_client_id,name,phone,birthday)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(salon_id,yclients_client_id) DO UPDATE SET
        birthday=COALESCE(clients.birthday,EXCLUDED.birthday),updated_at=NOW() RETURNING *`,
      [salonId, registration.clientId, registration.name || 'Клиент', phone, registration.birthday || null])).rows[0];
      await q(`UPDATE clients SET yclients_card_id=$3,yclients_card_number=$4,updated_at=NOW()
        WHERE salon_id=$1 AND id=$2`, [salonId, c.id, card.id, card.number ?? card.loyalty_card_number ?? null]);
      if (registration.welcome) {
        const txn = (await q(`INSERT INTO loyalty_card_transactions
          (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,txn_date,created_at)
          VALUES($1,$2,$3,'accrual',500,$4,'Приветственные бонусы за регистрацию в MAX',NOW(),NOW()) RETURNING *`,
        [salonId, c.id, card.id, card.balance])).rows[0];
        // The standalone bot may run alongside the older production backend,
        // before the optional finance ledger migration. Keep its native LCT
        // journal; the ledger's backfill can import it when that feature ships.
        const available = (await q("SELECT to_regclass('finance_operations') IS NOT NULL AS available")).rows[0].available;
        if (available) await finance.recordLoyaltyTxn(txn, { kind: 'bonus_accrual', origin: 'loyalpro' }, { q });
        else if (ledger.isPrimary()) throw new Error('Primary bonus ledger schema missing');
      }
      // Client id is resolved within this salon above. Use the existing ledger
      // writer so BONUS_LEDGER_PRIMARY and opening balances keep their semantics.
      await ledger.setCardReading(c.id, card.balance, { q });
      await q(`UPDATE max_loyalty_registrations SET synced=TRUE,updated_at=NOW()
        WHERE salon_id=$1 AND phone=$2`, [salonId, phone]);
      await q('COMMIT');
    } catch (e) { await q('ROLLBACK'); throw e; }
  }
  async function balance(clientId, card) {
    if (!Number.isFinite(Number(card.balance))) throw new Error('Invalid balance');
    const c = (await q('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salonId, clientId])).rows[0];
    if (!c) throw new Error('Client link missing');
    const updated = await ledger.setCardReading(c.id, card.balance, { q });
    // Preserve fractional YClients balance when the local ledger is not primary.
    return ledger.isPrimary() ? updated.bonus_balance : Number(card.balance);
  }
  return { sync, balance };
}
module.exports = { createMirror };
