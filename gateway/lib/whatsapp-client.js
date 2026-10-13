'use strict';
// ============================================================
// WhatsappClient — один сокет Baileys = один аккаунт (строка messenger_accounts,
// channel='whatsapp'). Интерфейс тот же, что у TelegramClient (server.js и
// registry.js зовут оба одинаково).
// Авторизация: QR (data-URL в status().qr, Baileys обновляет его сам) или код
// привязки по номеру (authStep({phone}) → requestPairingCode). Сессия —
// useMultiFileAuthState в data/acc-<id>/wa, переживает рестарт.
// Соединение: close с loggedOut (401) — разлогин, каталог удаляем, не
// переподключаемся; connectionReplaced (440: сессию держит другой процесс) и
// forbidden (403: номер заблокирован) — состояние error БЕЗ реконнекта
// (переподключение дралось бы со второй сессией / долбило бы бан), каталог
// сессии не трогаем; любая другая причина — реконнект с бэкоффом 2 с → 60 с
// (515 restartRequired после первого входа — штатно). Пока соединения нет,
// отправка — 422 ДО создания доставки (transport уйдёт на другой канал).
// Входящие: messages.upsert И type='notify', И type='append' — по исходнику
// Baileys 6.7.24 (Socket/messages-recv.js) сообщения из офлайн-очереди
// (пришли, пока шлюз лежал/переподключался) идут как 'append'; отсекать их
// значило бы терять сообщения клиентов на каждом рестарте. История в upsert не
// приходит (messaging-history.set, shouldSyncHistoryMessage:()=>false), прочие
// 'append' — заглушки без контента (contentOf → null).
// Свои отправки Baileys дублирует 'append' (emitOwnEvents) на process.nextTick
// ПОСЛЕ relayMessage — порядок относительно возврата sendMessage не
// гарантирован. Поэтому fromMe-апсерты ждут отправок в пути В ТОТ ЖЕ ЧАТ (не
// дольше INFLIGHT_WAIT_MS; загрузка медиа ограничена MEDIA_UPLOAD_TIMEOUT_MS) и
// сверяются с ownSends (key.id → доставка, живёт OWN_SEND_TTL_MS независимо от
// статусов): своё — пропускаем, эхо синтезируем САМИ из результата
// sendMessage. fromMe БЕЗ нашей доставки = администратор набрал на телефоне →
// эхо без delivery_id → бэкенд ставит паузу «ответил оператор».
// Телефон собеседника — wa-mapper.peerPhone (remoteJid → senderPn → кэш LID).
// У СВОИХ сообщений senderPn/senderLid — НАШИ (класс инцидента 2026-08-10:
// свой номер под видом клиентского), поэтому для fromMe в личке они не берутся.
// Кэш LID наполняется ЗАРАНЕЕ, а не только входящими (senderPn): прод 13.10.2026
// — администратор написал с телефона пациенту, который после привязки ещё не
// писал, эхо ушло как '<lid>@lid' без номера, и в «Чате» вырос безымянный
// диалог. Источники номера: контакты app-state (contactAction.lidJid →
// contacts.upsert/update), сырой пакет своего сообщения с другого устройства
// (recipient=<lid> + peer_recipient_pn|recipient_pn — Baileys 6.7.24 эти
// атрибуты в key не кладёт) и chats.phoneNumberShare. Первичную синхронизацию
// app-state Baileys сам НЕ делает, если история отключена (Socket/chats.js:
// doAppStateSync зовётся только при shouldProcessHistoryMsg) — её запускает
// initialAppStateSync, один раз на сессию (creds.accountSyncCounter).
// Статусы: Baileys НЕ присылает messages.update со SERVER_ACK для лички
// (серверный ack эмитится только при ошибке, status=ERROR; ≥2 приходит лишь
// квитанцией устройства получателя — DELIVERY_ACK, которой может не быть
// сутками). Поэтому «Отправлено» ставим по успешному sendMessage (только из
// «Принято» — bad ack мог успеть раньше; сообщение
// ушло в сокет), messages.update ERROR → «Невозможно доставить», sendMessage
// бросил → «Невозможно доставить». Иначе доставка висела бы в «Принято» и
// failStale на следующем старте ложно закрыл бы её как недоставленную.
// Старше MAX_MESSAGE_AGE_S, статусы-истории, рассылки, каналы — не форвардим;
// в группах медиа не качаем — как у Telegram.
// Зависимости инжектятся (deps) — тесты без Baileys.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./wa-mapper');
const { normalizePhone } = require('./mapper');
const { MAX_MEDIA_BYTES, EXT_BY_MIME, publicFileName } = require('./media');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
const EXISTS_TTL_MS = 24 * 60 * 60 * 1000;
const OWN_SEND_TTL_MS = 30 * 60 * 1000;
const SENT_CACHE_MAX = 500;
const RECONNECT_MS = [2000, 5000, 10000, 30000, 60000];
// Мастер подключения брошен: QR (или код привязки) крутится, никто не входит.
// Раунд = закрытие сокета Baileys «QR refs attempts ended» (408 timedOut;
// connectionLost — тоже 408, поэтому различаем по тексту ошибки, socket.js).
// 515 restartRequired после удачного входа, close после isNewLogin и обрывы
// сети раундами НЕ считаются. После MAX_QR_ROUNDS раундов — стоп,
// auth_state='error'; новый старт из админки (registry.start пересоздаёт
// закрытый клиент) начинает заново.
const MAX_QR_ROUNDS = 5;
const QR_EXHAUSTED_RE = /QR refs attempts ended/i;
const QR_ABANDONED_ERROR = 'QR не отсканирован — подключение остановлено, запустите заново';
// Отправка медиа: у Baileys таймаута загрузки по умолчанию нет.
const MEDIA_UPLOAD_TIMEOUT_MS = 60 * 1000;
// Сколько fromMe-апсерт ждёт отправок в пути в тот же чат.
const INFLIGHT_WAIT_MS = 30 * 1000;
// Скачивание входящего медиа целиком: дольше — обрываем HTTP (AbortController),
// сообщение уходит в бэкенд без файла. Иначе зависший поток навсегда
// останавливал бы очередь событий чата.
const MEDIA_DOWNLOAD_DEADLINE_MS = 90 * 1000;
const MEDIA_HTTP_TIMEOUT_MS = 30 * 1000;   // axios timeout: до заголовков ответа
const STATUS_ERROR = 0;              // WAMessageStatus.ERROR
// Номер получателя в сыром пакете своего сообщения (другое устройство аккаунта).
const RECIPIENT_PN_ATTRS = ['peer_recipient_pn', 'recipient_pn'];
// Сколько раз написать в лог атрибуты пакета, где номера получателя НЕТ, — чтобы
// узнать по живому трафику, что WhatsApp туда кладёт, но не засорять лог.
const RAW_DIAG_MAX = 3;
const LID_CACHE_MAX = 50000;
// Первичная синхронизация app-state — не сразу после open: сначала офлайн-очередь.
const APP_STATE_SYNC_DELAY_MS = 60 * 1000;
// Коллекция app-state с контактами (Utils/chat-utils.js: 'contact' → critical_unblock_low).
const CONTACTS_COLLECTION = 'critical_unblock_low';
// DisconnectReason Baileys 6.7.24 (lib/Types/index.js) — константой, чтобы
// тесты не грузили библиотеку.
const DISCONNECT = { loggedOut: 401, forbidden: 403, timedOut: 408, connectionReplaced: 440, restartRequired: 515 };
const TERMINAL_ERRORS = {
  [DISCONNECT.connectionReplaced]: 'сессию WhatsApp открыл другой процесс (connectionReplaced) — переподключение остановлено',
  [DISCONNECT.forbidden]: 'WhatsApp запретил доступ (forbidden) — номер мог быть заблокирован',
};

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT['.jpeg'] = 'image/jpeg';
function mimeOfFile(name) { return MIME_BY_EXT[path.extname(String(name || '')).toLowerCase()] || null; }

let baileysMod = null;
// Baileys 6.7.24 — ESM ("type":"module"); require() работает на Node ≥20.19/22.12
// (require(esm)). Грузим лениво: тесты и Telegram-аккаунты без него.
function baileys() { if (!baileysMod) baileysMod = require('@whiskeysockets/baileys'); return baileysMod; }

async function defaultCreateSocket(authDir, { getMessage } = {}) {
  const b = baileys();
  const pino = require('pino');
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  // fetchLatestBaileysVersion не бросает (на сбое — версия из пакета), но без
  // таймаута axios мог бы висеть; undefined в конфиг не кладём — он перетёр бы дефолт.
  const { version } = await b.fetchLatestBaileysVersion({ timeout: 5000 }).catch(() => ({}));
  const sock = b.makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: b.Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    // Повторная отправка по запросу получателя (не смог расшифровать) — без
    // оригинала Baileys отказывается, и у клиента висит «Ожидание сообщения».
    ...(getMessage ? { getMessage } : {}),
  });
  return { sock, saveCreds };
}

// Поток, а не буфер: размер считаем по факту байтами (fileLength задаёт
// отправитель и может врать), превышение лимита обрывает скачивание.
// signal/timeout уходят в axios: downloadMediaMessage(…, {options}) →
// downloadContentFromMessage → getHttpStream({...options}) (Utils/messages-media.js).
function defaultDownloadMedia(msg, sock, { signal, timeout } = {}) {
  const b = baileys();
  const pino = require('pino');
  const ctx = { logger: pino({ level: 'silent' }) };
  // Протухшая ссылка (404/410) — Baileys просит переотправку медиа у телефона.
  if (sock && typeof sock.updateMediaMessage === 'function') ctx.reuploadRequest = sock.updateMediaMessage;
  return b.downloadMediaMessage(msg, 'stream', { options: { signal, timeout } }, ctx);
}

function defaultDeps() {
  return {
    createSocket: defaultCreateSocket,
    qrToDataUrl: (s) => require('qrcode').toDataURL(s, { margin: 1, width: 320 }),
    downloadMedia: defaultDownloadMedia,
    repo: require('./accounts-repo'),
    deliveries: require('./deliveries'),
    webhook: require('./webhook-sender'),
    config: require('../config'),
    disconnectReason: DISCONNECT,
    maxMediaBytes: MAX_MEDIA_BYTES,
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

function httpError(message, status) { return Object.assign(new Error(message), { status }); }
function normJid(jid) { return String(jid).replace(/:\d+@/, '@'); }
function disconnectCode(u) {
  const e = u && u.lastDisconnect && u.lastDisconnect.error;
  return e && e.output && e.output.statusCode;
}

class WhatsappClient {
  constructor(account, deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`WA#${account.id}`);
    this.authState = 'starting';
    this.lastAuthError = null;
    this.ownPhone = normalizePhone(account.phone);
    this.displayName = null;
    this.qr = null;
    this.pairingCode = null;
    this.sock = null;
    this.saveCreds = null;
    this.handlers = [];
    this.connected = false;
    this.closed = false;
    this.reconnects = 0;
    this.qrRounds = 0;              // раундов QR («QR refs attempts ended») без open
    this.newLogin = false;          // isNewLogin: вход состоялся, ждём 515 и open
    this.ownLid = null;
    this.ownSends = new Map();       // key.id → {deliveryId, ts}
    this.inflight = new Map();       // jid → Set промисов отправок, ещё не зарегистрированных в ownSends
    this.sentCache = new Map();      // key.id → message (для getMessage при повторе)
    this.existsCache = new Map();    // phone → {jid, ts} (onWhatsApp подтвердил, jid канонический)
    this.chatQueues = new Map();
    this.lidPhones = new Map();      // lid → phone: синхронно, раньше записи в БД (пакет обгоняет INSERT)
    this.wsHandlers = [];            // [ws, event, fn] — сырые узлы протокола
    this.rawPnAttr = null;           // каким атрибутом пришёл номер получателя (для лога, один раз)
    this.rawDiagLeft = RAW_DIAG_MAX;
    this.appStateSyncSock = null;    // сокет, для которого синхронизация уже запланирована
  }

  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    return { wa: path.join(base, 'wa'), base };
  }
  dirs() { return WhatsappClient.dirsFor(this.d.config, this.id); }

  async start() {
    fs.mkdirSync(this.dirs().wa, { recursive: true });
    await this.d.repo.setAuth(this.id, 'starting');
    await this.connect();
    this.log.info('клиент запущен');
  }

  async connect() {
    if (this.closed) return;
    const getMessage = async (key) => (key && this.sentCache.get(key.id)) || undefined;
    const { sock, saveCreds } = await this.d.createSocket(this.dirs().wa, { getMessage });
    // close() мог случиться, пока сокет создавался (реконнект) — такой сокет
    // не оживляем, иначе его open записал бы 'ready' закрытому клиенту.
    if (this.closed) { try { sock.end(undefined); } catch (_) { /* уже закрыт */ } return; }
    this.detach();
    this.sock = sock; this.saveCreds = saveCreds;
    const guard = (name, fn) => (...a) => Promise.resolve().then(() => fn.apply(this, a)).catch(e => this.log.error(`${name}: ${e.message}`));
    const on = (ev, fn) => { sock.ev.on(ev, fn); this.handlers.push([sock, ev, fn]); };
    on('creds.update', (update) => {
      Promise.resolve(saveCreds()).catch(e => this.log.error(`saveCreds: ${e.message}`));
      if (update && update.me) this.onOwnIdentityUpdate(update.me).catch(e => this.log.warn(`identity: ${e.message}`));
    });
    on('connection.update', guard('connection.update', this.onConnection));
    on('messages.upsert', guard('messages.upsert', this.onUpsert));
    on('messages.update', guard('messages.update', this.onUpdates));
    on('chats.phoneNumberShare', guard('phoneNumberShare', this.onPhoneShare));
    on('contacts.upsert', guard('contacts.upsert', this.onContacts));
    on('contacts.update', guard('contacts.update', this.onContacts));
    // Сырые узлы: Baileys регистрирует свой CB:message раньше нашего, но разбор
    // у него асинхронный — наш синхронный слушатель успевает положить номер в
    // lidPhones до того, как разобранное сообщение дойдёт до onUpsert.
    if (sock.ws && typeof sock.ws.on === 'function') {
      const raw = (node) => { try { this.onRawMessage(node); } catch (e) { this.log.warn(`сырой пакет: ${e.message}`); } };
      sock.ws.on('CB:message', raw);
      this.wsHandlers.push([sock.ws, 'CB:message', raw]);
    }
  }

  // Слушатели прежнего сокета снимаем: события умершего сокета не должны
  // дублировать обработку нового.
  detach() {
    for (const [s, ev, fn] of this.handlers) {
      try { (s.ev.off || s.ev.removeListener).call(s.ev, ev, fn); } catch (_) { /* нет off */ }
    }
    this.handlers = [];
    for (const [ws, ev, fn] of this.wsHandlers) {
      try { (ws.off || ws.removeListener).call(ws, ev, fn); } catch (_) { /* нет off */ }
    }
    this.wsHandlers = [];
  }

  async onConnection(u) {
    if (u.isNewLogin) { this.newLogin = true; this.log.info('вход по QR/коду выполнен, ждём переподключения'); }
    if (u.qr) {
      this.qr = await this.d.qrToDataUrl(u.qr).catch(e => { this.log.warn(`qr: ${e.message}`); return null; });
      if (this.authState !== 'wait_qr') { this.authState = 'wait_qr'; await this.d.repo.setAuth(this.id, 'wait_qr', { error: null }); }
      return;
    }
    if (u.connection === 'open') {
      if (this.closed) return;
      this.refreshIdentity();
      this.qr = null; this.pairingCode = null; this.reconnects = 0; this.qrRounds = 0; this.newLogin = false;
      this.connected = true;          // входящие офлайн-очереди принимаем сразу, не дожидаясь записи в БД
      await this.d.repo.setAuth(this.id, 'ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
      this.authState = 'ready';   // отправки разрешаем только после записи состояния в БД
      this.lastAuthError = null;
      this.log.info(`готов: ${this.ownPhone || '?'} (${this.displayName || '?'})`);
      this.scheduleAppStateSync();
      try {
        const n = await this.d.deliveries.failStale(this.id);
        if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
      } catch (e) { this.log.warn(`failStale: ${e.message}`); }
      return;
    }
    if (u.connection === 'close') {
      this.connected = false;
      if (this.closed) return;        // close()/logout() — сами разберутся с состоянием
      const code = disconnectCode(u);
      const DR = this.d.disconnectReason;
      this.log.warn(`соединение закрыто (code=${code || '?'})`);
      if (code === DR.loggedOut) {
        this.closed = true;
        this.detach();
        this.authState = 'logged_out'; this.qr = null; this.pairingCode = null;
        fs.rmSync(this.dirs().wa, { recursive: true, force: true });
        await this.d.repo.setAuth(this.id, 'logged_out', { error: 'сессия завершена на телефоне' });
        return;
      }
      const terminal = { [DR.connectionReplaced]: TERMINAL_ERRORS[DISCONNECT.connectionReplaced], [DR.forbidden]: TERMINAL_ERRORS[DISCONNECT.forbidden] }[code];
      if (terminal) {
        this.closed = true;
        this.detach();
        this.authState = 'error'; this.lastAuthError = terminal; this.qr = null; this.pairingCode = null;
        this.log.error(terminal);
        await this.d.repo.setAuth(this.id, 'error', { error: terminal });
        return;
      }
      // Старый QR/код привязки к новому сокету не относятся — не показываем их.
      this.qr = null; this.pairingCode = null;
      const errMsg = String((u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message) || '');
      const qrExhausted = this.authState === 'wait_qr' && !this.newLogin && code === DR.timedOut && QR_EXHAUSTED_RE.test(errMsg);
      if (qrExhausted && ++this.qrRounds >= MAX_QR_ROUNDS) {
        this.closed = true;
        this.detach();
        this.authState = 'error'; this.lastAuthError = QR_ABANDONED_ERROR;
        this.log.warn(`${QR_ABANDONED_ERROR} (${this.qrRounds} раундов QR)`);
        await this.d.repo.setAuth(this.id, 'error', { error: QR_ABANDONED_ERROR });
        return;
      }
      await this.reconnect();
    }
  }

  // Бэкофф 2 с → 60 с; упавшее создание сокета (ФС, сеть) — снова в цикл, а
  // не тихая остановка.
  async reconnect() {
    while (!this.closed) {
      const wait = RECONNECT_MS[Math.min(this.reconnects++, RECONNECT_MS.length - 1)];
      await this.d.sleep(wait);
      if (this.closed) return;
      try { await this.connect(); return; }
      catch (e) { this.log.error(`реконнект не удался: ${e.message}`); }
    }
  }

  async onPhoneShare({ lid, jid } = {}) {
    const phone = mapper.phoneOfJid(jid); const l = mapper.lidOfJid(lid);
    if (phone && l && phone !== this.ownPhone) {
      this.rememberLidLocal(l, phone);
      await this.d.repo.rememberContact(this.id, phone, l);
    }
  }

  // ── Номер по LID заранее ─────────────────────────────────────
  rememberLidLocal(lid, phone) {
    if (this.lidPhones.has(lid)) this.lidPhones.delete(lid);        // свежие — в хвост (вытесняем самые старые)
    this.lidPhones.set(lid, phone);
    if (this.lidPhones.size > LID_CACHE_MAX) this.lidPhones.delete(this.lidPhones.keys().next().value);
  }

  // Память обновляется СИНХРОННО (до первого await) — вызывающий из сырого
  // пакета рассчитывает, что номер виден сразу. В БД — одной пачкой.
  // Другой номер для уже известного LID не перезаписываем: чужой номер увёл бы
  // реплику администратора в диалог другого пациента — это хуже безымянного
  // диалога. Расхождение видно по WARN (только счётчик, без номеров).
  async learnPairs(pairs, source) {
    this.refreshIdentity();
    const fresh = [];
    let conflicts = 0;
    for (const { phone, lid } of pairs || []) {
      if (!phone || !lid || phone === this.ownPhone || lid === this.ownLid) continue;
      const known = this.lidPhones.get(lid);
      if (known === phone) continue;
      if (known) { conflicts++; continue; }
      this.rememberLidLocal(lid, phone);
      fresh.push({ phone, userId: lid });
    }
    if (conflicts) this.log.warn(`номера по LID (${source}): ${conflicts} расхождений с уже известными — оставлены прежние`);
    if (!fresh.length) return 0;
    this.log.info(`номера по LID: +${fresh.length} (${source})`);
    try { await this.d.repo.rememberContacts(this.id, fresh); }
    catch (e) { this.log.warn(`номера по LID (${source}) не сохранены в БД: ${e.message}`); }
    return fresh.length;
  }

  // contacts.upsert/update: у контакта из app-state id — номер, lid — его LID;
  // у контакта из истории бывает наоборот (id — LID, jid — номер).
  async onContacts(list) {
    const pairs = [];
    for (const c of Array.isArray(list) ? list : []) {
      if (!c) continue;
      const phone = mapper.phoneOfJid(c.jid) || mapper.phoneOfJid(c.id);
      const lid = mapper.lidOfJid(c.lid) || mapper.lidOfJid(c.id);
      if (phone && lid) pairs.push({ phone, lid });
    }
    await this.learnPairs(pairs, 'контакты');
  }

  // Своё сообщение, отправленное с ДРУГОГО устройства аккаунта (телефон клиники),
  // приходит пакетом с recipient=<собеседник>. Входящие (recipient нет) и группы
  // сюда не относятся: там номер даёт senderPn/participantPn в key.
  onRawMessage(node) {
    const at = (node && node.attrs) || {};
    const lid = mapper.lidOfJid(at.recipient);
    if (!lid) return;
    const attr = RECIPIENT_PN_ATTRS.find(k => mapper.phoneOfJid(at[k]));
    if (attr) {
      if (this.rawPnAttr !== attr) { this.rawPnAttr = attr; this.log.info(`номер получателя своего сообщения приходит в пакете (${attr})`); }
      this.learnPairs([{ phone: mapper.phoneOfJid(at[attr]), lid }], 'пакет своего сообщения')
        .catch(e => this.log.warn(`номер из пакета: ${e.message}`));
    } else if (this.rawDiagLeft > 0) {
      this.rawDiagLeft--;
      this.log.info(`своё сообщение в LID-чат без номера в пакете; атрибуты: ${Object.keys(at).join(',')}`);
    }
  }

  // Первичная синхронизация app-state (контакты с LID), которую Baileys при
  // выключенной истории не делает. Один раз на сессию: признак — тот же
  // creds.accountSyncCounter, что ставит сам Baileys. creds.update НЕ эмитим —
  // слушатель Baileys на него шлёт presence с пустым именем (Socket/socket.js);
  // пишем поле в те же creds и сохраняем saveCreds.
  scheduleAppStateSync() {
    const sock = this.sock;
    if (!sock || this.appStateSyncSock === sock) return;
    this.appStateSyncSock = sock;
    const delay = this.d.appStateSyncDelayMs != null ? this.d.appStateSyncDelayMs : APP_STATE_SYNC_DELAY_MS;
    Promise.resolve(this.d.sleep(delay))
      .then(() => this.initialAppStateSync(sock))
      .catch(e => this.log.warn(`app-state: ${e.message}`));
  }

  async initialAppStateSync(sock) {
    if (this.closed || !this.connected || this.sock !== sock) return;
    const creds = sock.authState && sock.authState.creds;
    if (!creds || creds.accountSyncCounter) return;                 // уже синхронизирован
    if (!creds.myAppStateKeyId) { this.log.info('app-state: ключей синхронизации от телефона ещё нет — контакты подтянутся позже'); return; }
    if (typeof sock.resyncAppState !== 'function') return;
    const names = this.d.appStatePatchNames || baileys().ALL_WA_PATCH_NAMES;
    this.log.info(`app-state: первичная синхронизация (${names.join(',')}) — контакты с номерами по LID`);
    try {
      await sock.resyncAppState(names, true);
      // Сбой расшифровки коллекции Baileys глотает (resyncAppState не бросает,
      // версия остаётся пустой) — тогда «сделано» не ставим, повторим на
      // следующем подключении.
      const ks = sock.authState && sock.authState.keys;
      const st = ks && typeof ks.get === 'function'
        ? await Promise.resolve(ks.get('app-state-sync-version', [CONTACTS_COLLECTION])).catch(() => null) : null;
      if (!(st && st[CONTACTS_COLLECTION] && st[CONTACTS_COLLECTION].version)) {
        this.log.warn(`app-state: коллекция контактов (${CONTACTS_COLLECTION}) не синхронизировалась — повтор при следующем подключении`);
        return;
      }
      creds.accountSyncCounter = (creds.accountSyncCounter || 0) + 1;
      if (this.saveCreds) await Promise.resolve(this.saveCreds()).catch(e => this.log.warn(`saveCreds: ${e.message}`));
      // Сколько номеров дали контакты — строкой «номера по LID: +N (контакты)»
      // после flush: до него contacts.upsert лежит в буфере Baileys.
      this.log.info('app-state: синхронизировано');
    } catch (e) {
      this.log.warn(`app-state: синхронизация не удалась (${e.message}) — повтор при следующем подключении`);
    } finally {
      // resyncAppState включает буфер событий Baileys и сам его НЕ сбрасывает
      // (Utils/event-buffer.js createBufferedFunction) — без flush контакты и
      // сообщения ждали бы следующего пакета.
      try { if (sock.ev && typeof sock.ev.flush === 'function') sock.ev.flush(); } catch (_) { /* сокет мёртв */ }
    }
  }

  // Шаг из админки: для WhatsApp это только запрос кода привязки по номеру.
  async authStep(step) {
    const s = step || {};
    if (!s.phone) return { authState: this.authState, error: 'не применимо к WhatsApp' };
    if (this.authState !== 'wait_qr' || !this.sock) return { authState: this.authState, error: `код привязки доступен только в состоянии wait_qr (сейчас ${this.authState})` };
    const p = normalizePhone(s.phone) || String(s.phone).replace(/\D/g, '');
    try {
      this.pairingCode = await this.sock.requestPairingCode(p);
      this.lastAuthError = null;
      await this.d.repo.setAuth(this.id, this.authState, { error: null, phone: p });
      return { authState: this.authState, pairingCode: this.pairingCode, error: null };
    } catch (e) {
      this.lastAuthError = e.message;
      await this.d.repo.setAuth(this.id, this.authState, { error: e.message });
      return { authState: this.authState, error: e.message };
    }
  }

  status() {
    return { authState: this.authState, phone: this.ownPhone, displayName: this.displayName, error: this.lastAuthError,
      qr: this.authState === 'wait_qr' ? this.qr : null, pairingCode: this.authState === 'wait_qr' ? this.pairingCode : null };
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

  // ── Входящие/эхо ─────────────────────────────────────────────
  async onUpsert({ messages, type } = {}) {
    // Только closed: сообщение, сброшенное сокетом уже после close, мы
    // квитировали — WhatsApp его не передоставит, терять нельзя.
    if (this.closed) return;
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages || []) {
      const key = (msg && msg.key) || {};
      if (!key.remoteJid || mapper.isSkippedJid(key.remoteJid)) continue;
      if (this.isSelfChat(key.remoteJid)) continue;                 // «Избранное» — не переписка с клиентом
      const ts = mapper.tsOf(msg.messageTimestamp);
      if (ts && this.d.now() / 1000 - ts > MAX_MESSAGE_AGE_S) { this.log.warn(`пропущено ${key.remoteJid}:${key.id} старше ${MAX_MESSAGE_AGE_S / 3600} ч`); continue; }
      if (!mapper.contentOf(msg.message)) continue;                 // служебное/заглушка
      this.enqueueChat(key.remoteJid, async () => {
        if (key.fromMe) {
          // Своя отправка могла ещё не вернуться из sendMessage — ждём, потом сверяем.
          await this.waitInflight(key.remoteJid);
          if (this.ownSends.has(key.id)) return;                    // эхо уже синтезировано
        }
        await this.emitMessage(msg, null);
      }).catch(e => this.log.error(`сообщение ${key.remoteJid}:${key.id}: ${e.message}`));
    }
  }

  // ── Своя личность (номер, LID, имя) ─────────────────────────────
  // Baileys 6.7.24: при привязке (pair-success, Utils/validate-connection.js
  // configureSuccessfulPairing) creds.me = {id, name: bizName} — БЕЗ lid, имя у
  // личного аккаунта пустое (а requestPairingCode ставит заглушку name:'~').
  // lid приходит на входе: CB:success → creds.update {me:{...me, lid}}, затем
  // connection 'open' (Socket/socket.js); имя — позже, creds.update по
  // pushName своего сообщения (Socket/chats.js) или app-state. Сокет сам делает
  // Object.assign(creds, update), а sock.user — живой геттер на creds.me. Поэтому
  // личность читаем ЛЕНИВО из сокета в момент проверки и обновляем на каждом
  // creds.update с me: снимок на 'open' мог быть неполным (живой прогон
  // 12.10.2026: «готов: 7920… (?)», и сообщения чата с самим собой по нашему
  // LID ушли в бэкенд как исходящие).
  liveMe() {
    const s = this.sock;
    if (!s) return null;
    return s.user || (s.authState && s.authState.creds && s.authState.creds.me) || null;
  }

  refreshIdentity(me = this.liveMe()) {
    if (!me) return false;
    const before = `${this.ownPhone}|${this.ownLid}|${this.displayName}`;
    this.ownPhone = mapper.phoneOfJid(me.id) || this.ownPhone;
    this.ownLid = mapper.lidOfJid(me.lid) || this.ownLid;
    // Имя — как есть (у владельца может быть «.»); пусто и заглушка Baileys '~' — неизвестно.
    const name = typeof me.name === 'string' && me.name.trim() && me.name !== '~' ? me.name : null;
    if (name) this.displayName = name;
    return before !== `${this.ownPhone}|${this.ownLid}|${this.displayName}`;
  }

  async onOwnIdentityUpdate(me) {
    const merged = { ...(this.liveMe() || {}), ...me };
    const prevName = this.displayName; const prevPhone = this.ownPhone;
    if (!this.refreshIdentity(merged)) return;
    this.log.info(`своя личность: ${this.ownPhone || '?'} lid=${this.ownLid || '?'} (${this.displayName || '?'})`);
    if (this.authState === 'ready' && (this.displayName !== prevName || this.ownPhone !== prevPhone)) {
      await this.d.repo.setAuth(this.id, 'ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
    }
  }

  isSelfChat(jid) {
    if (mapper.isGroupJid(jid)) return false;
    this.refreshIdentity();
    const p = mapper.phoneOfJid(jid); const l = mapper.lidOfJid(jid);
    return !!((p && p === this.ownPhone) || (l && l === this.ownLid));
  }

  // Ждём отправок в пути в ЭТОТ чат (append своей отправки может обогнать
  // возврат sendMessage), но не дольше INFLIGHT_WAIT_MS: зависшая отправка не
  // должна стопорить очередь чата.
  async waitInflight(jid) {
    const set = this.inflight.get(normJid(jid));
    if (!set || !set.size) return;
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(r, INFLIGHT_WAIT_MS); });
    try { await Promise.race([Promise.allSettled([...set]), timeout]); }
    finally { clearTimeout(timer); }
  }

  async resolvePeerPhone(key) {
    const group = mapper.isGroupJid(key.remoteJid);
    // У своих сообщений в личке sender* — наши; оставляем только remoteJid.
    const k = key.fromMe && !group ? { remoteJid: key.remoteJid, fromMe: true } : key;
    const lid = mapper.lidOfJid(group ? k.participant : k.remoteJid);
    let cached = lid ? (this.lidPhones.get(lid) || null) : null;
    if (lid && !cached) {
      try {
        cached = await this.d.repo.phoneByLid(this.id, lid);
        if (cached) this.rememberLidLocal(lid, cached);
      } catch (e) { this.log.warn(`phoneByLid ${lid}: ${e.message}`); }
    }
    let phone = mapper.peerPhone(k, (l) => (l && l === lid ? cached : null));
    if (phone && phone === this.ownPhone && !group) phone = null;   // свой номер клиентом не бывает
    // Увидели LID и номер вместе — запоминаем для следующих сообщений без senderPn.
    const seenLid = group ? (mapper.lidOfJid(k.participantLid) || lid) : (mapper.lidOfJid(k.senderLid) || lid);
    if (phone && seenLid && !(seenLid === lid && cached) && !key.fromMe) {
      this.rememberLidLocal(seenLid, phone);
      await Promise.resolve(this.d.repo.rememberContact(this.id, phone, seenLid)).catch(e => this.log.warn(`rememberContact: ${e.message}`));
    }
    return phone;
  }

  async emitMessage(msg, deliveryId, knownPhone = null) {
    const key = msg.key || {};
    const group = mapper.isGroupJid(key.remoteJid);
    const phone = knownPhone || await this.resolvePeerPhone(key);
    const content = mapper.contentOf(msg.message);
    let fileUrl = null;
    if (content && content.media && !group) {
      try { fileUrl = await this.downloadToPublic(msg, content.media); }
      catch (e) { this.log.warn(`медиа ${key.remoteJid}:${key.id} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, msg, peerPhone: phone, deliveryId, fileUrl });
    await this.d.webhook.sendSafe(body);
  }

  async downloadToPublic(msg, media) {
    // Заявленный размер — только ранний отказ; по факту считаем байты потока.
    if (media.size && media.size > (this.d.maxMediaBytes || MAX_MEDIA_BYTES)) throw new Error(`файл ${media.size} байт больше лимита`);
    const max = this.d.maxMediaBytes || MAX_MEDIA_BYTES;
    const deadline = this.d.mediaDownloadDeadlineMs || MEDIA_DOWNLOAD_DEADLINE_MS;
    const ac = new AbortController();
    let abortErr = null;
    const abort = (msgText) => { if (!ac.signal.aborted) { abortErr = new Error(msgText); ac.abort(abortErr); } };
    // Отмена рвёт и ожидание ответа, и поток: pipe() Baileys ошибку HTTP-ответа
    // в Transform не пробрасывает — без явного destroy for await висел бы вечно.
    const aborted = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(abortErr), { once: true }));
    aborted.catch(() => {});
    const timer = setTimeout(() => abort(`скачивание медиа дольше ${Math.round(deadline / 1000)} с — прервано`), deadline);
    let src = null;
    let buf;
    try {
      src = await Promise.race([this.d.downloadMedia(msg, this.sock, { signal: ac.signal, timeout: MEDIA_HTTP_TIMEOUT_MS }), aborted]);
      if (Buffer.isBuffer(src)) buf = src;
      else {
        const stream = src;
        ac.signal.addEventListener('abort', () => { if (typeof stream.destroy === 'function') stream.destroy(abortErr); }, { once: true });
        const chunks = []; let total = 0;
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > max) { abort(`файл больше лимита ${max} байт — скачивание прервано`); throw abortErr; }
          chunks.push(chunk);
        }
        buf = Buffer.concat(chunks);
      }
    } catch (e) {
      throw abortErr || e;
    } finally {
      clearTimeout(timer);
      if (!buf) abort('скачивание медиа не завершено');      // закрыть HTTP-ответ при любом сбое
      if (src && !Buffer.isBuffer(src) && typeof src.destroy === 'function' && !src.destroyed) src.destroy();
    }
    if (!buf || !buf.length) throw new Error('пустой файл');
    if (buf.length > max) throw new Error(`файл ${buf.length} байт больше лимита ${max}`);
    const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = publicFileName(media.mimeType, this.d.now());
    fs.writeFileSync(path.join(dir, name), buf);
    return `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`;
  }

  // «Отправлено» уже стоит по sendMessage; здесь — только отказ сервера.
  async onUpdates(updates) {
    for (const u of updates || []) {
      const key = (u && u.key) || {}; const upd = (u && u.update) || {};
      if (!key.fromMe || upd.status !== STATUS_ERROR) continue;
      let deliveryId = this.ownSends.has(key.id) ? this.ownSends.get(key.id).deliveryId : null;
      if (!deliveryId) {
        try { deliveryId = await this.d.deliveries.findByProviderMessageId(this.id, key.id); } catch (e) { this.log.warn(`findByProviderMessageId: ${e.message}`); }
      }
      if (!deliveryId) continue;
      const reason = Array.isArray(upd.messageStubParameters) && upd.messageStubParameters.length ? ` (${upd.messageStubParameters.join(', ')})` : '';
      const error = `WhatsApp отклонил сообщение${reason}`;
      this.log.warn(`delivery g${deliveryId}: ${error}`);
      await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error });
    }
  }

  // ── Отправка ─────────────────────────────────────────────────
  requireReady() {
    if (this.authState !== 'ready') throw httpError(`аккаунт не авторизован (${this.authState})`, 422);
    if (!this.connected || !this.sock) throw httpError('нет соединения с WhatsApp (переподключение)', 422);
  }

  // onWhatsApp Baileys 6.7.24 ОТФИЛЬТРОВЫВАЕТ номера без WhatsApp
  // (list.filter(a => !!a.contact)): пустой массив = «не в WhatsApp»,
  // undefined/исключение = проверка не состоялась → шлём (fail-open).
  async resolveJid(phone) {
    const p = normalizePhone(phone);
    if (!p) throw httpError('нет получателя: phone обязателен', 422);
    const hit = this.existsCache.get(p);
    if (hit && this.d.now() - hit.ts <= EXISTS_TTL_MS) return { jid: hit.jid, phone: p };
    let res;
    try { res = await this.sock.onWhatsApp(p); }
    catch (e) { this.log.warn(`onWhatsApp(${p}): ${e.message} — шлём без проверки`); res = undefined; }
    if (Array.isArray(res)) {
      const r = res.find(x => x && x.exists);
      if (!r) throw httpError(`номер ${p} не в WhatsApp`, 422);
      // Канонический jid от WhatsApp (номер мог быть записан не так, как его знает WA).
      const jid = typeof r.jid === 'string' && r.jid.includes('@') ? normJid(r.jid) : `${p}@s.whatsapp.net`;
      this.existsCache.set(p, { jid, ts: this.d.now() });
      return { jid, phone: p };
    }
    return { jid: `${p}@s.whatsapp.net`, phone: p };
  }

  async sendText({ text, phone }) {
    this.requireReady();
    const { jid, phone: p } = await this.resolveJid(phone);
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId: null, phone: p, kind: 'text', text });
    await this.invokeSend(jid, { text }, deliveryId, p);
    return deliveryId;
  }

  // Baileys читает буфер до ответа sendMessage — временный файл удаляем сразу
  // после чтения. Читаем ДО создания доставки: нечитаемый файл не оставляет
  // строку «Принято», которую потом закрыл бы failStale.
  async sendFile({ filePath, fileName, caption, type, phone, mimeType }) {
    this.requireReady();
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { throw httpError(`файл не прочитан: ${e.message}`, 422); }
    finally {
      try { fs.rmSync(filePath, { force: true }); } catch (_) { /* подберёт страховочный таймер server.js */ }
      fs.rmdir(path.dirname(filePath), () => {});   // каталог tmp/<hex>/ от multer; непустой — останется
    }
    const { jid, phone: p } = await this.resolveJid(phone);
    const mime = mimeType || mimeOfFile(fileName);
    const content = type === 'image'
      ? { image: buf, caption: caption || '', ...(mime && /^image\//.test(mime) ? { mimetype: mime } : {}) }
      : { document: buf, mimetype: mime || 'application/octet-stream', fileName: fileName || 'file', caption: caption || '' };
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId: null, phone: p, kind: 'file', text: caption || fileName });
    await this.invokeSend(jid, content, deliveryId, p);
    return deliveryId;
  }

  async invokeSend(jid, content, deliveryId, phone) {
    let done;
    const settled = new Promise(r => { done = r; });
    const key = normJid(jid);
    if (!this.inflight.has(key)) this.inflight.set(key, new Set());
    this.inflight.get(key).add(settled);
    try {
      let sent;
      try { sent = await this.sock.sendMessage(jid, content, { mediaUploadTimeoutMs: MEDIA_UPLOAD_TIMEOUT_MS }); }
      catch (e) {
        try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
        catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
        throw httpError(`WhatsApp: ${e.message}`, /rate|overlimit|too many/i.test(e.message) ? 429 : 422);
      }
      const msgId = sent && sent.key && sent.key.id;
      if (msgId) {
        this.pruneOwnSends();
        this.ownSends.set(msgId, { deliveryId, ts: this.d.now() });
        if (sent.message) {
          this.sentCache.set(msgId, sent.message);
          if (this.sentCache.size > SENT_CACHE_MAX) this.sentCache.delete(this.sentCache.keys().next().value);
        }
      }
      done();   // append-апсерт этого id теперь узнаётся по ownSends
      if (msgId) {
        try { await this.d.deliveries.setProviderMessageId(deliveryId, msgId); } catch (e) { this.log.warn(`delivery g${deliveryId}: provider_message_id не записан (${e.message})`); }
      }
      // Только из «Принято»: отказ сервера (bad ack) мог прийти раньше этой строки.
      try { await this.d.deliveries.setStatusIf(deliveryId, this.d.deliveries.STATUS.ACCEPTED[0], this.d.deliveries.STATUS.SENT); }
      catch (e) { this.log.warn(`delivery g${deliveryId}: статус SENT не записан (${e.message})`); }
      // Эхо своей отправки — сами, не ждём append-апсерта библиотеки.
      const echo = {
        key: { remoteJid: jid, fromMe: true, id: msgId || `g${deliveryId}` },
        message: sent && sent.message ? sent.message : (content.text !== undefined ? { conversation: content.text } : {}),
        messageTimestamp: mapper.tsOf(sent && sent.messageTimestamp) || Math.floor(this.d.now() / 1000),
      };
      this.enqueueChat(jid, () => this.emitMessage(echo, `g${deliveryId}`, mapper.phoneOfJid(jid) || phone)).catch(e => this.log.warn(`эхо g${deliveryId}: ${e.message}`));
    } finally {
      const set = this.inflight.get(key);
      if (set) { set.delete(settled); if (!set.size) this.inflight.delete(key); }
      done();
    }
  }

  async logout() {
    this.closed = true;               // close 401 от sock.logout() — не наш разлогин «с телефона»
    try { if (this.sock) await this.sock.logout(); } catch (_) { /* уже разлогинен */ }
    await this.close();
    fs.rmSync(this.dirs().wa, { recursive: true, force: true });
    this.authState = 'logged_out'; this.qr = null; this.pairingCode = null;
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    this.closed = true;
    this.connected = false;
    try { this.sock && this.sock.end && this.sock.end(undefined); } catch (_) { /* уже закрыт */ }
    this.detach();
    this.ownSends.clear();
    this.sentCache.clear();
  }
}

module.exports = { WhatsappClient, MAX_MESSAGE_AGE_S, RECONNECT_MS, DISCONNECT, MAX_QR_ROUNDS, MEDIA_UPLOAD_TIMEOUT_MS, MEDIA_DOWNLOAD_DEADLINE_MS };
