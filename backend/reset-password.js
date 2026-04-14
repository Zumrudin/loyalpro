#!/usr/bin/env node
// ============================================================
// Password Reset Script for LoyalPro
// Usage: node reset-password.js <email> <new_password>
// ============================================================

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function resetPassword(email, newPassword) {
  if (!email || !newPassword) {
    console.error('❌ Usage: node reset-password.js <email> <new_password>');
    console.error('Example: node reset-password.js zizy05zizy@mail.ru MyNewPassword123');
    process.exit(1);
  }

  if (newPassword.length < 6) {
    console.error('❌ Пароль должен быть минимум 6 символов');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // Check if user exists
    const user = await client.query(
      'SELECT id, name, email FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (user.rows.length === 0) {
      console.error(`❌ Пользователь с email "${email}" не найден`);
      process.exit(1);
    }

    const userId = user.rows[0].id;
    const userName = user.rows[0].name;

    // Hash new password
    const hash = await bcrypt.hash(newPassword, 12);

    // Update password
    const result = await client.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2 RETURNING id, email, name',
      [hash, userId]
    );

    console.log('✅ Пароль успешно сброшен!');
    console.log('');
    console.log('Данные для входа:');
    console.log(`   Email: ${result.rows[0].email}`);
    console.log(`   Пароль: ${newPassword}`);
    console.log(`   Пользователь: ${result.rows[0].name}`);
    console.log('');
    console.log('🔐 Убедитесь, что сохранили новый пароль в безопасном месте!');

  } catch (error) {
    console.error('❌ Ошибка при сбросе пароля:', error.message);
    process.exit(1);
  } finally {
    await client.release();
    process.exit(0);
  }
}

// Get arguments from command line
const [email, password] = process.argv.slice(2);
resetPassword(email, password);
