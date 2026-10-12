'use strict';
// ============================================================
// TelegramClient — один TDLib-клиент = один аккаунт (строка messenger_accounts).
// ------------------------------------------------------------
// Авторизация — конечный автомат по updateAuthorizationState, шаги приходят
// из админки через внутренний API (телефон → код → пароль 2FA). Состояние
// пишется в messenger_accounts.auth_state, чтобы фронт мог опрашивать.
// setTdlibParameters tdl 8 шлёт САМ на authorizationStateWaitTdlibParameters
// (проверено по node_modules/tdl/dist/client.js, _handleAuthInit) — руками не
// дублируем. Состояние до шага захватываем ДО invoke: TDLib присылает новое
// updateAuthorizationState раньше ответа «ok», иначе каждый шаг ждал бы 8 с.
// Входящие и исходящие (в т.ч. набранные администратором в телефоне) идут
// в бэкенд вебхуком в форме Chatpush (lib/mapper). Наши собственные отправки
// получают delivery_id: эхо для них берём из updateMessageSendSucceeded, а
// updateNewMessage с sending_state (ещё не отправлено) пропускаем — иначе
// одно сообщение легло бы в «Чат» дважды. Временный id сообщения пишется и
// в gateway_deliveries.tdlib_temp_id: после рестарта шлюза TDLib досылает
// отправленное, и позднее updateMessageSendSucceeded находит доставку по БД.
// Порядок: события одного чата обрабатываются ПОСЛЕДОВАТЕЛЬНО (цепочка
// промисов на chat_id) — иначе текст, пришедший сразу за фото, обгонял бы
// его в транскрипте, пока фото качается.
// Сообщения старше MAX_MESSAGE_AGE_S (6 ч) в бэкенд НЕ идут: после долгого
// простоя шлюза TDLib отдаёт накопившееся, и Мила отвечала бы на вчерашнее.
// Каналы (chatTypeSupergroup.is_channel) и секретные чаты не форвардим.
// Медиа: расширение файла — ТОЛЬКО из белого списка по MIME (имя файла задаёт
// собеседник, а каталог отдаётся статикой в origin админки — .html/.svg были
// бы stored XSS), кап MAX_MEDIA_BYTES, в группах медиа не качаем, после
// копирования файл удаляется из кэша TDLib.
// Зависимости инжектятся (deps) — автомат и отправка покрыты тестами без TDLib.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./mapper');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
// importContacts Telegram лимитирует жёстко и помечает аккаунты за массовый
// импорт — это живой аккаунт клиники. Сверх суточного капа → 429, transport
// уйдёт на другой канал.
const IMPORT_CONTACTS_PER_DAY = 50;
const AUTH_STEP_WAIT_MS = 8000;

const { MAX_MEDIA_BYTES, EXT_BY_MIME, safeExt, publicFileName } = require('./media');

// Временный файл send_file лежит в собственном каталоге tmp/<hex>/ — убираем и его.
function removeTmpFile(f) {
  fs.rm(f, { force: true }, () => { fs.rmdir(path.dirname(f), () => {}); });
}

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

// Ошибка TDLib → HTTP-статус для публичного API: FLOOD_WAIT — 429 (повторять
// позже, не долбить), остальное про получателя/номер — 422.
function tdlibError(prefix, e) {
  const msg = (e && e.message) || String(e);
  const err = new Error(`${prefix}: ${msg}`);
  err.status = /FLOOD_WAIT|Too Many Requests/i.test(msg) ? 429 : 422;
  return err;
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
    this.imports = { day: null, count: 0 };
    this.pendingFiles = new Map();   // временный id сообщения TDLib → временный файл send_file
    this.chatQueues = new Map();     // chat_id → хвост цепочки обработки
    this.client = null;
    this.closed = false;
  }

  // Статический вариант — реестру: проверить, есть ли сессия у НЕ запущенного аккаунта.
  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    return { db: path.join(base, 'db'), files: path.join(base, 'files'), base };
  }

  dirs() { return TelegramClient.dirsFor(this.d.config, this.id); }

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
    this.log.info(`auth: ${st._}`);
    if (st._ === 'authorizationStateWaitTdlibParameters') { this.authState = mapped; return; }   // tdl отправит параметры сам
    if (st._ === 'authorizationStateReady') {
      try {
        this.me = await this.client.invoke({ _: 'getMe' });
        this.ownPhone = mapper.normalizePhone(this.me.phone_number) || this.ownPhone;
      } catch (e) {
        this.log.error(`getMe не удался (${e.message}) — работаем без своего номера`);
      }
      await this.d.repo.setAuth(this.id, 'ready', { error: null, phone: this.ownPhone, displayName: this.me ? mapper.fullName(this.me) : null });
      this.authState = 'ready';   // отправки разрешаем только после записи состояния в БД
      this.lastAuthError = null;
      this.log.info(`готов: ${this.ownPhone || '?'} (${this.me ? mapper.fullName(this.me) : '?'})`);
      // Свежая сессия не знает старых собеседников, пока их чаты не загружены:
      // createPrivateChat по user_id диалога со скрытым номером падал бы «user
      // not found» (класс инцидента 2026-09-18). 404 = всё уже загружено.
      this.loadAllChats().catch(e => this.log.debug(`loadChats: ${e && e.message}`));
      // Доставки, повисшие в «Принято» с прошлого запуска, — их исход уже не узнать.
      try {
        const n = await this.d.deliveries.failStale(this.id);
        if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
      } catch (e) { this.log.warn(`failStale: ${e.message}`); }
      return;
    }
    this.authState = mapped;
    if (st._ === 'authorizationStateClosed') this.closed = true;
    // Неподдерживаемые состояния (e-mail, регистрация, подтверждение с другого
    // устройства) — в auth_error, чтобы администратор видел, что произошло.
    const error = mapped === 'error' ? `неподдерживаемое состояние ${st._}` : null;
    if (error) this.lastAuthError = error;
    if (error) await this.d.repo.setAuth(this.id, mapped, { error });
    else await this.d.repo.setAuth(this.id, mapped);
  }

  // loadChats подгружает список порциями, пока TDLib не ответит 404 («всё
  // загружено»); потолок итераций — страховка от бесконечного цикла.
  async loadAllChats() {
    for (let i = 0; i < 20; i++) {
      try { await this.client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 200 }); }
      catch (e) { if (/404/.test(String(e && (e.code || e.message)))) return; throw e; }
    }
  }

  // Шаг авторизации из админки. Ошибка TDLib (неверный код/пароль) → в auth_error и в ответ.
  async authStep(step) {
    const s = step || {};
    const prev = this.authState;   // ДО invoke: новое состояние приходит раньше ответа
    try {
      if (s.phone) {
        const p = mapper.normalizePhone(s.phone) || String(s.phone).replace(/\D/g, '');
        await this.client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: '+' + p });
      } else if (s.code) {
        await this.client.invoke({ _: 'checkAuthenticationCode', code: s.code });
      } else if (s.password) {
        await this.client.invoke({ _: 'checkAuthenticationPassword', password: s.password });
      } else {
        return { authState: this.authState, error: 'пустой шаг' };
      }
      await this.waitStateChange(prev, AUTH_STEP_WAIT_MS);
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

  // Ждём смены состояния относительно prev (или таймаута). Часы — реальные:
  // инжектируемый now() в тестах может стоять на месте.
  waitStateChange(prev, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.authState !== prev || Date.now() - t0 > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  status() {
    return { authState: this.authState, phone: this.ownPhone, displayName: this.me ? mapper.fullName(this.me) : null, error: this.lastAuthError };
  }

  // События одного чата — строго по очереди.
  enqueueChat(chatId, fn) {
    const prev = this.chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chatQueues.set(chatId, next.catch(() => {}));
    return next;
  }

  // ── Входящие/эхо ─────────────────────────────────────────────
  async onNewMessage(message) {
    if (this.authState !== 'ready') return;
    if (message.sending_state) return;          // наша отправка в пути — эхо придёт из onSendSucceeded
    if (message.date && this.d.now() / 1000 - message.date > MAX_MESSAGE_AGE_S) {
      this.log.warn(`пропущено сообщение ${message.chat_id}:${message.id} старше ${MAX_MESSAGE_AGE_S / 3600} ч (date=${message.date})`);
      return;
    }
    return this.enqueueChat(message.chat_id, () => this.emitMessage(message, null));
  }

  async deliveryFor(oldMessageId) {
    // Отправка завершена (успех или отказ) — временный файл send_file TDLib больше не нужен.
    const f = this.pendingFiles.get(oldMessageId);
    if (f) { this.pendingFiles.delete(oldMessageId); removeTmpFile(f); }
    let deliveryId = this.pendingSends.get(oldMessageId) || null;
    this.pendingSends.delete(oldMessageId);
    if (!deliveryId) {
      // Рестарт между отправкой и подтверждением: связка только в БД.
      try { deliveryId = await this.d.deliveries.findByTempId(this.id, oldMessageId); }
      catch (e) { this.log.warn(`findByTempId(${oldMessageId}): ${e.message}`); }
    }
    return deliveryId;
  }

  async onSendSucceeded({ message, old_message_id }) {
    const deliveryId = await this.deliveryFor(old_message_id);
    if (deliveryId) await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.SENT, { tdlibMessageId: message.id });
    else this.log.warn(`SendSucceeded без доставки (temp id ${old_message_id}) — эхо уйдёт без delivery_id`);
    return this.enqueueChat(message.chat_id, () => this.emitMessage(message, deliveryId ? `g${deliveryId}` : null));
  }

  async onSendFailed({ old_message_id, error }) {
    const deliveryId = await this.deliveryFor(old_message_id);
    const text = error ? `${error.code} ${error.message}` : 'send failed';
    this.log.warn(`отправка не удалась (delivery g${deliveryId || '?'}): ${text}`);
    if (deliveryId) await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: text });
  }

  async emitMessage(message, deliveryId) {
    const tag = `${message.chat_id}:${message.id}`;
    let chat;
    try { chat = await this.client.invoke({ _: 'getChat', chat_id: message.chat_id }); }
    catch (e) { this.log.error(`getChat ${tag}: ${e.message} — сообщение потеряно`); return; }
    if (mapper.isChannel(chat)) return;        // посты каналов — не переписка
    const group = mapper.isGroupChat(chat);
    let peer = null;
    if (group) {
      const uid = message.sender_id && message.sender_id._ === 'messageSenderUser' ? message.sender_id.user_id : null;
      peer = uid ? await this.client.invoke({ _: 'getUser', user_id: uid }).catch(() => null) : null;
    } else if (chat.type && chat.type._ === 'chatTypePrivate') {
      peer = await this.client.invoke({ _: 'getUser', user_id: chat.type.user_id })
        .catch(e => { this.log.warn(`getUser ${tag}: ${e.message} — без номера и имени`); return null; });
    } else {
      return; // секретные чаты и прочее не поддерживаем
    }
    const content = mapper.contentOf(message.content);
    let fileUrl = null;
    if (content.file && !group) {
      try { fileUrl = await this.downloadToPublic(content.file); }
      catch (e) { this.log.warn(`медиа ${tag} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, message, chat, peer, deliveryId, fileUrl });
    await this.d.webhook.sendSafe(body);
  }

  // Скачать файл TDLib и положить в публичный каталог под случайным именем с
  // расширением из белого списка по MIME. Кэш TDLib чистим сразу.
  async downloadToPublic(file) {
    if (file.size && file.size > MAX_MEDIA_BYTES) throw new Error(`файл ${file.size} байт больше лимита ${MAX_MEDIA_BYTES}`);
    const f = await this.client.invoke({ _: 'downloadFile', file_id: file.id, priority: 1, offset: 0, limit: 0, synchronous: true });
    try {
      const src = f && f.local && f.local.path;
      if (!src || !fs.existsSync(src)) throw new Error('файл не скачан');
      // Размер до скачивания мог быть неизвестен (0) — перепроверяем по факту.
      const actual = Number((f && f.size) || 0) || fs.statSync(src).size;
      if (actual > MAX_MEDIA_BYTES) throw new Error(`файл ${actual} байт больше лимита ${MAX_MEDIA_BYTES}`);
      const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
      fs.mkdirSync(dir, { recursive: true });
      const name = publicFileName(file.mimeType);
      fs.copyFileSync(src, path.join(dir, name));
      return `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`;
    } finally {
      this.client.invoke({ _: 'deleteFile', file_id: file.id }).catch(() => {});
    }
  }

  // ── Получатель ───────────────────────────────────────────────
  // chat_id = user_id для лички (TDLib). По номеру: кэш gateway_contacts →
  // searchUserByPhoneNumber → importContacts (добавляет контакт «Клиент» в
  // адресную книгу аккаунта клиники — так же делает Chatpush; побочный эффект
  // осознанный). 0 в user_ids = номера нет в Telegram. FLOOD_WAIT на поиске
  // не маскируем importContacts'ом — отдаём 429 сразу.
  async resolveChatId({ tdlibUserId, phone }) {
    if (tdlibUserId) {
      const id = Number(tdlibUserId);
      if (!Number.isFinite(id) || id === 0) throw Object.assign(new Error(`некорректный tdlib_user_id ${tdlibUserId}`), { status: 422 });
      if (id < 0) return id;                     // группа: chat_id как есть, существование проверит sendMessage
      const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: id, force: false }).catch(e => { throw tdlibError('createPrivateChat', e); });
      return chat.id;
    }
    const p = mapper.normalizePhone(phone);
    if (!p) throw Object.assign(new Error('нет получателя: ни tdlib_user_id, ни phone'), { status: 422 });
    let userId = await this.d.repo.contactUserId(this.id, p);
    if (!userId) {
      try {
        const u = await this.client.invoke({ _: 'searchUserByPhoneNumber', phone_number: '+' + p });
        userId = u && u.id;
      } catch (e) {
        if (/FLOOD_WAIT/i.test(e && e.message)) throw tdlibError('searchUserByPhoneNumber', e);
        userId = null;
      }
    }
    if (!userId) {
      const day = new Date(this.d.now()).toISOString().slice(0, 10);
      if (this.imports.day !== day) this.imports = { day, count: 0 };
      if (this.imports.count >= IMPORT_CONTACTS_PER_DAY) {
        throw Object.assign(new Error(`суточный лимит импорта контактов (${IMPORT_CONTACTS_PER_DAY}) исчерпан`), { status: 429 });
      }
      this.imports.count++;
      // TDLib 1.8.67: contacts — importedContact (без user_id); ответ importedContacts.user_ids, 0 = номера нет в Telegram.
      const r = await this.client.invoke({ _: 'importContacts', contacts: [{ _: 'importedContact', phone_number: '+' + p, first_name: 'Клиент', last_name: '' }] })
        .catch(e => { throw tdlibError('importContacts', e); });
      userId = r && r.user_ids && r.user_ids[0];
    }
    if (!userId) throw Object.assign(new Error(`номер ${p} не найден в Telegram`), { status: 422 });
    await this.d.repo.rememberContact(this.id, p, userId);
    const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: userId, force: false }).catch(e => { throw tdlibError('createPrivateChat', e); });
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
    await this.invokeSend({ _: 'sendMessage', chat_id: chatId, input_message_content: content }, deliveryId, filePath);
    return deliveryId;
  }

  // filePath — временный файл send_file: TDLib читает его асинхронно ПОСЛЕ ответа
  // sendMessage, поэтому удаляем только по SendSucceeded/SendFailed (deliveryFor)
  // или сразу, если sendMessage отвергнут.
  async invokeSend(req, deliveryId, filePath) {
    let msg;
    try {
      msg = await this.client.invoke(req);
    } catch (e) {
      if (filePath) removeTmpFile(filePath);
      const err = tdlibError('TDLib', e);
      try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
      catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
      throw err;
    }
    this.pendingSends.set(msg.id, deliveryId);
    if (filePath) this.pendingFiles.set(msg.id, filePath);
    try { await this.d.deliveries.setTempId(deliveryId, msg.id); }
    catch (e) { this.log.warn(`delivery g${deliveryId}: temp id не записан (${e.message})`); }
  }

  async logout() {
    try { await this.client.invoke({ _: 'logOut' }); } catch (_) { /* уже разлогинен */ }
    try { await this.client.close(); } catch (_) { /* уже закрыт */ }
    this.closed = true;
    this.pendingSends.clear();
    this.pendingFiles.clear();   // остаток подберёт sweepTmp при следующем старте
    fs.rmSync(this.dirs().base, { recursive: true, force: true });
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    try { await this.client.close(); } catch (_) { /* уже закрыт */ }
    this.closed = true;
    this.pendingSends.clear();
    this.pendingFiles.clear();   // остаток подберёт sweepTmp при следующем старте
  }
}

module.exports = { TelegramClient, AUTH_MAP, MAX_MESSAGE_AGE_S, MAX_MEDIA_BYTES, IMPORT_CONTACTS_PER_DAY, safeExt, EXT_BY_MIME };
