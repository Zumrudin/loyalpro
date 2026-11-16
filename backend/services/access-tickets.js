'use strict';
const crypto = require('crypto');
const { db } = require('../db');

const CHAT_STREAM_SCOPE = 'chat:stream';

function hash(ticket) {
  return crypto.createHash('sha256').update(ticket).digest('hex');
}

async function issue(user, scope = CHAT_STREAM_SCOPE) {
  if (scope !== CHAT_STREAM_SCOPE || !user?.userId || !user?.salonId) throw new Error('Invalid ticket context');
  const ticket = crypto.randomBytes(32).toString('base64url');
  const row = await db.one(
    `INSERT INTO api_access_tickets (token_hash,user_id,salon_id,scope,expires_at)
     VALUES ($1,$2,$3,$4,NOW()+INTERVAL '60 seconds') RETURNING expires_at`,
    [hash(ticket), user.userId, user.salonId, scope]
  );
  return { ticket, expiresAt: row.expires_at };
}

async function consume(ticket, scope = CHAT_STREAM_SCOPE) {
  if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 128 || scope !== CHAT_STREAM_SCOPE) return null;
  return db.oneOrNone(
    `UPDATE api_access_tickets AS t SET used_at=NOW()
     FROM users u, salons s
     WHERE t.token_hash=$1 AND t.scope=$2 AND t.used_at IS NULL AND t.expires_at>NOW()
       AND u.id=t.user_id AND u.is_active=TRUE
       AND s.id=t.salon_id AND s.id=u.salon_id AND s.is_active=TRUE
     RETURNING t.user_id AS "userId",t.salon_id AS "salonId",u.role`,
    [hash(ticket), scope]
  );
}

module.exports = { issue, consume, hash, CHAT_STREAM_SCOPE };
