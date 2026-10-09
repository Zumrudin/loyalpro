'use strict';
// ============================================================
// TelegramClient — один TDLib-клиент = один аккаунт (строка messenger_accounts).
// ------------------------------------------------------------
// Авторизация — конечный автомат по updateAuthorizationState, шаги приходят
// из админки через внутренний API (телефон → код → пароль 2FA). Состояние
// пишется в messenger_accounts.auth_state, чтобы фронт мог опрашивать.
// setTdlibParameters tdl 8 шлёт САМ на authorizationStateWaitTdlibParameters
// (проверено по node_modules/tdl/dist/client.js, _handleAuthInit) — руками не
// дублируем.
// Входящие и исходящие (в т.ч. набранные администратором в телефоне) идут
// в бэкенд вебхуком в форме Chatpush (lib/mapper). Наши собственные отправки
// получают delivery_id: эхо для них берём из updateMessageSendSucceeded, а
// updateNewMessage с sending_state (ещё не отправлено) пропускаем — иначе
// одно сообщение легло бы в «Чат» дважды.
// Сообщения старше MAX_MESSAGE_AGE_S (6 ч) в бэкенд НЕ идут: после долгого
// простоя шлюза TDLib отдаёт накопившееся, и Мила отвечала бы на вчерашнее.
// Зависимости инжектятся (deps) — автомат и отправка покрыты тестами без TDLib.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mapper = require('./mapper');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
const AUTH_STEP_WAIT_MS = 8000;

const AUTH_MAP = {
  authorizationStateWaitTdlibParameters: 'starting',
  authorizationStateWaitPhoneNumber: 'wait_phone',
  authorizationStateWaitCode: 'wait_code',
  authorizationStateWaitPassword: 'wait_password',
  authorizationStateReady: 'ready',
  authorizationStateLoggingOut: 'logged_out',
  authorizationStateClosing: 'logged_out',
  authorizationStateClosed: 'logged_out',
};

let tdlConfigured = false;
function defaultCreateClient(opts) {
  const tdl = require('tdl');
  const { getTdjson } = require('prebuilt-tdlib');
  const config = require('../config');
  if (!tdlConfigured) {
    tdl.configure({ tdjson: getTdjson() });
    tdl.execute({ _: 'setLogVerbosityLevel', new_verbosity_level: config.TDLIB_VERBOSITY });
    tdlConfigured = true;
  }
  return tdl.createClient(opts);
}

function defaultDeps() {
  return {
    createClient: defaultCreateClient,
    repo: require('./accounts-repo'),
    deliveries: require('./deliveries'),
    webhook: require('./webhook-sender'),
    config: require('../config'),
    now: () => Date.now(),
  };
}

class TelegramClient {
  constructor(account, deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`TG#${account.id}`);
    this.authState = 'starting';
    this.lastAuthError = null;
    this.ownPhone = mapper.normalizePhone(account.phone);
    this.me = null;
    this.pendingSends = new Map();   // временный id сообщения TDLib → id доставки
    this.client = null;
    this.closed = false;
  }

  dirs() {
    const base = path.join(this.d.config.DATA_DIR, `acc-${this.id}`);
    return { db: path.join(base, 'db'), files: path.join(base, 'files'), base };
  }

  async start() {
    const dirs = this.dirs();
    fs.mkdirSync(dirs.db, { recursive: true });
    fs.mkdirSync(dirs.files, { recursive: true });
    this.client = this.d.createClient({
      apiId: this.d.config.TG_API_ID, apiHash: this.d.config.TG_API_HASH,
      databaseDirectory: dirs.db, filesDirectory: dirs.files,
      tdlibParameters: {
        system_language_code: 'ru', device_model: 'LoyalPro Gateway', application_version: '1.0',
        use_message_database: true, use_secret_chats: false,
      },
    });
    // Возвращаем промис: tdl его игнорирует, а тесты с фейковым клиентом дожидаются обработки.
    this.client.on('update', (u) => this.onUpdate(u).catch(e => this.log.error(`update ${u && u._}: ${e.message}`)));
    this.client.on('error', (e) => this.log.error(`tdlib error: ${e && e.message ? e.message : JSON.stringify(e)}`));
    await this.d.repo.setAuth(this.id, 'starting');
    this.log.info('клиент запущен');
  }

  async onUpdate(u) {
    switch (u._) {
      case 'updateAuthorizationState': return this.onAuthState(u.authorization_state);
      case 'updateNewMessage': return this.onNewMessage(u.message);
      case 'updateMessageSendSucceeded': return this.onSendSucceeded(u);
      case 'updateMessageSendFailed': return this.onSendFailed(u);
      default: return undefined;
    }
  }

  async onAuthState(st) {
    const mapped = AUTH_MAP[st._] || 'error';
    this.authState = mapped;
    this.log.info(`auth: ${st._}`);
    if (st._ === 'authorizationStateWaitTdlibParameters') return;   // tdl отправит параметры сам
    if (st._ === 'authorizationStateReady') {
      this.me = await this.client.invoke({ _: 'getMe' });
      this.ownPhone = mapper.normalizePhone(this.me.phone_number) || this.ownPhone;
      await this.d.repo.setAuth(this.id, 'ready', { error: null, phone: this.ownPhone, displayName: mapper.fullName(this.me) });
      this.log.info(`готов: ${this.ownPhone} (${mapper.fullName(this.me)})`);
      // Доставки, повисшие в «Принято» с прошлого запуска, — их исход уже не узнать.
      try {
        const n = await this.d.deliveries.failStale(this.id);
        if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
      } catch (e) { this.log.warn(`failStale: ${e.message}`); }
      return;
    }
    if (st._ === 'authorizationStateClosed') this.closed = true;
    await this.d.repo.setAuth(this.id, mapped);
  }

  // Шаг авторизации из админки. Ошибка TDLib (неверный код/пароль) → в auth_error и в ответ.
  async authStep(step) {
    const s = step || {};
    try {
      if (s.phone) {
        await this.client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: '+' + String(s.phone).replace(/^\+/, '') });
      } else if (s.code) {
        await this.client.invoke({ _: 'checkAuthenticationCode', code: s.code });
      } else if (s.password) {
        await this.client.invoke({ _: 'checkAuthenticationPassword', password: s.password });
      } else {
        return { authState: this.authState, error: 'пустой шаг' };
      }
      await this.waitStateChange(this.authState, AUTH_STEP_WAIT_MS);
      this.lastAuthError = null;
      await this.d.repo.setAuth(this.id, this.authState, { error: null });
      return { authState: this.authState, error: null };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.lastAuthError = msg;
      await this.d.repo.setAuth(this.id, this.authState, { error: msg });
      return { authState: this.authState, error: msg };
    }
  }

  // TDLib отвечает на шаг до прихода нового состояния — дождёмся его (или таймаута).
  waitStateChange(prev, ms) {
    return new Promise((resolve) => {
      const t0 = this.d.now();
      const tick = () => {
        if (this.authState !== prev || this.d.now() - t0 > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  status() {
    return { authState: this.authState, phone: this.ownPhone, displayName: this.me ? mapper.fullName(this.me) : null, error: this.lastAuthError };
  }

  // ── Входящие/эхо ─────────────────────────────────────────────
  async onNewMessage(message) {
    if (this.authState !== 'ready') return;
    if (message.sending_state) return;          // наша отправка в пути — эхо придёт из onSendSucceeded
    if (message.date && this.d.now() / 1000 - message.date > MAX_MESSAGE_AGE_S) {
      this.log.warn(`пропущено сообщение ${message.chat_id}:${message.id} старше ${MAX_MESSAGE_AGE_S / 3600} ч (date=${message.date})`);
      return;
    }
    await this.emitMessage(message, null);
  }

  async onSendSucceeded({ message, old_message_id }) {
    const deliveryId = this.pendingSends.get(old_message_id) || null;
    this.pendingSends.delete(old_message_id);
    if (deliveryId) await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.SENT, { tdlibMessageId: message.id });
    await this.emitMessage(message, deliveryId ? `g${deliveryId}` : null);
  }

  async onSendFailed({ old_message_id, error }) {
    const deliveryId = this.pendingSends.get(old_message_id) || null;
    this.pendingSends.delete(old_message_id);
    const text = error ? `${error.code} ${error.message}` : 'send failed';
    this.log.warn(`отправка не удалась (delivery g${deliveryId || '?'}): ${text}`);
    if (deliveryId) await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: text });
  }

  async emitMessage(message, deliveryId) {
    const chat = await this.client.invoke({ _: 'getChat', chat_id: message.chat_id });
    let peer = null;
    if (mapper.isGroupChat(chat)) {
      const uid = message.sender_id && message.sender_id._ === 'messageSenderUser' ? message.sender_id.user_id : null;
      peer = uid ? await this.client.invoke({ _: 'getUser', user_id: uid }).catch(() => null) : null;
    } else if (chat.type && chat.type._ === 'chatTypePrivate') {
      peer = await this.client.invoke({ _: 'getUser', user_id: chat.type.user_id });
    } else {
      return; // секретные чаты и прочее не поддерживаем
    }
    const content = mapper.contentOf(message.content);
    let fileUrl = null;
    if (content.file) {
      try { fileUrl = await this.downloadToPublic(content.file); }
      catch (e) { this.log.warn(`медиа ${message.chat_id}:${message.id} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, message, chat, peer, deliveryId, fileUrl });
    await this.d.webhook.sendSafe(body);
  }

  // Скачать файл TDLib и положить в публичный каталог под случайным именем.
  async downloadToPublic(file) {
    const f = await this.client.invoke({ _: 'downloadFile', file_id: file.id, priority: 1, offset: 0, limit: 0, synchronous: true });
    const src = f && f.local && f.local.path;
    if (!src || !fs.existsSync(src)) throw new Error('файл не скачан');
    const byMime = { 'image/jpeg': '.jpg', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
    const ext = (file.fileName && path.extname(file.fileName)) || byMime[file.mimeType] || path.extname(src) || '';
    const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.copyFileSync(src, path.join(dir, name));
    return `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`;
  }

  // ── Получатель ───────────────────────────────────────────────
  // chat_id = user_id для лички (TDLib). По номеру: кэш gateway_contacts →
  // searchUserByPhoneNumber → importContacts (добавляет в контакты аккаунта —
  // так же делает Chatpush). 0 в user_ids = номера нет в Telegram.
  async resolveChatId({ tdlibUserId, phone }) {
    if (tdlibUserId) {
      const id = Number(tdlibUserId);
      if (!Number.isFinite(id) || id === 0) throw Object.assign(new Error(`некорректный tdlib_user_id ${tdlibUserId}`), { status: 422 });
      if (id < 0) return id;                     // группа: chat_id как есть
      const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: id, force: false });
      return chat.id;
    }
    const p = mapper.normalizePhone(phone);
    if (!p) throw Object.assign(new Error('нет получателя: ни tdlib_user_id, ни phone'), { status: 422 });
    let userId = await this.d.repo.contactUserId(this.id, p);
    if (!userId) {
      try {
        const u = await this.client.invoke({ _: 'searchUserByPhoneNumber', phone_number: '+' + p });
        userId = u && u.id;
      } catch (_) { userId = null; }
    }
    if (!userId) {
      // TDLib 1.8.67: contacts — importedContact (без user_id); ответ importedContacts.user_ids, 0 = номера нет в Telegram.
      const r = await this.client.invoke({ _: 'importContacts', contacts: [{ _: 'importedContact', phone_number: '+' + p, first_name: 'Клиент', last_name: '' }] });
      userId = r && r.user_ids && r.user_ids[0];
    }
    if (!userId) throw Object.assign(new Error(`номер ${p} не найден в Telegram`), { status: 422 });
    await this.d.repo.rememberContact(this.id, p, userId);
    const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: userId, force: false });
    return chat.id;
  }

  // ── Отправка ─────────────────────────────────────────────────
  requireReady() {
    if (this.authState !== 'ready') throw Object.assign(new Error(`аккаунт не авторизован (${this.authState})`), { status: 422 });
  }

  async sendText({ text, phone, tdlibUserId, replyToMessageId }) {
    this.requireReady();
    const chatId = await this.resolveChatId({ tdlibUserId, phone });
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: mapper.normalizePhone(phone), kind: 'text', text });
    const reply = mapper.parseCompositeId(replyToMessageId);
    const req = {
      _: 'sendMessage', chat_id: chatId,
      input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text, entities: [] } },
    };
    // reply_to только в ТОМ ЖЕ чате и только наш составной id: числовой id
    // Chatpush-эпохи (после переключения канала) просто игнорируется.
    if (reply && reply.chatId === chatId) req.reply_to = { _: 'inputMessageReplyToMessage', message_id: reply.messageId };
    await this.invokeSend(req, deliveryId);
    return deliveryId;
  }

  async sendFile({ filePath, fileName, caption, type, phone, tdlibUserId }) {
    this.requireReady();
    const chatId = await this.resolveChatId({ tdlibUserId, phone });
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: mapper.normalizePhone(phone), kind: 'file', text: caption || fileName });
    const cap = { _: 'formattedText', text: caption || '', entities: [] };
    // TDLib 1.8.67: файл обёрнут в inputPhoto/inputDocument, внутри — InputFile.
    const local = { _: 'inputFileLocal', path: filePath };
    const content = type === 'image'
      ? { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: local }, caption: cap }
      : { _: 'inputMessageDocument', document: { _: 'inputDocument', document: local }, caption: cap };
    await this.invokeSend({ _: 'sendMessage', chat_id: chatId, input_message_content: content }, deliveryId);
    return deliveryId;
  }

  async invokeSend(req, deliveryId) {
    try {
      const msg = await this.client.invoke(req);
      this.pendingSends.set(msg.id, deliveryId);
    } catch (e) {
      await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message });
      throw Object.assign(new Error(`TDLib: ${e.message}`), { status: 422 });
    }
  }

  async logout() {
    try { await this.client.invoke({ _: 'logOut' }); } catch (_) { /* уже разлогинен */ }
    try { await this.client.close(); } catch (_) { /* уже закрыт */ }
    this.closed = true;
    fs.rmSync(this.dirs().base, { recursive: true, force: true });
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    try { await this.client.close(); } catch (_) { /* уже закрыт */ }
    this.closed = true;
  }
}

module.exports = { TelegramClient, AUTH_MAP, MAX_MESSAGE_AGE_S };
