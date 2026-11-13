'use strict';
const { birthday, response, contactButton, phone: normalizePhone } = require('./protocol');
const { register, cardFor } = require('./registration');
const ASK_PHONE = 'Для регистрации поделитесь своим номером телефона с помощью кнопки ниже.';
const REVIEW = 'Не удалось подтвердить результат регистрации бонусной карты. Обратитесь к администратору: нужно проверить карту и начисление. Повторно начислять бонусы автоматически не будем.';

async function handle(event, previous, { store, crm, sync, balance }) {
  let state = { ...previous };
  const out = reply => ({ state, reply });
  const askPhone = () => { state = { step: 'phone' }; return out(response(ASK_PHONE, contactButton())); };
  if (event.type === 'bot_stopped') { state.stopped = true; return out(null); }
  const text = event.text || '';
  const start = event.type === 'bot_started' || /^\/start(?:\s|$)/.test(text);
  if (state.stopped && !start) return out(null);
  if (start) {
    if (state.step === 'ready') { state.stopped = false; return out(response('Вы уже зарегистрированы в программе лояльности.')); }
    return askPhone();
  }
  if (text === '/cancel') {
    if (state.step !== 'ready') state = {};
    return out(response('Ввод анкеты отменён. Для регистрации нажмите /start.'));
  }
  if (text === '/help') return out(response('Регистрация: /start. Баланс и кешбэк: /balance. Отменить ввод анкеты: /cancel. По вопросам карты обратитесь к администратору клиники.'));
  if (text === '/balance' || text === '💳 Бонусный баланс') {
    if (state.step !== 'ready') return out(response('Сначала завершите регистрацию: /start.', contactButton()));
    // A CRM merge or reassigned phone must not disclose another person's balance.
    const owner = await crm.client(state.clientId);
    if (normalizePhone(owner?.phone) !== state.phone) return askPhone();
    const card = cardFor(await crm.cards(state.clientId), state.typeId);
    if (!card || String(card.id) !== state.cardId) return out(response('Карта не найдена. Обратитесь к администратору.'));
    const amount = await balance(state.clientId, card);
    const program = (card.programs || []).find(p => p.title === 'Программа лояльности');
    const pct = Number(program?.value) || 5; // Same rule as the Telegram bot.
    const formatted = Number(amount).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    return out(response(`💳 Ваш баланс: ${formatted} бонусов\n🏷 Уровень кешбэка: ${pct}%`));
  }
  if (!state.step || state.step === 'phone') {
    if (!event.phone) return askPhone();
    const c = await crm.search(event.phone);
    const typeId = await crm.cardType();
    // Existing loyalty clients (including Telegram) do not fill the form again.
    const card = c ? cardFor(await crm.cards(c.id), typeId) : null;
    const pending = await store.registration(event.phone);
    if (card && !pending.stage) {
      const r = { stage: 'done', clientId: String(c.id), cardId: String(card.id), typeId, welcome: false };
      await store.saveRegistration(event.phone, r);
      await sync(event.phone, r, card);
      state = { step: 'ready', phone: event.phone, clientId: r.clientId, cardId: r.cardId, typeId };
      return out(response('Ваша бонусная карта уже действует. Вы подключены к программе лояльности в MAX!'));
    }
    if (pending.stage) {
      const r = await register({ store, crm, phone: event.phone, name: pending.name, birthday: pending.birthday });
      if (r.stage === 'review') return out(response(REVIEW));
      const current = cardFor(await crm.cards(r.clientId), r.typeId);
      await sync(event.phone, r, current);
      state = { step: 'ready', phone: event.phone, clientId: r.clientId, cardId: r.cardId, typeId: r.typeId };
      return out(response('Ваша регистрация восстановлена. Бонусная карта действует.'));
    }
    state = { step: 'name', phone: event.phone };
    return out(response('Введите ваше имя:', []));
  }
  if (state.step === 'name') {
    if (text.length < 2 || text.length > 120 || /[\p{Cc}\p{Cf}<>]/u.test(text) || !/\p{L}/u.test(text) || text.startsWith('/')) {
      return out(response('Введите имя длиной от 2 до 120 символов.', []));
    }
    state = { ...state, step: 'birthday', name: text };
    return out(response('Введите дату рождения (ДД.ММ.ГГГГ):', []));
  }
  if (state.step === 'birthday') {
    const date = birthday(text);
    if (!date) return out(response('Укажите существующую дату рождения в формате ДД.ММ.ГГГГ.', []));
    const r = await register({ store, crm, phone: state.phone, name: state.name, birthday: date });
    if (r.stage === 'review') return out(response(REVIEW));
    const card = cardFor(await crm.cards(r.clientId), r.typeId);
    await sync(state.phone, r, card);
    state = { step: 'ready', phone: state.phone, clientId: r.clientId, cardId: r.cardId, typeId: r.typeId };
    return out(response(r.welcome
      ? '🎉 Вы зарегистрированы!\n🎁 Начислены 500 приветственных бонусов.'
      : '✅ Ваша бонусная карта уже действует. Вы подключены к программе лояльности в MAX!'));
  }
  return out(response('Проверить бонусный баланс можно кнопкой ниже или командой /balance.'));
}
module.exports = { handle };
