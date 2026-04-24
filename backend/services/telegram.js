const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'sms_activator_peri_clinic_bot';

function getBotLink(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `https://t.me/${BOT_USERNAME}?start=${digits}`;
}

module.exports = { getBotLink };
