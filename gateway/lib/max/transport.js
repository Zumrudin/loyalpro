'use strict';
// ============================================================
// MaxTransport — WebSocket веб-протокола MAX: JSON-кадры {ver, cmd, seq, opcode, payload}.
// cmd 0 — наш запрос (и push сервера), 1 — ответ, 3 — ошибка (payload.error/message).
// Ответ сопоставляется запросу по паре opcode:seq; push (cmd 0 от сервера)
// отдаётся событием 'push', квитируется ack() — cmd 1 с тем же opcode/seq.
// Реконнектом транспорт НЕ занимается: после переподключения нужны новый HELLO и
// LOGIN, это знает клиент. PING (op 1) раз в pingIntervalMs с interactive:true —
// как оба референса (max-account-api, PyMax ExtraConfig.interactive=True): с
// «неактивной вкладкой» сервер мог бы перестать слать push. Полуоткрытое
// соединение (TCP жив, сервер молчит) рвём сами: maxPingFailures таймаутов PING
// подряд → terminate → 'close' → клиент переподключается. Иначе шлюз «висел бы
// подключённым» и молча не получал сообщений. Рукопожатие ограничено
// handshakeTimeoutMs — без него зависший TCP-connect вешал бы start() навсегда.
// transport_closed несёт sent: false — кадр не уходил (отправку можно отдать
// другому каналу), sent: true — ушёл, ответа не было (исход неизвестен).
// Класс WebSocket инжектится (тесты без сети).
// ============================================================
const { EventEmitter } = require('events');
const { PROTOCOL_VERSION, CMD, Op, DEFAULT_WS_URL, WEB_ORIGIN, HEADER_USER_AGENT } = require('./protocol');

class MaxServerError extends Error {
  constructor(opcode, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const code = p.error ? String(p.error) : 'unknown';
    super(`MAX op ${opcode}: ${code}${p.message ? ' — ' + p.message : ''}`);
    this.name = 'MaxServerError';
    this.opcode = opcode;
    this.code = code;
    this.serverMessage = p.message ? String(p.message) : null;
    this.payload = p;
  }
}

function closedError(opcode, sent) {
  return Object.assign(new Error('соединение с MAX закрыто'), { code: 'transport_closed', opcode, sent: !!sent });
}

class MaxTransport extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || DEFAULT_WS_URL;
    this.headers = opts.headers || { 'User-Agent': HEADER_USER_AGENT, Origin: WEB_ORIGIN };
    this.requestTimeoutMs = opts.requestTimeoutMs || 20000;
    this.pingIntervalMs = opts.pingIntervalMs === undefined ? 30000 : opts.pingIntervalMs;
    this.pingInteractive = opts.pingInteractive === undefined ? true : !!opts.pingInteractive;
    this.maxPingFailures = opts.maxPingFailures || 2;
    this.pingFailures = 0;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs || 15000;
    this.WebSocket = opts.WebSocket || require('ws');
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();      // 'opcode:seq' → {resolve, reject, timer, opcode}
    this.pingTimer = null;
    this.isOpen = false;
    this.closedByUs = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocket(this.url, { headers: this.headers, handshakeTimeout: this.handshakeTimeoutMs });
      this.ws = ws;
      const onOpen = () => { ws.off('error', onErr); this.isOpen = true; this.startPing(); this.emit('open'); resolve(); };
      const onErr = (e) => { ws.off('open', onOpen); reject(e); };
      ws.once('open', onOpen);
      ws.once('error', onErr);
      ws.on('message', (data) => this.onMessage(data));
      ws.on('close', (code, reason) => this.onClose(code, reason));
      ws.on('error', (e) => { if (this.isOpen) this.raise(e); });
    });
  }

  request(opcode, payload) {
    if (!this.ws || !this.isOpen) return Promise.reject(closedError(opcode, false));
    const seq = this.seq++;
    const frame = { ver: PROTOCOL_VERSION, cmd: CMD.REQUEST, seq, opcode };
    if (payload !== undefined) frame.payload = payload;   // GET_QR идёт без payload — как web.max.ru
    return new Promise((resolve, reject) => {
      const key = `${opcode}:${seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Object.assign(new Error(`MAX op ${opcode}: нет ответа ${this.requestTimeoutMs} мс`), { code: 'timeout', opcode }));
      }, this.requestTimeoutMs);
      this.pending.set(key, { resolve, reject, timer, opcode });
      this.ws.send(JSON.stringify(frame), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(key); reject(err); }
      });
    });
  }

  ack(frame, payload) {
    const f = { cmd: CMD.RESPONSE, seq: frame.seq, opcode: frame.opcode };
    if (payload !== undefined) f.payload = payload;
    this.sendRaw(f);
  }

  sendRaw(frame) {
    if (!this.ws || !this.isOpen) return;
    try { this.ws.send(JSON.stringify({ ver: PROTOCOL_VERSION, ...frame }), () => {}); }
    catch (e) { this.raise(e); }
  }

  onMessage(data) {
    let frame;
    try { frame = JSON.parse(String(data)); }
    catch (e) { this.raise(new Error(`битый кадр MAX: ${e.message}`)); return; }
    if (!frame || typeof frame !== 'object') return;
    this.emit('raw', frame);
    if (frame.cmd === CMD.RESPONSE || frame.cmd === CMD.ERROR) {
      const key = `${frame.opcode}:${frame.seq}`;
      const p = this.pending.get(key);
      if (!p) return;                              // ответ после таймаута
      clearTimeout(p.timer);
      this.pending.delete(key);
      if (frame.cmd === CMD.ERROR) p.reject(new MaxServerError(frame.opcode, frame.payload));
      else p.resolve(frame.payload);
      return;
    }
    this.emit('push', frame);
  }

  rejectPending() {
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(closedError(p.opcode, true));
      this.pending.delete(key);
    }
  }

  onClose(code, reason) {
    const wasOpen = this.isOpen;
    this.isOpen = false;
    this.stopPing();
    this.rejectPending();
    if (this.closedByUs || !wasOpen) return;
    this.emit('close', code, String(reason || ''));
  }

  close() {
    this.closedByUs = true;
    this.stopPing();
    this.isOpen = false;
    this.rejectPending();
    const ws = this.ws;
    this.ws = null;
    try { if (ws) ws.close(); } catch (_) { /* уже закрыт */ }
  }

  startPing() {
    this.stopPing();
    if (!this.pingIntervalMs) return;
    this.pingFailures = 0;
    this.pingTimer = setInterval(() => {
      this.request(Op.PING, { interactive: this.pingInteractive })
        .then(() => { this.pingFailures = 0; })
        .catch((e) => {
          if (e && e.code === 'transport_closed') return;
          // Ответ ошибкой (cmd 3) — сервер жив; считаем только молчание.
          if (!e || e.code !== 'timeout') { this.pingFailures = 0; this.raise(e); return; }
          this.raise(e);
          if (++this.pingFailures >= this.maxPingFailures) {
            this.raise(new Error(`MAX не отвечает на PING ${this.pingFailures} раза подряд — рвём соединение`));
            this.dropDead();
          }
        });
    }, this.pingIntervalMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  // Не close(): тот помечает закрытие «нашим» и гасит событие 'close', а здесь
  // клиенту как раз нужно переподключиться.
  dropDead() {
    const ws = this.ws;
    if (!ws || !this.isOpen) return;
    this.stopPing();
    try { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); }
    catch (e) { this.raise(e); }
  }

  // 'error' без слушателя EventEmitter бросает — на позднем событии снятого
  // транспорта это уронило бы весь процесс шлюза.
  raise(e) { if (this.listenerCount('error')) this.emit('error', e); }

  stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

module.exports = { MaxTransport, MaxServerError };
