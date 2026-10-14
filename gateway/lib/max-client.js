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
// Обрыв и рестарт не теряют входящих: push, пришедший раньше ответа LOGIN, ждёт
// входа (waitConnected); после повторного входа — догон по CHAT_HISTORY (op 49) для
// чатов с активностью после обрыва. Граница — момент обрыва (в этом процессе) или
// aliveAt из сессии (после рестарта); первый вход аккаунта не догоняет — до
// привязки историю вёл Chatpush. Дубли push/догона режет recentIds здесь и UNIQUE
// (salon_id, external_message_id) в бэкенде (сообщение уходит под id MAX).
// Состояние в БД пишется по возможности: сбой БД не рвёт вход (иначе каждый
// реконнект — новый LOGIN, шторм входов); незаписанное дописывается при активности.
// Зависимости инжектятся (deps) — тесты без сети и БД.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./max-mapper');
const { normalizePhone } = require('./mapper');
const { MAX_MEDIA_BYTES, publicFileName } = require('./media');
const { sniffImageMime } = require('./max/media');
const { FILE: SESSION_FILE } = require('./max/session');
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
// Как оба референса (max-account-api chatsCount 40, PyMax WebSyncPayload 40):
// большее значение живьём не проверено, а отказ LOGIN стоил бы входа целиком.
// Снимок чатов нужен только для участников диалога — есть запасной путь XOR.
const LOGIN_CHATS_COUNT = 40;
const CONTACTS_CACHE_MAX = 20000;
// Сколько push-сообщение, пришедшее раньше ответа LOGIN, ждёт входа.
const LOGIN_WAIT_MS = 60 * 1000;
// Догон после обрыва: запас назад от границы (обрыв замечается по PING не сразу —
// до 2 × (интервал + таймаут) — плюс рассинхрон часов), сколько чатов и сообщений на
// чат запрашиваем (упёрлись в лимит — в логе «могли остаться более ранние»).
const CATCHUP_MARGIN_MS = 3 * 60 * 1000;
const CATCHUP_MAX_CHATS = 30;
const CATCHUP_BACKWARD = 30;
// Граница догона после рестарта (aliveAt) пишется в файл сессии не чаще раза в минуту.
const ALIVE_SAVE_MS = 60 * 1000;
const RECENT_IDS_MAX = 5000;
const KNOWN_STATUSES = new Set(['EDITED', 'REMOVED']);

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
    this.reconnectPending = false;
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
    this.inflight = new Map();       // chatId → Set промисов отправок, ещё не узнанных по ответу MSG_SEND
    this.cidPrev = 0;
    this.diag = { xor: 0, hello: 0 };
    this.diagSeen = new Set();       // ключи diagOnce
    this.connWaiters = new Set();    // ждущие входа: push, пришедший раньше ответа LOGIN
    this.recentIds = new Set();      // id уже пересланных сообщений (LRU): push + догон без дублей
    this.gapSince = null;            // начало разрыва, ещё не покрытого догоном (мс), или null
    this.aliveSavedAt = 0;
    this.authDirty = false;          // последнее состояние не записалось в БД — допишет markAlive
  }

  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    const max = path.join(base, 'max');
    return { max, base, session: path.join(max, SESSION_FILE) };
  }
  dirs() { return MaxClient.dirsFor(this.d.config, this.id); }

  async start() {
    fs.mkdirSync(this.dirs().max, { recursive: true });
    await this.setState('starting');
    this.sess = this.d.session.load(this.dirs().max);
    // Рестарт процесса: всё, что пришло после последней отметки «жив», надо догнать.
    const alive = Number(this.sess.aliveAt);
    this.gapSince = alive > 0 ? alive : null;
    try { await this.connect(); }
    catch (e) {
      // registry.startAllActive зовёт start() один раз при старте процесса: сдайся
      // клиент здесь (сеть, MAX недоступен) — аккаунт не поднялся бы до следующего
      // рестарта шлюза. Поэтому — фоновый реконнект, как после обрыва.
      this.lastAuthError = e.message;
      this.log.error(`подключение не удалось: ${e.message} — переподключаемся в фоне`);
      await this.persistAuth(this.authState, { error: e.message });
      this.reconnect().catch(err => this.log.error(`реконнект: ${err.message}`));
    }
    this.log.info('клиент запущен');
  }

  // Слушатели снятого транспорта убираем (его события не должны трогать клиента),
  // но 'error' глушим заглушкой: EventEmitter без слушателя бросил бы исключение
  // на позднем событии сокета и уронил процесс вместе с Telegram/WhatsApp.
  static retire(t) {
    if (!t) return;
    t.removeAllListeners();
    t.on('error', () => {});
    try { t.close(); } catch (_) { /* уже закрыт */ }
  }

  // ── Соединение ───────────────────────────────────────────────
  async connect() {
    if (this.closed) return;
    const t = new this.d.Transport({ url: this.d.config.MAX_WS_URL || DEFAULT_WS_URL, requestTimeoutMs: this.d.config.MAX_REQUEST_TIMEOUT_MS });
    const old = this.transport;
    this.transport = t;
    MaxClient.retire(old);
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
    const wasConnected = this.connected;
    this.connected = false;
    if (this.closed) return;
    // Всё, что придёт до следующего входа, подберёт догон; граница — сейчас (запас
    // назад на позднее обнаружение обрыва — CATCHUP_MARGIN_MS). Уже открытый разрыв
    // (догон ещё не прошёл) не сдвигаем.
    if (wasConnected && this.gapSince === null) this.gapSince = this.d.now();
    this.log.warn(`соединение закрыто (code=${code || '?'}${reason ? ' ' + reason : ''})`);
    this.qr = null; this.qrTrack = null;          // trackId живёт в рамках соединения
    await this.reconnect();
  }

  // Бэкофф 2 с → 60 с; один цикл на клиент (close во время connect не плодит второй).
  // Но и не теряется: обрыв, пришедший, пока connect() ещё дописывал вход (запись
  // ready в БД, первый запрос догона), взводит reconnectPending — цикл делает ещё
  // круг, иначе клиент остался бы без соединения и без реконнекта.
  async reconnect() {
    if (this.reconnecting) { this.reconnectPending = true; return; }
    this.reconnecting = true;
    try {
      while (!this.closed) {
        this.reconnectPending = false;
        const wait = RECONNECT_MS[Math.min(this.reconnects++, RECONNECT_MS.length - 1)];
        await this.d.sleep(wait);
        if (this.closed) return;
        try { await this.connect(); }
        catch (e) { this.log.error(`реконнект не удался: ${e.message}`); continue; }
        if (!this.reconnectPending && this.transport && this.transport.isOpen) return;
        if (!this.closed) this.log.warn('соединение оборвалось, пока завершался вход — переподключаемся ещё раз');
      }
    } finally { this.reconnecting = false; }
  }

  // ── Состояние ────────────────────────────────────────────────
  // Запись в БД — по возможности: исключение из login() ушло бы в реконнект, и сбой БД
  // превращался бы в новый LOGIN каждые 2–60 с (шторм входов, который MAX может счесть
  // подозрительным). Статус для админки бэкенд берёт у живого клиента (status()), БД —
  // для списка аккаунтов; незаписанное состояние допишет markAlive.
  async setState(state, { error = null, phone, displayName } = {}) {
    this.authState = state;
    this.lastAuthError = error;
    await this.persistAuth(state, { error, phone, displayName });
  }

  async persistAuth(state, extra = {}) {
    try {
      await this.d.repo.setAuth(this.id, state, extra);
      this.authDirty = false;
    } catch (e) {
      this.authDirty = true;
      this.log.warn(`состояние ${state} не записано в БД (${e.message}) — клиент работает дальше, допишем позже`);
    }
  }

  // Запись контактов в repo по возможности: синхронное исключение (нет метода — как в
  // фейке спайка) тоже становится отказом промиса, а не падением входа.
  repoWrite(method, args) {
    Promise.resolve().then(() => this.d.repo[method](...args)).catch(e => this.log.warn(`${method}: ${e.message}`));
  }

  diagOnce(key, message) {
    if (this.diagSeen.has(key)) return;
    this.diagSeen.add(key);
    this.log.info(message);
  }

  // stop:true — терминальная ошибка (клиент закрыт, новый «Подключить» пересоздаст);
  // stop:false — ошибка шага, состояние не меняется.
  async fail(message, { stop }) {
    this.log.error(message);
    if (stop) {
      this.closed = true; this.qr = null; this.qrTrack = null;
      this.releaseWaiters(false);
      if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
      await this.setState('error', { error: message });
    } else {
      this.lastAuthError = message;
      await this.persistAuth(this.authState, { error: message });
    }
  }

  saveSession() {
    try { this.d.session.save(this.dirs().max, this.sess); }
    catch (e) { this.log.error(`сессия не сохранена: ${e.message}`); }
  }

  // Отметка «жив» — граница догона после рестарта. Пока разрыв не догнан (gapSince),
  // не двигаем: упади процесс посреди догона, следующий старт начнёт с прежней границы.
  markAlive(force = false) {
    if (!this.sess || !this.connected || this.gapSince !== null) return;
    const now = this.d.now();
    if (!force && now - this.aliveSavedAt < ALIVE_SAVE_MS) return;
    this.aliveSavedAt = now;
    this.sess.aliveAt = now;
    this.saveSession();
    if (this.authDirty) this.persistAuth(this.authState, { error: this.lastAuthError, phone: this.ownPhone, displayName: this.displayName });
  }

  waitConnected(ms) {
    if (this.connected) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer = null;
      const done = (ok) => { clearTimeout(timer); this.connWaiters.delete(done); resolve(ok); };
      timer = setTimeout(() => done(false), ms);
      this.connWaiters.add(done);
    });
  }
  releaseWaiters(ok) { for (const w of [...this.connWaiters]) w(ok); }

  rememberId(id) {
    if (this.recentIds.has(id)) return;
    if (this.recentIds.size >= RECENT_IDS_MAX) this.recentIds.delete(this.recentIds.values().next().value);
    this.recentIds.add(id);
  }

  cacheContact(id, info) {
    const max = this.d.contactsCacheMax || CONTACTS_CACHE_MAX;
    if (!this.contacts.has(id)) while (this.contacts.size >= max) this.contacts.delete(this.contacts.keys().next().value);
    this.contacts.set(id, info);
  }

  // ── QR ───────────────────────────────────────────────────────
  async beginQr() {
    if (this.closed || !this.transport) return;
    let r;
    try { r = await this.transport.request(Op.QR_START); }
    catch (e) {
      if (e.code === 'transport_closed') { this.log.warn(`QR_START: ${e.message}`); return; }   // обрыв → onClose → реконнект → новый раунд
      // Сервер отверг выдачу QR (лимит, устаревший клиент, молчание) — ждать нечего:
      // ошибка в админку, «Запустить заново» начнёт с начала.
      await this.fail(`QR_START: ${e.message}`, { stop: true });
      return;
    }
    // Ответ без trackId/qrLink — протокол поменялся или сервер вернул не то: показать
    // нечего, а клиент без QR так и висел бы в starting. Ошибка в админку.
    if (!r || !r.trackId || !r.qrLink) { await this.fail('QR_START: ответ без trackId/qrLink', { stop: true }); return; }
    this.reconnects = 0;   // соединение здорово: следующий обрыв снова начнёт бэкофф с 2 с
    // Срок — от СВОИХ часов по ttl: expiresAt сервера при рассинхроне часов обрывал бы
    // раунд сразу (или тянул бы опрос мёртвого QR).
    const now = this.d.now();
    const ttl = Number(r.ttl);
    const track = {
      trackId: r.trackId,
      expiresAt: ttl > 0 ? now + ttl : (Number(r.expiresAt) > now ? Number(r.expiresAt) : now + 120000),
      pollMs: Math.max(QR_POLL_MIN_MS, Number(r.pollingInterval) || 5000),
    };
    this.qrTrack = track;
    this.qr = await this.d.qrToDataUrl(r.qrLink).catch(e => { this.log.warn(`qr: ${e.message}`); return null; });
    await this.setState('wait_qr', { error: null });
    this.log.info(`QR-раунд ${this.qrRounds + 1}/${MAX_QR_ROUNDS}: ждём сканирования`);
    this.pollQr(track).catch(e => this.log.error(`опрос QR: ${e.message}`));
  }

  async pollQr(track) {
    while (!this.closed && this.qrTrack === track && this.authState === 'wait_qr') {
      await this.d.sleep(track.pollMs);
      if (this.closed || this.qrTrack !== track || this.authState !== 'wait_qr' || !this.transport) return;
      if (this.d.now() >= track.expiresAt) {
        this.qrTrack = null; this.qr = null;
        // Раунд считается только по истечении неотсканированного QR: обрывы сети
        // (реконнект → новый QR_START) лимит не тратят.
        if (++this.qrRounds >= MAX_QR_ROUNDS) { await this.fail(QR_ABANDONED_ERROR, { stop: true }); return; }
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
      try { await this.login(); }
      catch (e) {
        // Токен уже выдан и сохранён: повторять QR/код бессмысленно — переподключаемся
        // и входим по токену (тот же путь, что после рестарта шлюза).
        this.log.warn(`LOGIN после входа не прошёл (${e.message}) — переподключаемся с сохранённым токеном`);
        this.reconnect().catch(err => this.log.error(`реконнект: ${err.message}`));
      }
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
    const ownerId = contact.id !== undefined && contact.id !== null ? Number(contact.id) : Number(this.sess.ownerId);
    // Без своего id не определить ни собеседника личного диалога, ни chatId отправки —
    // входящие молча терялись бы (onMessage их режет). Это смена протокола: стоп.
    if (!ownerId) { await this.fail('LOGIN: в ответе нет id профиля — протокол MAX изменился?', { stop: true }); return; }
    this.ownerId = ownerId;
    const phone = contact.phone !== undefined && contact.phone !== null ? normalizePhone(String(contact.phone)) : null;
    if (phone) this.ownPhone = phone;
    const name = Array.isArray(contact.names) && contact.names[0] && contact.names[0].name;
    if (name) this.displayName = String(name);
    if (r && r.token && r.token !== this.sess.loginToken) this.sess.loginToken = String(r.token);   // ротация
    Object.assign(this.sess, { ownerId: this.ownerId, phone: this.ownPhone, displayName: this.displayName });
    this.saveSession();
    for (const c of (r && r.chats) || []) if (c && c.id !== undefined && c.id !== null) this.chats.set(Number(c.id), c);
    // Контакты LOGIN — одной пачкой: при первом входе их сотни, запрос на каждый
    // на каждом рестарте шлюза был бы лишней нагрузкой на БД.
    const pairs = [];
    for (const c of (r && r.contacts) || []) {
      const prevPhone = c && c.id !== undefined && c.id !== null ? (this.contacts.get(Number(c.id)) || {}).phone : undefined;
      const info = this.rememberContactInfo(c, { persist: false });
      if (info && info.phone && info.phone !== prevPhone && info.id !== this.ownerId) pairs.push({ phone: info.phone, userId: String(info.id) });
    }
    if (pairs.length) this.repoWrite('rememberContacts', [this.id, pairs]);
    this.connected = true;
    this.qr = null; this.qrTrack = null; this.reconnects = 0; this.qrRounds = 0;
    this.releaseWaiters(true);
    await this.setState('ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
    this.log.info(`готов: ${this.ownPhone || '?'} (${this.displayName || '?'}, id ${this.ownerId})`);
    try {
      const n = await this.d.deliveries.failStale(this.id);
      if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
    } catch (e) { this.log.warn(`failStale: ${e.message}`); }
    // Догон — только после разрыва (обрыв в этом процессе или рестарт с aliveAt), в
    // фоне: start() ждут последовательно для всех аккаунтов шлюза.
    if (this.gapSince !== null) this.catchUp(this.gapSince, t).catch(e => this.log.warn(`догон: ${e.message}`));
    else this.markAlive(true);
  }

  // История чатов, где после границы было движение, → те же onMessage, что у push
  // (фильтры, эхо своих отправок, медиа). Граница сдвигается только по завершении:
  // смена соединения посреди догона оставляет разрыв следующему входу.
  async catchUp(floor, t) {
    const now = this.d.now();
    const cutoff = Math.max(floor - CATCHUP_MARGIN_MS, now - MAX_MESSAGE_AGE_S * 1000);
    const lastTime = (c) => Number((c.lastMessage && c.lastMessage.time) || c.lastEventTime) || 0;
    const active = [...this.chats.values()].filter(c => c && c.id !== undefined && c.id !== null && Number(c.id) !== 0 && !mapper.isChannel(c) && lastTime(c) > cutoff);
    // Последнее сообщение чата уже переслано (обрыв в этом процессе) — запрашивать нечего.
    const todo = active.filter(c => !(c.lastMessage && this.recentIds.has(String(c.lastMessage.id))))
      .sort((a, b) => lastTime(a) - lastTime(b)).slice(-CATCHUP_MAX_CHATS);
    const aborted = () => this.closed || this.transport !== t;
    let fetched = 0, forwarded = 0, failed = 0, capped = 0;
    for (const c of todo) {
      if (aborted()) { this.log.warn('догон прерван сменой соединения — продолжит следующий вход'); return; }
      const chatId = Number(c.id);
      let r;
      try { r = await t.request(Op.CHAT_HISTORY, { chatId, from: this.d.now(), forward: 0, backward: CATCHUP_BACKWARD, getMessages: true }); }
      catch (e) {
        if (e.code === 'transport_closed' || aborted()) { this.log.warn(`догон прерван (${e.message}) — продолжит следующий вход`); return; }
        failed++;
        this.log.warn(`догон: история чата ${chatId} не получена (${e.message})`);
        continue;
      }
      const list = (r && Array.isArray(r.messages) ? r.messages : []).filter(m => m && typeof m === 'object');
      if (list.length >= CATCHUP_BACKWARD && list.every(m => Number(m.time) > cutoff)) capped++;
      const fresh = list.filter(m => Number(m.time) > cutoff).sort((a, b) => Number(a.time) - Number(b.time));
      fetched += fresh.length;
      for (const m of fresh) {
        try { if (await this.enqueueChat(chatId, () => this.onMessage(chatId, m, { catchUp: true }))) forwarded++; }
        catch (e) { this.log.warn(`догон: сообщение ${m.id} чата ${chatId} не переслано (${e.message})`); }
      }
    }
    if (aborted()) return;
    this.gapSince = null;
    this.markAlive(true);
    if (!todo.length) { this.log.info(`догон после обрыва: новых сообщений нет (чатов с движением ${active.length})`); return; }
    this.log.info(`догон после обрыва: чатов с движением ${active.length}, запрошено ${todo.length}, сообщений новее границы ${fetched}, переслано ${forwarded}`
      + (failed ? `, ошибок ${failed}` : '') + (capped ? `, в ${capped} чатах могли остаться более ранние (лимит ${CATCHUP_BACKWARD})` : ''));
  }

  async onLoggedOut(reason) {
    this.closed = true; this.connected = false;
    this.releaseWaiters(false);
    if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
    this.d.session.remove(this.dirs().max);
    this.qr = null; this.qrTrack = null;
    await this.setState('logged_out', { error: reason });
    this.log.warn(reason);
  }

  // Контакт из LOGIN/CONTACT_INFO/NOTIF_PROFILE → кэш и gateway_contacts (номер виден
  // не всегда — приватность; свой номер не пишем).
  rememberContactInfo(c, { persist = true } = {}) {
    if (!c || c.id === undefined || c.id === null) return null;
    const id = Number(c.id);
    const phone = c.phone !== undefined && c.phone !== null && c.phone !== '' ? normalizePhone(String(c.phone)) : null;
    const n0 = Array.isArray(c.names) && c.names[0] ? c.names[0] : null;
    const name = n0 ? (String(n0.name || [n0.firstName, n0.lastName].filter(Boolean).join(' ')).trim() || null) : null;
    const prev = this.contacts.get(id) || {};
    const info = { id, phone: phone || prev.phone || null, name: name || prev.name || null };
    this.cacheContact(id, info);
    if (persist && phone && phone !== prev.phone && id !== this.ownerId) this.repoWrite('rememberContact', [this.id, phone, String(id)]);
    return info;
  }

  // ── Push-события ─────────────────────────────────────────────
  async onPush(frame) {
    if (!frame || this.closed) return;
    this.markAlive();
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
  // → true, если сообщение ушло в бэкенд (счётчик догона). catchUp — сообщение из
  // истории (догон): правка там — ещё не виденное сообщение, а не повтор.
  async onMessage(chatId, message, { catchUp = false } = {}) {
    if (!message || this.closed) return false;
    // Push мог прийти раньше ответа LOGIN (сервер сразу шлёт накопленное) и уже
    // квитирован: выбросить = потерять. Ждём входа ограниченное время.
    if (!this.connected && !(await this.waitConnected(this.d.loginWaitMs || LOGIN_WAIT_MS))) {
      this.log.warn(`сообщение ${message.id} (чат ${chatId}) пришло до входа, а вход не завершился — пропущено`);
      return false;
    }
    if (this.ownerId === null) return false;
    const id = String(message.id);
    if (chatId === 0) return false;                        // «Избранное» (чат с собой)
    if (this.recentIds.has(id)) return false;              // уже переслано (push + догон, повтор push)
    const chat = this.chats.get(chatId) || null;
    if (mapper.isChannel(chat)) return false;              // каналы не форвардим (как рассылки WhatsApp)
    const content = mapper.contentOf(message, { allowEdited: catchUp });
    if (!content) return false;                            // служебное / правка / удаление / пусто
    const status = message.status ? String(message.status).toUpperCase() : null;
    if (status && !KNOWN_STATUSES.has(status)) this.diagOnce(`status:${status}`, `сообщение со status=${status} (незнакомый) пересылаем как обычное; пример: чат ${chatId}, id ${id}`);
    const ts = mapper.tsSeconds(message.time);
    if (ts && Math.floor(this.d.now() / 1000) - ts > MAX_MESSAGE_AGE_S) return false;
    this.pruneOwnSends();
    if (this.ownSends.has(id)) return false;               // наша отправка — эхо уже синтезировано
    const own = Number(message.sender) === this.ownerId;
    if (own && this.inflight.has(chatId)) {
      // Сервер может разослать нашу отправку всем сессиям РАНЬШЕ, чем ответит на
      // MSG_SEND. Без ожидания она ушла бы в бэкенд «набранной на телефоне» (без
      // delivery_id), а журнал авторства ещё мог не лечь → ложная пауза Милы на её же
      // реплике. Ждём отправки в этот чат (не дольше inflightWaitMs()) и сверяемся снова.
      await this.waitInflight(chatId);
      if (this.ownSends.has(id)) return false;
    }
    if (own && !catchUp) this.diagOnce('own-phone', `своё сообщение с телефона (не через шлюз) пришло push-ом: чат ${chatId}, id ${id} — в бэкенд эхом без delivery_id (пауза «ответил оператор»)`);
    await this.emitMessage(chatId, message, null, content);
    return true;
  }

  // Отправка в пути длится до ответа MSG_SEND: таймаут запроса, а у вложения — ещё
  // пауза и повтор (attachment.not.ready). Ждём с запасом, иначе своё push ушло бы
  // в бэкенд «набранным на телефоне» раньше, чем узнали его id.
  inflightWaitMs() {
    if (this.d.inflightWaitMs) return this.d.inflightWaitMs;
    const req = Number(this.d.config.MAX_REQUEST_TIMEOUT_MS) || 20000;
    return 2 * req + ATTACH_RETRY_MS + 5000;
  }

  async waitInflight(chatId) {
    const set = this.inflight.get(chatId);
    if (!set || !set.size) return;
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(r, this.inflightWaitMs()); });
    try { await Promise.race([Promise.allSettled([...set]), timeout]); }
    finally { clearTimeout(timer); }
  }

  // Общий путь входящих и синтезированного эха своей отправки. given — уже разобранный
  // contentOf (у догона правка разобрана с allowEdited — повторный разбор её потерял бы).
  async emitMessage(chatId, message, deliveryId, given = null) {
    this.rememberId(String(message.id));
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
    const content = given || mapper.contentOf(message) || { type: 'unsupported', text: '', media: null };
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
        if (c) {
          info = this.rememberContactInfo(c);
          this.diagOnce('contact-info', `CONTACT_INFO: номер собеседника ${info.phone ? 'виден' : 'скрыт приватностью'} (первый ответ, id ${id})`);
        }
      } catch (e) { this.log.warn(`CONTACT_INFO(${id}): ${e.message}`); }
    }
    if (!info) info = { id, phone: null, name: null };
    if (!info.phone) {
      try {
        const p = await this.d.repo.phoneByUserId(this.id, String(id));
        if (p) info = { ...info, phone: p };
      } catch (e) { this.log.warn(`phoneByUserId(${id}): ${e.message}`); }
    }
    this.cacheContact(id, info);
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
      if (!this.transport) throw new Error('нет соединения с MAX');
      const r = await this.transport.request(Op.FILE_DOWNLOAD, { fileId: media.fileId, chatId, messageId: String(message.id) });
      url = r && r.url;
    }
    if (!url) throw new Error('нет ссылки на файл');
    const { buf, mimeType: headerMime } = await this.d.media.download(url, { http: this.d.http, maxBytes: max, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
    const declared = media.mimeType && media.mimeType !== 'application/octet-stream' ? media.mimeType : null;
    let mimeType;
    // Фото — по сигнатуре: Content-Type CDN живьём не проверен, а octet-stream дал бы .bin.
    if (media.kind === 'PHOTO') mimeType = sniffImageMime(buf) || (/^image\//i.test(headerMime || '') ? headerMime : 'image/jpeg');
    else if (media.kind === 'FILE') mimeType = declared || headerMime || media.mimeType;
    else mimeType = headerMime || declared || media.mimeType;
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
      if (p) {
        // Защита от отправки не тому человеку: max_user_id приходит из chat_id диалога
        // (в т.ч. эпохи Chatpush). Видимый номер контакта, не совпадающий с номером
        // диалога, значит, что id указывает на другого человека — источник правды
        // номер. Номер скрыт приватностью — доверяем id, как это делал Chatpush.
        const c = await this.resolveContact(n);
        if (c && c.phone && c.phone !== p) {
          this.log.warn(`max_user_id ${n}: номер контакта ${c.phone} не совпадает с номером диалога ${p} — отправляем по номеру`);
          return this.resolveByPhone(p);
        }
      }
      return { chatId: mapper.xorId(this.ownerId, n), peerId: n, phone: p };
    }
    return this.resolveByPhone(p);
  }

  async resolveByPhone(p) {
    if (!p) throw httpError('нет получателя: ни max_user_id, ни phone', 422);
    let userId = null;
    for (const c of this.contacts.values()) if (c.phone === p) { userId = c.id; break; }
    if (!userId) {
      try { userId = await this.d.repo.contactUserId(this.id, p); }
      catch (e) { this.log.warn(`contactUserId(${p}): ${e.message}`); }
    }
    if (!userId) {
      // Соединение могло пропасть, пока ждали БД (или клиент закрыт — transport null).
      if (!this.transport || !this.connected) throw httpError('нет соединения с MAX (переподключение)', 422);
      let r;
      try { r = await this.transport.request(Op.CONTACT_INFO_BY_PHONE, { phone: '+' + p }); }
      catch (e) {
        if (e.code === 'timeout' || e.code === 'transport_closed') throw httpError(`нет соединения с MAX (поиск номера ${p}: ${e.message})`, 422);
        throw httpError(`номер ${p} не найден в MAX (${e.code || e.message})`, 422);
      }
      const c = r && r.contact;
      if (c && c.id !== undefined && c.id !== null) {
        userId = Number(c.id);
        this.rememberContactInfo({ ...c, phone: c.phone || p });
      }
    }
    if (!userId) throw httpError(`номер ${p} не найден в MAX`, 422);
    return { chatId: mapper.xorId(this.ownerId, Number(userId)), peerId: Number(userId), phone: p };
  }

  async sendText({ text, phone, maxUserId, replyToMessageId }) {
    this.requireReady();
    const { chatId, phone: p } = await this.resolveChat({ maxUserId, phone });
    // Поиск получателя мог ждать CONTACT_INFO/БД, а соединение — упасть: проверяем ДО
    // создания доставки (ничего не ушло → 422, каскад уходит на другой канал).
    this.requireReady();
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
    this.requireReady();
    const mime = mimeType || mapper.mimeOfName(fileName);
    const photo = type === 'image' && /^image\//.test(mime);
    let attaches;
    if (photo) {
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
    // Пока грузили файл, соединение могло упасть или клиент закрыться: проверяем ДО
    // создания доставки — ничего не ушло, 422 оставляет каскаду другой канал.
    this.requireReady();
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: p, kind: 'file', text: caption || fileName });
    await this.invokeSend(chatId, { text: caption || '', cid: this.nextCid(), elements: [], attaches }, deliveryId);
    // Загрузка медиа живьём проверена не на всех путях — первый успех каждого вида в лог.
    this.diagOnce(`upload:${photo ? 'photo' : 'file'}`, `первая отправка ${photo ? 'фото (PHOTO_UPLOAD)' : 'файла (FILE_UPLOAD)'} прошла: g${deliveryId}`);
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
    let done;
    const settled = new Promise(r => { done = r; });
    if (!this.inflight.has(chatId)) this.inflight.set(chatId, new Set());
    this.inflight.get(chatId).add(settled);
    try { await this.sendAndEcho(chatId, message, deliveryId, done); }
    finally {
      done();
      const set = this.inflight.get(chatId);
      if (set) { set.delete(settled); if (!set.size) this.inflight.delete(chatId); }
    }
  }

  async sendAndEcho(chatId, message, deliveryId, markKnown) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await this.transport.request(Op.MSG_SEND, { chatId, message, notify: true }); break; }
      catch (e) {
        if (e.code === 'attachment.not.ready' && attempt === 0) { await this.d.sleep(ATTACH_RETRY_MS); continue; }
        try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
        catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
        // Таймаут/обрыв после отправки кадра — исход неизвестен (503: transport НЕ уйдёт
        // на другой канал); кадр не уходил (sent:false) или сервер отказал — 422/429.
        const unknown = e.code === 'timeout' || (e.code === 'transport_closed' && e.sent !== false);
        const rate = /rate|limit|too\.?many|flood/i.test(String(e.code || e.message));
        throw httpError(`MAX: ${e.message}`, unknown ? 503 : (rate ? 429 : 422));
      }
    }
    this.markAlive();
    const sent = (res && res.message) || {};
    const msgId = sent.id !== undefined && sent.id !== null ? String(sent.id) : null;
    if (msgId) {
      this.pruneOwnSends();
      this.ownSends.set(msgId, { deliveryId, ts: this.d.now() });
      markKnown();   // push этого id теперь узнаётся по ownSends — ждущий onMessage может сверяться
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
    if (this.transport && this.connected) {
      try { await this.transport.request(Op.LOGOUT); }
      catch (e) { this.log.warn(`LOGOUT: ${e.message}`); }
    } else if (this.sess && this.sess.loginToken) {
      this.log.warn('LOGOUT на сервер MAX не отправлен — нет соединения: сессия удалена только у нас, устройство останется в «Устройствах» MAX на телефоне — удалите его там вручную');
    }
    await this.close();
    this.d.session.remove(this.dirs().max);
    this.authState = 'logged_out'; this.lastAuthError = null; this.qr = null;
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    // Плановая остановка (рестарт, деплой): точная граница догона для следующего старта.
    this.markAlive(true);
    this.closed = true;
    this.connected = false;
    this.qrTrack = null;
    this.releaseWaiters(false);
    const t = this.transport;
    this.transport = null;
    MaxClient.retire(t);
    for (const w of this.fileWaiters.values()) w();
    this.ownSends.clear();
  }
}

module.exports = { MaxClient, MAX_MESSAGE_AGE_S, RECONNECT_MS, MAX_QR_ROUNDS, QR_ABANDONED_ERROR, FILE_READY_TIMEOUT_MS, ATTACH_RETRY_MS, MEDIA_DOWNLOAD_TIMEOUT_MS, LOGIN_CHATS_COUNT, LOGIN_WAIT_MS, CATCHUP_MARGIN_MS, CATCHUP_BACKWARD };
