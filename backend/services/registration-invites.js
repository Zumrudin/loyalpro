'use strict';
const crypto = require('crypto');
const config = require('../config');
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const emailHash = email => crypto.createHmac('sha256', config.JWT_SECRET)
  .update(`registration:${email.toLowerCase().trim()}`).digest('hex');

async function consume(conn, token, email) {
  if (config.REGISTRATION_MODE === 'open') return;
  const denied = () => Object.assign(new Error('Приглашение недействительно или истекло.'), { status: 403 });
  if (config.REGISTRATION_MODE !== 'invite' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const result = await conn.query(`UPDATE registration_invites SET used_at=NOW()
    WHERE token_hash=$1 AND email_hash=$2 AND used_at IS NULL AND expires_at>NOW()
    RETURNING token_hash`, [hash(token), emailHash(email)]);
  if (!result.rows.length) throw denied();
}

async function issue(conn, email, days = 7) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      || email.length > 254 || !Number.isInteger(days) || days < 1 || days > 30) throw new Error('Invalid invitation parameters');
  const token = crypto.randomBytes(32).toString('base64url');
  await conn.query(`INSERT INTO registration_invites(token_hash,email_hash,expires_at)
    VALUES ($1,$2,NOW()+($3*INTERVAL '1 day'))`, [hash(token), emailHash(email), days]);
  return token;
}
module.exports = { consume, issue };
