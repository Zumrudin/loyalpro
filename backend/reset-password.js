#!/usr/bin/env node
// Operator-only recovery CLI. Put the email and password in separate private
// files (mode 0600), then run:
//   node reset-password.js EMAIL_FILE PASSWORD_FILE --confirm-database=loyalpro_test
// The password is never accepted in argv or printed. Use /dev/stdin as
// PASSWORD_FILE for interactive input without terminal echo, for example:
//   read -rs PASSWORD; printf '%s\n' "$PASSWORD" | node reset-password.js EMAIL_FILE /dev/stdin --confirm-database=loyalpro_test

const fs = require('fs');
const bcrypt = require('bcryptjs');

function readPrivateFile(filename, label) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() && filename !== '/dev/stdin') throw new Error(`${label} input is not a regular file`);
  if (filename !== '/dev/stdin' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} file must not be accessible by group or other users`);
  }
  return fs.readFileSync(filename, 'utf8').replace(/[\r\n]+$/, '');
}

async function resetPassword(client, email, newPassword) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!normalizedEmail) throw new Error('email is required');
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('password must be at least 8 characters');
  }

  await client.query('BEGIN');
  try {
    const user = await client.query(
      'SELECT id FROM users WHERE email=$1 FOR UPDATE',
      [normalizedEmail]
    );
    if (user.rows.length !== 1) throw new Error('user not found or email is not unique');

    const hash = await bcrypt.hash(newPassword, 12);
    const userId = user.rows[0].id;
    await client.query(
      'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
      [hash, userId]
    );
    await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [emailFile, passwordFile, confirmation] = argv;
  if (!emailFile || !passwordFile || !/^--confirm-database=(loyalpro_test|loyalpro)$/.test(confirmation || '')) {
    throw new Error('usage: reset-password.js EMAIL_FILE PASSWORD_FILE --confirm-database=loyalpro_test|loyalpro');
  }
  const email = readPrivateFile(emailFile, 'email');
  const password = readPrivateFile(passwordFile, 'password');
  let pool = dependencies.pool;
  if (!pool) {
    require('dotenv').config({ quiet: true });
    pool = require('./db').pool;
  }
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query('SELECT current_database() AS name');
    if (rows[0]?.name !== confirmation.split('=')[1]) throw new Error('database mismatch');
    await resetPassword(client, email, password);
    console.log('Password reset completed and all sessions revoked.');
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .catch(() => { console.error('Password reset failed; no secret details logged.'); process.exitCode = 1; });
}

module.exports = { main, readPrivateFile, resetPassword };
