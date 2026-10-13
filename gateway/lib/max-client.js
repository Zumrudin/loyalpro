'use strict';
// ============================================================
// MaxClient — одна веб-сессия MAX (как вкладка web.max.ru) = один аккаунт
// (строка messenger_accounts, channel='max'). Интерфейс тот же, что у
// TelegramClient и WhatsappClient (server.js и registry.js зовут их одинаково).
// Протокол — lib/max/transport.js + lib/max/protocol.js; референсы max-account-api
// (типы) и PyMax (payloads); спека docs/superpowers/specs/2026-10-13-max-gateway-design.md.
// Авторизация: QR (QR_START → опрос QR_POLL → QR_LOGIN [→ 115 пароль 2FA] → LOGIN) —
// основной путь, QR живёт 120 с, раунды до MAX_QR_ROUNDS; номер + SMS
// (AUTH_REQUEST → AUTH [→ 115] → LOGIN) — по PyMax на веб-транспорте, живьём не
// проверен (спека §3.2). Сессия — data/acc-<id>/max/session.json (deviceId +
// loginToken), переживает рестарт: HELLO + LOGIN по токену.
// LOGIN отверг токен (FAIL_LOGIN_TOKEN/FAIL_LOGOUT_ALL — разлогин с телефона) —
// logged_out без реконнекта, сессия удалена. Любой другой обрыв — реконнект
// 2 с → 60 с: новый транспорт, HELLO, LOGIN; в wait_qr — новый QR-раунд (trackId
// привязан к соединению). Пока соединения нет, отправка — 422 ДО создания доставки.
// Входящие — push NOTIF_MESSAGE (квитируем), своё сообщение с телефона
// (sender === ownerId) — эхо без delivery_id → бэкенд ставит паузу «ответил
// оператор», как в Telegram. Эхо СВОЕЙ отправки синтезируем из ответа MSG_SEND;
// push с тем же id пропускаем (ownSends). Собеседник личного диалога — второй
// участник снимка чата, иначе chatId XOR ownerId (PyMax); расхождение логируем раз.
// Зависимости инжектятся (deps) — тесты без сети и БД.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./max-mapper');
const { normalizePhone } = require('./mapper');
const { MAX_MEDIA_BYTES, publicFileName } = require('./media');
const { Op, webUserAgent, isTokenRevoked, DEFAULT_WS_URL } = require('./max/protocol');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
const RECONNECT_MS = [2000, 5000, 10000, 30000, 60000];
const MAX_QR_ROUNDS = 5;
const QR_ABANDONED_ERROR = 'QR не отсканирован — подключение остановлено, запустите заново';
const QR_POLL_MIN_MS = 2000;
const OWN_SEND_TTL_MS = 30 * 60 * 1000;
const FILE_READY_TIMEOUT_MS = 60 * 1000;
const ATTACH_RETRY_MS = 2000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const LOGIN_CHATS_COUNT = 200;
const CONTACTS_CACHE_MAX = 20000;

function defaultDeps() {
  return {
    Transport: require('./max/transport').MaxTransport,
    session: require('./max/session'),
    media: require('./max/media'),
    http: (opts) => require('axios')(opts),
    qrToDataUrl: (s) => require('qrcode').toDataURL(s, { margin: 1, width: 320 }),
    repo: require('./accounts-repo'),
    deliveries: require('./deliveries'),
    webhook: require('./webhook-sender'),
    config: require('../config'),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

function httpError(message, status) { return Object.assign(new Error(message), { status }); }

class MaxClient {
  constructor(account, deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`MAX#${account.id}`);
    this.authState = 'starting';
    this.lastAuthError = null;
    this.ownerId = null;
    this.ownPhone = normalizePhone(account.phone);
    this.displayName = null;
    this.qr = null;
    this.codeLength = null;
    this.passwordHint = null;
    this.transport = null;
    this.connected = false;
    this.closed = false;
    this.reconnects = 0;
    this.reconnecting = false;
    this.sess = null;
    this.qrRounds = 0;
    this.qrTrack = null;             // {trackId, expiresAt, pollMs} текущего QR-раунда
    this.sms = null;                 // {token, phone} после AUTH_REQUEST
    this.passwordTrackId = null;     // trackId вызова пароля 2FA
    this.chats = new Map();          // chatId → снимок чата (type, title, participants)
    this.contacts = new Map();       // userId → {id, phone, name}
    this.ownSends = new Map();       // message.id → {deliveryId, ts}
    this.chatQueues = new Map();
    this.fileWaiters = new Map();    // fileId → resolve() ожидания NOTIF_ATTACH
    this.cidPrev = 0;
    this.diag = { xor: 0, hello: 0 };
  }

  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    return { max: path.join(base, 'max'), base };
  }
  dirs() { return MaxClient.dirsFor(this.d.config, this.id); }

  async start() {
    fs.mkdirSync(this.dirs().max, { recursive: true });
    await this.d.repo.setAuth(this.id, 'starting');
    this.sess = this.d.session.load(this.dirs().max);
    await this.connect();
    this.log.info('клиент запущен');
  }

  // ── Соединение ───────────────────────────────────────────────
  async connect() {
    if (this.closed) return;
    const t = new this.d.Transport({ url: this.d.config.MAX_WS_URL || DEFAULT_WS_URL, requestTimeoutMs: this.d.config.MAX_REQUEST_TIMEOUT_MS });
    const old = this.transport;
    this.transport = t;
    if (old) { old.removeAllListeners(); try { old.close(); } catch (_) { /* уже закрыт */ } }
    t.on('push', (f) => { if (this.transport === t) this.onPush(f).catch(e => this.log.error(`push op ${f && f.opcode}: ${e.message}`)); });
    t.on('close', (code, reason) => { if (this.transport === t) this.onClose(code, reason).catch(e => this.log.error(`close: ${e.message}`)); });
    t.on('error', (e) => this.log.warn(`транспорт: ${e.message}`));
    await t.connect();
    if (this.closed) { t.close(); return; }
    await this.hello(t);
    if (this.sess.loginToken) await this.login();
    else await this.beginQr();
  }

  async hello(t) {
    const r = await t.request(Op.HELLO, { userAgent: webUserAgent(this.d.config.MAX_WEB_APP_VERSION), deviceId: this.sess.deviceId });
    const h = r || {};
    if (this.diag.hello++ === 0) this.log.info(`HELLO: location=${h.location} phone-auth=${h['phone-auth-enabled']}`);
    if (h['app-update-type']) this.log.warn(`MAX просит обновить клиент (app-update-type=${h['app-update-type']}) — проверьте MAX_WEB_APP_VERSION`);
    return h;
  }

  async onClose(code, reason) {
    this.connected = false;
    if (this.closed) return;
    this.log.warn(`соединение закрыто (code=${code || '?'}${reason ? ' ' + reason : ''})`);
    this.qr = null; this.qrTrack = null;          // trackId живёт в рамках соединения
    await this.reconnect();
  }

  // Бэкофф 2 с → 60 с; один цикл на клиент (close во время connect не плодит второй).
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.closed) {
        const wait = RECONNECT_MS[Math.min(this.reconnects++, RECONNECT_MS.length - 1)];
        await this.d.sleep(wait);
        if (this.closed) return;
        try { await this.connect(); return; }
        catch (e) { this.log.error(`реконнект не удался: ${e.message}`); }
      }
    } finally { this.reconnecting = false; }
  }

  // ── Состояние ────────────────────────────────────────────────
  async setState(state, { error = null, phone, displayName } = {}) {
    this.authState = state;
    this.lastAuthError = error;
    await this.d.repo.setAuth(this.id, state, { error, phone, displayName });
  }

  // stop:true — терминальная ошибка (клиент закрыт, новый «Подключить» пересоздаст);
  // stop:false — ошибка шага, состояние не меняется.
  async fail(message, { stop }) {
    this.log.error(message);
    if (stop) {
      this.closed = true; this.qr = null; this.qrTrack = null;
      if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
      await this.setState('error', { error: message });
    } else {
      this.lastAuthError = message;
      await this.d.repo.setAuth(this.id, this.authState, { error: message });
    }
  }

  saveSession() {
    try { this.d.session.save(this.dirs().max, this.sess); }
    catch (e) { this.log.error(`сессия не сохранена: ${e.message}`); }
  }

  // ── QR ───────────────────────────────────────────────────────
  async beginQr() {
    if (this.closed || !this.transport) return;
    if (++this.qrRounds > MAX_QR_ROUNDS) { await this.fail(QR_ABANDONED_ERROR, { stop: true }); return; }
    let r;
    try { r = await this.transport.request(Op.QR_START); }
    catch (e) { this.log.warn(`QR_START: ${e.message}`); return; }     // обрыв → onClose → реконнект → новый раунд
    if (!r || !r.trackId || !r.qrLink) { await this.fail('QR_START: ответ без trackId/qrLink', { stop: false }); return; }
    const track = {
      trackId: r.trackId,
      expiresAt: Number(r.expiresAt) || (this.d.now() + (Number(r.ttl) || 120000)),
      pollMs: Math.max(QR_POLL_MIN_MS, Number(r.pollingInterval) || 5000),
    };
    this.qrTrack = track;
    this.qr = await this.d.qrToDataUrl(r.qrLink).catch(e => { this.log.warn(`qr: ${e.message}`); return null; });
    await this.setState('wait_qr', { error: null });
    this.log.info(`QR-раунд ${this.qrRounds}/${MAX_QR_ROUNDS}: ждём сканирования`);
    this.pollQr(track).catch(e => this.log.error(`опрос QR: ${e.message}`));
  }

  async pollQr(track) {
    while (!this.closed && this.qrTrack === track && this.authState === 'wait_qr') {
      await this.d.sleep(track.pollMs);
      if (this.closed || this.qrTrack !== track || this.authState !== 'wait_qr' || !this.transport) return;
      if (this.d.now() >= track.expiresAt) {
        this.qrTrack = null; this.qr = null;
        await this.beginQr();
        return;
      }
      let p;
      try { p = await this.transport.request(Op.QR_POLL, { trackId: track.trackId }); }
      catch (e) { this.log.warn(`QR_POLL: ${e.message}`); continue; }
      if (p && p.status && p.status.loginAvailable) {
        if (this.qrTrack !== track) return;
        this.qrTrack = null;
        try {
          const res = await this.transport.request(Op.QR_LOGIN, { trackId: track.trackId });
          await this.handleTokenResponse(res);
        } catch (e) {
          await this.fail(`вход по QR: ${e.message}`, { stop: false });
          await this.beginQr();
        }
        return;
      }
    }
  }

  // Ответ QR_LOGIN / AUTH / 115: токен → LOGIN; passwordChallenge → wait_password.
  async handleTokenResponse(res) {
    const token = res && res.tokenAttrs && res.tokenAttrs.LOGIN && res.tokenAttrs.LOGIN.token;
    if (token) {
      this.sess.loginToken = String(token);
      this.saveSession();
      this.sms = null; this.passwordTrackId = null; this.passwordHint = null; this.qr = null; this.qrTrack = null;
      await this.login();
      return;
    }
    const ch = res && res.passwordChallenge;
    if (ch && ch.trackId) {
      this.passwordTrackId = String(ch.trackId);
      this.passwordHint = ch.hint ? String(ch.hint) : null;
      this.qr = null; this.qrTrack = null;
      await this.setState('wait_password', { error: null });
      return;
    }
    throw new Error('ответ MAX без токена входа');
  }

  // ── Вход по номеру (веб-транспорт, по PyMax) ─────────────────
  async authStep(step) {
    const s = step || {};
    try {
      if (s.phone !== undefined && s.phone !== null && s.phone !== '') {
        if (this.authState !== 'wait_qr' || !this.transport) return this.stepError(`номер принимается только в состоянии wait_qr (сейчас ${this.authState})`);
        const p = normalizePhone(s.phone);
        if (!p) return this.stepError('некорректный номер');
        const r = await this.transport.request(Op.AUTH_REQUEST, { phone: '+' + p, type: 'START_AUTH' });
        if (!r || !r.token) throw new Error('MAX не вернул токен запроса кода');
        this.sms = { token: String(r.token), phone: p };
        this.codeLength = Number(r.codeLength) || null;
        this.qrTrack = null; this.qr = null;        // опрос QR останавливается
        await this.setState('wait_code', { error: null, phone: p });
        return this.stepOk({ codeLength: this.codeLength });
      }
      if (s.code) {
        if (this.authState !== 'wait_code' || !this.sms || !this.transport) return this.stepError(`код принимается только в состоянии wait_code (сейчас ${this.authState})`);
        const r = await this.transport.request(Op.AUTH, { token: this.sms.token, verifyCode: String(s.code), authTokenType: 'CHECK_CODE' });
        await this.handleTokenResponse(r);
        return this.stepOk();
      }
      if (s.password) {
        if (this.authState !== 'wait_password' || !this.passwordTrackId || !this.transport) return this.stepError(`пароль принимается только в состоянии wait_password (сейчас ${this.authState})`);
        const r = await this.transport.request(Op.AUTH_CHECK_PASSWORD, { trackId: this.passwordTrackId, password: String(s.password) });
        if (r && r.error) throw new Error(String(r.error));
        await this.handleTokenResponse(r);
        return this.stepOk();
      }
      return this.stepError('нужен phone, code или password');
    } catch (e) {
      const msg = e.message || String(e);
      this.lastAuthError = msg;
      try { await this.d.repo.setAuth(this.id, this.authState, { error: msg }); } catch (_) { /* best-effort */ }
      return { authState: this.authState, error: msg };
    }
  }
  stepOk(extra = {}) { return { authState: this.authState, error: null, qr: this.authState === 'wait_qr' ? this.qr : null, ...extra }; }
  stepError(msg) { return { authState: this.authState, error: msg }; }

  // ── LOGIN ────────────────────────────────────────────────────
  async login() {
    const t = this.transport;
    let r;
    try {
      r = await t.request(Op.LOGIN, { token: this.sess.loginToken, chatsCount: LOGIN_CHATS_COUNT, interactive: true, chatsSync: 0, contactsSync: 0, presenceSync: -1, draftsSync: 0 });
    } catch (e) {
      if (isTokenRevoked(e)) { await this.onLoggedOut(`сессия MAX отозвана (${e.code})`); return; }
      throw e;
    }
    if (this.closed || this.transport !== t) return;
    const contact = (r && r.profile && r.profile.contact) || {};
    if (contact.id !== undefined && contact.id !== null) this.ownerId = Number(contact.id);
    const phone = contact.phone !== undefined && contact.phone !== null ? normalizePhone(String(contact.phone)) : null;
    if (phone) this.ownPhone = phone;
    const name = Array.isArray(contact.names) && contact.names[0] && contact.names[0].name;
    if (name) this.displayName = String(name);
    if (r && r.token && r.token !== this.sess.loginToken) this.sess.loginToken = String(r.token);   // ротация
    Object.assign(this.sess, { ownerId: this.ownerId, phone: this.ownPhone, displayName: this.displayName });
    this.saveSession();
    for (const c of (r && r.chats) || []) if (c && c.id !== undefined && c.id !== null) this.chats.set(Number(c.id), c);
    for (const c of (r && r.contacts) || []) this.rememberContactInfo(c);
    this.connected = true;
    this.qr = null; this.qrTrack = null; this.reconnects = 0; this.qrRounds = 0;
    await this.setState('ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
    this.log.info(`готов: ${this.ownPhone || '?'} (${this.displayName || '?'}, id ${this.ownerId})`);
    try {
      const n = await this.d.deliveries.failStale(this.id);
      if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
    } catch (e) { this.log.warn(`failStale: ${e.message}`); }
  }

  async onLoggedOut(reason) {
    this.closed = true; this.connected = false;
    if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
    this.d.session.remove(this.dirs().max);
    this.qr = null; this.qrTrack = null; this.authState = 'logged_out';
    await this.d.repo.setAuth(this.id, 'logged_out', { error: reason });
    this.log.warn(reason);
  }

  // Контакт из LOGIN/CONTACT_INFO/NOTIF_PROFILE → кэш и gateway_contacts (номер виден
  // не всегда — приватность; свой номер не пишем).
  rememberContactInfo(c) {
    if (!c || c.id === undefined || c.id === null) return null;
    const id = Number(c.id);
    const phone = c.phone !== undefined && c.phone !== null && c.phone !== '' ? normalizePhone(String(c.phone)) : null;
    const n0 = Array.isArray(c.names) && c.names[0] ? c.names[0] : null;
    const name = n0 ? (String(n0.name || [n0.firstName, n0.lastName].filter(Boolean).join(' ')).trim() || null) : null;
    const prev = this.contacts.get(id) || {};
    const info = { id, phone: phone || prev.phone || null, name: name || prev.name || null };
    if (!this.contacts.has(id) && this.contacts.size >= CONTACTS_CACHE_MAX) this.contacts.delete(this.contacts.keys().next().value);
    this.contacts.set(id, info);
    if (phone && phone !== prev.phone && id !== this.ownerId) {
      this.d.repo.rememberContact(this.id, phone, String(id)).catch(e => this.log.warn(`rememberContact: ${e.message}`));
    }
    return info;
  }

  // ── Push-события ─────────────────────────────────────────────
  async onPush(frame) {
    if (!frame || this.closed) return;
    const p = frame.payload || {};
    switch (frame.opcode) {
      case Op.NOTIF_MESSAGE: {
        if (this.transport) this.transport.ack(frame, { chatId: p.chatId, messageId: p.message && p.message.id });
        if (!p.message || p.chatId === undefined || p.chatId === null) return;
        const chatId = Number(p.chatId);
        await this.enqueueChat(chatId, () => this.onMessage(chatId, p.message));
        return;
      }
      case Op.NOTIF_CHAT:
        if (p.chat && p.chat.id !== undefined && p.chat.id !== null) this.chats.set(Number(p.chat.id), p.chat);
        return;
      case Op.NOTIF_ATTACH: {
        const w = this.fileWaiters.get(String(p.fileId));
        if (w) w();
        return;
      }
      case Op.NOTIF_PROFILE: {
        const c = p.profile && p.profile.contact;
        if (c) this.rememberContactInfo(c);
        return;
      }
      default:
        return;
    }
  }

  // ── Входящие ─────────────────────────────────────────────────
  async onMessage(chatId, message) {
    if (!this.connected || this.ownerId === null || !message) return;
    const id = String(message.id);
    this.pruneOwnSends();
    if (this.ownSends.has(id)) return;                     // наша отправка — эхо уже синтезировано
    if (chatId === 0) return;                              // «Избранное» (чат с собой)
    const chat = this.chats.get(chatId) || null;
    if (mapper.isChannel(chat)) return;                    // каналы не форвардим (как рассылки WhatsApp)
    if (!mapper.contentOf(message)) return;                // служебное / правка / пусто
    const ts = mapper.tsSeconds(message.time);
    if (ts && Math.floor(this.d.now() / 1000) - ts > MAX_MESSAGE_AGE_S) return;
    await this.emitMessage(chatId, message, null);
  }

  // Общий путь входящих и синтезированного эха своей отправки.
  async emitMessage(chatId, message, deliveryId) {
    const chat = this.chats.get(chatId) || null;
    const group = mapper.isGroupChat({ chatId, chat });
    const outgoing = Number(message.sender) === this.ownerId;
    let peerId = null;
    if (group) {
      peerId = outgoing ? null : Number(message.sender);
    } else {
      peerId = mapper.peerIdOf({ chatId, chat, ownerId: this.ownerId });
      if (chat && chat.participants && this.diag.xor++ === 0) {
        const x = mapper.xorId(chatId, this.ownerId);
        this.log.info(`диалог ${chatId}: участник ${peerId}, XOR даёт ${x} — ${x === peerId ? 'совпадает' : 'НЕ совпадает'}`);
      }
      if (peerId === this.ownerId) return;                 // чат с собой
    }
    const peer = peerId !== null ? await this.resolveContact(peerId) : null;
    const content = mapper.contentOf(message) || { type: 'unsupported', text: '', media: null };
    let fileUrl = null;
    if (content.media && !group) {
      try {
        const dl = await this.downloadToPublic(chatId, message, content.media);
        fileUrl = dl.fileUrl;
        if (dl.mimeType) content.media.mimeType = dl.mimeType;
      } catch (e) { this.log.warn(`медиа ${chatId}:${message.id} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, ownerId: this.ownerId, chatId, chat, message, peer, deliveryId, fileUrl, content });
    await this.d.webhook.sendSafe(body);
  }

  // Кэш → CONTACT_INFO (один раз на id) → gateway_contacts (номер, когда MAX его скрыл).
  async resolveContact(userId) {
    const id = Number(userId);
    const hit = this.contacts.get(id);
    if (hit && hit.phone) return hit;
    let info = hit || null;
    if (!info && this.transport && this.connected) {
      try {
        const r = await this.transport.request(Op.CONTACT_INFO, { contactIds: [id] });
        const c = r && Array.isArray(r.contacts) ? r.contacts.find(x => x && Number(x.id) === id) : null;
        if (c) info = this.rememberContactInfo(c);
      } catch (e) { this.log.warn(`CONTACT_INFO(${id}): ${e.message}`); }
    }
    if (!info) info = { id, phone: null, name: null };
    if (!info.phone) {
      try {
        const p = await this.d.repo.phoneByUserId(this.id, String(id));
        if (p) info = { ...info, phone: p };
      } catch (e) { this.log.warn(`phoneByUserId(${id}): ${e.message}`); }
    }
    this.contacts.set(id, info);
    return info;
  }

  // Фото — по baseUrl; файл — временный URL через FILE_DOWNLOAD. Кап по заявленному
  // размеру (ранний отказ) и по факту (media.download); расширение — только из
  // белого списка по MIME (публичный каталог отдаётся статикой в origin админки).
  async downloadToPublic(chatId, message, media) {
    const max = this.d.maxMediaBytes || MAX_MEDIA_BYTES;
    if (media.size && media.size > max) throw new Error(`файл ${media.size} байт больше лимита ${max}`);
    let url = media.url;
    if (!url && media.kind === 'FILE' && media.fileId !== null && media.fileId !== undefined) {
      const r = await this.transport.request(Op.FILE_DOWNLOAD, { fileId: media.fileId, chatId, messageId: String(message.id) });
      url = r && r.url;
    }
    if (!url) throw new Error('нет ссылки на файл');
    const { buf, mimeType: headerMime } = await this.d.media.download(url, { http: this.d.http, maxBytes: max, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
    const declared = media.mimeType && media.mimeType !== 'application/octet-stream' ? media.mimeType : null;
    const mimeType = (media.kind === 'FILE' && declared) ? declared : (headerMime || declared || media.mimeType);
    const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = publicFileName(mimeType, this.d.now());
    fs.writeFileSync(path.join(dir, name), buf);
    return { fileUrl: `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`, mimeType };
  }

  status() {
    return {
      authState: this.authState, phone: this.ownPhone, displayName: this.displayName, error: this.lastAuthError,
      qr: this.authState === 'wait_qr' ? this.qr : null, pairingCode: null,
      codeLength: this.authState === 'wait_code' ? this.codeLength : null,
      passwordHint: this.authState === 'wait_password' ? this.passwordHint : null,
    };
  }

  enqueueChat(chatId, fn) {
    const prev = this.chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chatQueues.set(chatId, tail);
    tail.then(() => { if (this.chatQueues.get(chatId) === tail) this.chatQueues.delete(chatId); });
    return next;
  }

  pruneOwnSends() {
    const cutoff = this.d.now() - OWN_SEND_TTL_MS;
    for (const [id, v] of this.ownSends) if (v.ts < cutoff) this.ownSends.delete(id);
  }

  // ── Отправка ─────────────────────────────────────────────────
  requireReady() {
    if (this.authState !== 'ready') throw httpError(`аккаунт не авторизован (${this.authState})`, 422);
    if (!this.connected || !this.transport || !this.transport.isOpen) throw httpError('нет соединения с MAX (переподключение)', 422);
  }

  // Клиентский id сообщения — миллисекунды, монотонно (PyMax _next_cid).
  nextCid() {
    const now = this.d.now();
    this.cidPrev = Math.max(now, this.cidPrev + 1);
    return this.cidPrev;
  }

  // → {chatId, peerId, phone}. max_user_id главнее номера: это id диалога из нашей
  // БД (положительный — собеседник, отрицательный — группа как есть). По номеру:
  // кэш контактов → gateway_contacts → CONTACT_INFO_BY_PHONE. Ничего не отправлено →
  // 422, чтобы transport ушёл на следующий канал каскада.
  async resolveChat({ maxUserId, phone }) {
    const p = normalizePhone(phone);
    if (maxUserId !== undefined && maxUserId !== null && String(maxUserId) !== '') {
      const n = Number(maxUserId);
      if (!Number.isInteger(n) || n === 0) throw httpError(`некорректный max_user_id ${maxUserId}`, 422);
      if (n < 0) return { chatId: n, peerId: null, phone: p };
      return { chatId: mapper.xorId(this.ownerId, n), peerId: n, phone: p };
    }
    if (!p) throw httpError('нет получателя: ни max_user_id, ни phone', 422);
    let userId = null;
    for (const c of this.contacts.values()) if (c.phone === p) { userId = c.id; break; }
    if (!userId) {
      try { userId = await this.d.repo.contactUserId(this.id, p); }
      catch (e) { this.log.warn(`contactUserId(${p}): ${e.message}`); }
    }
    if (!userId) {
      try {
        const r = await this.transport.request(Op.CONTACT_INFO_BY_PHONE, { phone: '+' + p });
        const c = r && r.contact;
        if (c && c.id !== undefined && c.id !== null) {
          userId = Number(c.id);
          this.rememberContactInfo({ ...c, phone: c.phone || p });
        }
      } catch (e) {
        throw httpError(`номер ${p} не найден в MAX (${e.code || e.message})`, 422);
      }
    }
    if (!userId) throw httpError(`номер ${p} не найден в MAX`, 422);
    return { chatId: mapper.xorId(this.ownerId, Number(userId)), peerId: Number(userId), phone: p };
  }

  async sendText({ text, phone, maxUserId, replyToMessageId }) {
    this.requireReady();
    const { chatId, phone: p } = await this.resolveChat({ maxUserId, phone });
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: p, kind: 'text', text });
    const message = { text: String(text), cid: this.nextCid(), elements: [], attaches: [] };
    // reply только на id MAX (строка цифр); составной id Telegram-эпохи или
    // числовой id Chatpush-эпохи другого канала просто игнорируется.
    if (replyToMessageId && /^\d{1,30}$/.test(String(replyToMessageId))) message.link = { type: 'REPLY', messageId: String(replyToMessageId) };
    await this.invokeSend(chatId, message, deliveryId);
    return deliveryId;
  }

  // Временный файл read + rm сразу (как WhatsApp): ЧИТАЕМ ДО создания доставки.
  // Фото (type=image с image/* MIME) — PHOTO_UPLOAD + multipart; остальное —
  // FILE_UPLOAD + сырой POST + ожидание NOTIF_ATTACH.
  async sendFile({ filePath, fileName, caption, type, phone, maxUserId, mimeType }) {
    this.requireReady();
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { throw httpError(`файл не прочитан: ${e.message}`, 422); }
    finally {
      try { fs.rmSync(filePath, { force: true }); } catch (_) { /* подберёт страховочный таймер server.js */ }
      fs.rmdir(path.dirname(filePath), () => {});
    }
    const { chatId, phone: p } = await this.resolveChat({ maxUserId, phone });
    const mime = mimeType || mapper.mimeOfName(fileName);
    let attaches;
    if (type === 'image' && /^image\//.test(mime)) {
      const r = await this.transport.request(Op.PHOTO_UPLOAD, { count: 1 }).catch(e => { throw httpError(`MAX PHOTO_UPLOAD: ${e.message}`, 422); });
      if (!r || !r.url) throw httpError('MAX PHOTO_UPLOAD: нет URL загрузки', 422);
      const token = await this.d.media.uploadPhoto(r.url, buf, fileName, mime, { http: this.d.http }).catch(e => { throw httpError(`MAX: ${e.message}`, 422); });
      attaches = [{ _type: 'PHOTO', photoToken: token }];
    } else {
      const r = await this.transport.request(Op.FILE_UPLOAD, { count: 1 }).catch(e => { throw httpError(`MAX FILE_UPLOAD: ${e.message}`, 422); });
      const info = r && Array.isArray(r.info) && r.info[0];
      if (!info || !info.url) throw httpError('MAX FILE_UPLOAD: нет слота загрузки', 422);
      const ready = this.waitFileReady(info.fileId);
      try { await this.d.media.uploadFile(info.url, buf, fileName || 'file', { http: this.d.http }); }
      catch (e) { this.cancelFileWait(info.fileId); throw httpError(`MAX: ${e.message}`, 422); }
      await ready;
      attaches = [{ _type: 'FILE', fileId: info.fileId }];
    }
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: p, kind: 'file', text: caption || fileName });
    await this.invokeSend(chatId, { text: caption || '', cid: this.nextCid(), elements: [], attaches }, deliveryId);
    return deliveryId;
  }

  // Готовность файла — push NOTIF_ATTACH {fileId}. Не пришёл за FILE_READY_TIMEOUT_MS —
  // шлём всё равно: MSG_SEND ответит attachment.not.ready, invokeSend повторит.
  waitFileReady(fileId) {
    const key = String(fileId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fileWaiters.delete(key);
        this.log.warn(`файл ${key}: NOTIF_ATTACH не пришёл за ${(this.d.fileReadyTimeoutMs || FILE_READY_TIMEOUT_MS) / 1000} с — отправляем без подтверждения`);
        resolve();
      }, this.d.fileReadyTimeoutMs || FILE_READY_TIMEOUT_MS);
      // Без unref: ожидание — часть активной отправки, оно обязано пережить тихий
      // цикл событий (иначе промис повис бы навсегда).
      this.fileWaiters.set(key, () => { clearTimeout(timer); this.fileWaiters.delete(key); resolve(); });
    });
  }
  cancelFileWait(fileId) { const w = this.fileWaiters.get(String(fileId)); if (w) w(); }

  async invokeSend(chatId, message, deliveryId) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await this.transport.request(Op.MSG_SEND, { chatId, message, notify: true }); break; }
      catch (e) {
        if (e.code === 'attachment.not.ready' && attempt === 0) { await this.d.sleep(ATTACH_RETRY_MS); continue; }
        try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
        catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
        // Таймаут/обрыв — исход неизвестен (503: transport НЕ уйдёт на другой канал);
        // отказ сервера — ничего не ушло (422/429).
        const unknown = e.code === 'timeout' || e.code === 'transport_closed';
        const rate = /rate|limit|too\.?many|flood/i.test(String(e.code || e.message));
        throw httpError(`MAX: ${e.message}`, unknown ? 503 : (rate ? 429 : 422));
      }
    }
    const sent = (res && res.message) || {};
    const msgId = sent.id !== undefined && sent.id !== null ? String(sent.id) : null;
    if (msgId) {
      this.pruneOwnSends();
      this.ownSends.set(msgId, { deliveryId, ts: this.d.now() });
      try { await this.d.deliveries.setProviderMessageId(deliveryId, msgId); }
      catch (e) { this.log.warn(`delivery g${deliveryId}: provider_message_id не записан (${e.message})`); }
    }
    try { await this.d.deliveries.setStatusIf(deliveryId, this.d.deliveries.STATUS.ACCEPTED[0], this.d.deliveries.STATUS.SENT); }
    catch (e) { this.log.warn(`delivery g${deliveryId}: статус SENT не записан (${e.message})`); }
    // Эхо своей отправки — из ответа сервера, не ждём push (он может и не прийти).
    const echo = { ...sent, id: msgId || `g${deliveryId}`, sender: this.ownerId, time: sent.time || this.d.now(), type: 'USER', text: sent.text !== undefined ? sent.text : message.text, attaches: sent.attaches || message.attaches };
    this.enqueueChat(chatId, () => this.emitMessage(chatId, echo, `g${deliveryId}`)).catch(e => this.log.warn(`эхо g${deliveryId}: ${e.message}`));
  }

  // ── Завершение ───────────────────────────────────────────────
  async logout() {
    this.closed = true;
    try { if (this.transport && this.connected) await this.transport.request(Op.LOGOUT); }
    catch (e) { this.log.warn(`LOGOUT: ${e.message}`); }
    await this.close();
    this.d.session.remove(this.dirs().max);
    this.authState = 'logged_out'; this.qr = null;
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    this.closed = true;
    this.connected = false;
    this.qrTrack = null;
    const t = this.transport;
    this.transport = null;
    if (t) { t.removeAllListeners(); try { t.close(); } catch (_) { /* уже закрыт */ } }
    for (const w of this.fileWaiters.values()) w();
    this.ownSends.clear();
  }
}

module.exports = { MaxClient, MAX_MESSAGE_AGE_S, RECONNECT_MS, MAX_QR_ROUNDS, QR_ABANDONED_ERROR, FILE_READY_TIMEOUT_MS, ATTACH_RETRY_MS, MEDIA_DOWNLOAD_TIMEOUT_MS, LOGIN_CHATS_COUNT };
