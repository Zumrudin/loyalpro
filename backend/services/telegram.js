const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'sms_activator_peri_clinic_bot';

function getBotLink() {
  return `https://t.me/${BOT_USERNAME}`;
}

module.exports = { getBotLink };
