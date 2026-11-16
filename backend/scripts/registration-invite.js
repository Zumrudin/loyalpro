'use strict';
// Operator-only CLI. Email comes from a private file, token goes to a new 0600
// file; neither is printed or accepted as a shell argument.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { pool } = require('../db');
const { issue } = require('../services/registration-invites');
async function main() {
  const [emailFile, outputFile, confirmation] = process.argv.slice(2);
  if (!emailFile || !outputFile || !/^--confirm-database=(loyalpro_test|loyalpro)$/.test(confirmation || '')) {
    throw new Error('usage: registration-invite.js EMAIL_FILE NEW_TOKEN_FILE --confirm-database=loyalpro_test|loyalpro');
  }
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query('SELECT current_database() AS name');
    if (rows[0].name !== confirmation.split('=')[1]) throw new Error('database mismatch');
    await conn.query('BEGIN');
    const token = await issue(conn, fs.readFileSync(emailFile, 'utf8').trim());
    fs.writeFileSync(outputFile, token + '\n', { mode: 0o600, flag: 'wx' });
    await conn.query('COMMIT');
    console.log('Invitation created; token is in the requested private file. Expires in 7 days.');
  } catch (e) { await conn.query('ROLLBACK'); throw e; }
  finally { conn.release(); }
}
main().catch(() => { console.error('Invitation creation failed; no secret details logged.'); process.exitCode = 1; })
  .finally(() => pool.end());
