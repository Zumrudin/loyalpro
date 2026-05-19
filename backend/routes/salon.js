const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { ycAuth, ycWebSessions } = require('../services/yclients');
const { getLoyaltySettings } = require('../services/loyalty');
const { createLogger } = require('../logger');
const logger = createLogger('Salon');

router.get('/', auth, async (req, res) => {
  try { res.json(await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/', auth, async (req, res) => {
  try {
    const { name, city, timezone, yclients_company_id,
            yclients_card_type_id, yclients_card_type_name, yclients_web_cookie } = req.body;
    await db.query(
      `UPDATE salons SET name=$1,city=$2,timezone=$3,yclients_company_id=$4,
       yclients_card_type_id=$5,yclients_card_type_name=$6,
       yclients_web_cookie=COALESCE($7,yclients_web_cookie),
       updated_at=NOW() WHERE id=$8`,
      [name, city, timezone, yclients_company_id,
       yclients_card_type_id || null, yclients_card_type_name || null,
       yclients_web_cookie || null, req.user.salonId]
    );
    if (yclients_web_cookie) delete ycWebSessions[req.user.salonId];
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'salons_yclients_company_id_key')
      return res.status(409).json({ error: 'Салон с таким ID филиала YClients уже зарегистрирован в системе. Обратитесь в поддержку.' });
    res.status(500).json({ error: e.message });
  }
});

// ── Webhook HMAC secret management ──────────────────────────────
// GET returns whether a secret is configured (never the secret itself);
// POST generates and returns a NEW secret (replacing any prior one).
// The secret must then be entered in the YClients partner dashboard
// against the webhook URL — YClients signs each delivery with sha256-HMAC.
router.get('/webhook-secret', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const row = await db.oneOrNone(
      'SELECT yclients_webhook_secret FROM salons WHERE id=$1',
      [req.user.salonId]
    );
    res.json({ configured: !!row?.yclients_webhook_secret });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/webhook-secret', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars
    await db.query(
      'UPDATE salons SET yclients_webhook_secret=$1, updated_at=NOW() WHERE id=$2',
      [secret, req.user.salonId]
    );
    logger.info(`webhook secret rotated salon=${req.user.salonId} by user=${req.user.userId}`);
    // Returned once. After this admin acknowledges the value we don't expose it again.
    res.json({ secret });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/yclients-auth', auth, async (req, res) => {
  try {
    const { partnerToken, login, password, chainId } = req.body;
    const d = await ycAuth(partnerToken, login, password);
    await db.query(
      `UPDATE salons SET
         yclients_partner_token=$1, yclients_user_token=$2,
         yclients_login=$3, yclients_password=$4,
         yclients_chain_id=$5, updated_at=NOW()
       WHERE id=$6`,
      [partnerToken, d.user_token, login, password, chainId || null, req.user.salonId]
    );
    delete ycWebSessions[req.user.salonId];
    res.json({ ok: true, userToken: d.user_token });
  } catch (e) {
    logger.error(`YC Auth error: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
