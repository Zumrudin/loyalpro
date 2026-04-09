const router = require('express').Router();
const { db } = require('../db');
const { auth } = require('../middleware/auth');
const { ycAuth, ycWebSessions } = require('../services/yclients');
const { getLoyaltySettings } = require('../services/loyalty');

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
    console.error('[YC Auth error]', e.message);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
