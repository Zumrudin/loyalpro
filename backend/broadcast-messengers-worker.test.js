'use strict';
// Воркер разовых рассылок через мессенджеры (спека 2026-11-01 §5). БД — фейк в памяти, маршрутизация
// по тегу /* bm:… */ в начале каждого SQL воркера; sender и transport — моки.
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./services/broadcast-messengers/sender', () => ({ sendToRecipient: jest.fn() }));
jest.mock('./services/messaging/transport', () => ({ getDeliveryStatus: jest.fn(), configured: jest.fn(() => true) }));

const { db } = require('./db');
const sender = require('./services/broadcast-messengers/sender');
const transport = require('./services/messaging/transport');
const w = require('./services/broadcast-messengers/worker');

const at = (h, m = 0, s = 0) => new Date(2026, 10, 2, h, m, s).getTime(); // мск (TZ jest)
const NOW = at(12, 0);

// ── фейк БД ────────────────────────────────────────────────────
let S; // { broadcasts: Map, recipients: [], nowMs, calls: [] }

function tagOf(sql) {
  const m = /\/\*\s*bm:([\w-]+)\s*\*\//.exec(sql);
  if (!m) throw new Error(`SQL без тега: ${sql.slice(0, 80)}`);
  return m[1];
}
const rec = (id) => S.recipients.find((r) => r.id === Number(id));
const bc = (id) => S.broadcasts.get(Number(id));
const appendLog = (r, json) => { r.cascade_log = r.cascade_log.concat(JSON.parse(json)); };

function run(sql, p = []) {
  const tag = tagOf(sql);
  S.calls.push({ tag, p });
  const nowDb = new Date(S.nowMs);
  switch (tag) {
    case 'cancel-pending': {
      const n = S.recipients.filter((r) => r.broadcast_id === p[0] && r.status === 'pending');
      n.forEach((r) => { r.status = 'cancelled'; });
      return [];
    }
    case 'cancel-broadcast': { const b = bc(p[0]); b.status = 'cancelled'; b.finished_at = nowDb; return []; }
    case 'start-broadcast': { const b = bc(p[0]); if (b.status === 'pending') { b.status = 'in_progress'; b.started_at = b.started_at || nowDb; } return []; }
    case 'stats': {
      const by = {};
      const bump = (ch, ms) => {
        const o = by[ch] || (by[ch] = { channel: ch, last_ms: null, n: 0 });
        o.n++;
        if (ms != null && (o.last_ms == null || ms > Number(o.last_ms))) o.last_ms = String(ms); // numeric приходит строкой
      };
      for (const r of S.recipients) {
        if (r.broadcast_id !== p[0]) continue;
        if (['sent', 'sending'].includes(r.status)) bump(r.channel, r.sent_at.getTime());
        // попытка, отвергнутая «нет в мессенджере» после приёма, остаётся за мессенджером-отправителем
        for (const e of r.cascade_log) if (e.why === 'not_registered') bump(e.from, e.sent_at ? Date.parse(e.sent_at) : null);
      }
      return Object.values(by);
    }
    case 'limit-pending':
      return S.recipients.filter((r) => r.broadcast_id === p[0] && r.status === 'pending' && p[1].includes(r.channel))
        .map((r) => ({ id: r.id, cascade: r.cascade, step: r.step, channel: r.channel }));
    case 'advance': {
      const r = rec(p[0]); if (r.status !== 'pending') return [];
      r.step = p[1]; r.channel = p[2]; appendLog(r, p[3]); return [{ id: r.id }];
    }
    case 'skip': {
      const r = rec(p[0]); if (r.status !== 'pending') return [];
      r.status = 'skipped'; r.reason = p[1]; appendLog(r, p[2]); return [{ id: r.id }];
    }
    case 'inc-skipped': bc(p[0]).skipped += 1; return [];
    case 'inc-sent': bc(p[0]).sent += 1; return [];
    case 'inc-failed': bc(p[0]).failed += 1; return [];
    case 'heads': {
      const out = [];
      for (const ch of [...p[1]].sort()) {
        const h = S.recipients.filter((r) => r.broadcast_id === p[0] && r.status === 'pending' && r.channel === ch)
          .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)[0];
        if (h) out.push({ id: h.id, phone: h.phone, channel: h.channel, cascade: h.cascade, step: h.step, personalized_text: h.personalized_text });
      }
      return out;
    }
    case 'claim': {
      const r = rec(p[0]); if (r.status !== 'pending') return [];
      r.status = 'sending'; r.sent_at = nowDb; return [{ id: r.id }];
    }
    case 'mark-sent': {
      const r = rec(p[0]); if (r.status !== 'sending') return [];
      Object.assign(r, { status: 'sent', channel: p[1], delivery_id: p[2], account_id: p[3], delivery_status: 'accepted' });
      appendLog(r, p[4]); return [{ id: r.id }];
    }
    case 'mark-retry': {
      const r = rec(p[0]); if (r.status !== 'sending') return [];
      Object.assign(r, { status: 'pending', sent_at: null, step: p[1], channel: p[2], error: p[3] });
      appendLog(r, p[4]); return [{ id: r.id }];
    }
    case 'mark-failed': {
      const r = rec(p[0]); if (r.status !== 'sending') return [];
      Object.assign(r, { status: 'failed', reason: p[1], error: p[2] });
      appendLog(r, p[3]); return [{ id: r.id }];
    }
    case 'mark-unreachable': {
      const r = rec(p[0]); if (r.status !== 'sending') return [];
      Object.assign(r, { status: 'pending', sent_at: null, error: p[1] }); appendLog(r, p[2]); return [{ id: r.id }];
    }
    case 'pause-broadcast': { const b = bc(p[0]); b.paused = true; b.pause_reason = p[1]; return []; }
    case 'has-open':
      return S.recipients.some((r) => r.broadcast_id === p[0] && (['pending', 'sending'].includes(r.status)
        || (r.status === 'sent' && r.delivery_status === 'accepted' && r.delivery_id != null && r.step < r.cascade.length - 1)))
        ? [{ one: 1 }] : [];
    case 'complete': { const b = bc(p[0]); if (b.status === 'in_progress') { b.status = 'completed'; b.finished_at = nowDb; } return []; }
    case 'active': return [...S.broadcasts.values()].filter((b) => ['pending', 'in_progress'].includes(b.status));
    case 'deliveries': return S.deliveries || [];
    case 'delivery-status': {
      const r = rec(p[0]); if (!r || r.delivery_status !== 'accepted') return [];
      if (p[1] != null) r.delivery_status = p[1];
      if (p[2] != null) r.error = p[2];
      r.checked_at = nowDb; return [];
    }
    case 'not-registered-next': {
      const r = rec(p[0]); if (!r || r.status !== 'sent' || r.delivery_status !== 'accepted') return [];
      Object.assign(r, { status: 'pending', step: p[1], channel: p[2], sent_at: null, delivery_id: null, account_id: null,
        delivery_status: null, checked_at: null, error: p[3] });
      appendLog(r, p[4]); return [{ id: r.id }];
    }
    case 'dec-sent': { const b = bc(p[0]); b.sent = Math.max(b.sent - 1, 0); return []; }
    case 'close-stale': return S.closeStaleRows || [];
    default: throw new Error(`неизвестный тег ${tag}`);
  }
}

function addBroadcast(over = {}) {
  const b = {
    id: 1, salon_id: 7, status: 'in_progress', transport: 'messengers', paused: false, pause_reason: null,
    cancel_requested: false, on_limit: 'next_channel', image_url: null, sent: 0, failed: 0, skipped: 0, total: 0,
    channel_settings: {
      tdlib: { enabled: true, delay_sec: 60, limit: null },
      whatsapp: { enabled: true, delay_sec: 180, limit: null },
      max: { enabled: true, delay_sec: 60, limit: null },
    },
    ...over,
  };
  S.broadcasts.set(b.id, b);
  return b;
}
let nextId = 1;
function addRec(over = {}) {
  const cascade = over.cascade || ['whatsapp', 'tdlib', 'max'];
  const step = over.step || 0;
  const r = {
    id: nextId++, broadcast_id: 1, phone: `7900000000${nextId}`, cascade, step, channel: cascade[step],
    status: 'pending', sent_at: null, sort_order: nextId, personalized_text: 'Привет', cascade_log: [],
    reason: null, error: null, delivery_id: null, account_id: null, delivery_status: null, ...over,
  };
  if (over.cascade && over.channel === undefined) r.channel = cascade[step];
  S.recipients.push(r);
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  S = { broadcasts: new Map(), recipients: [], nowMs: NOW, calls: [] };
  nextId = 1;
  db.any.mockImplementation(async (sql, p) => run(sql, p));
  db.query.mockImplementation(async (sql, p) => { const rows = run(sql, p); return { rows, rowCount: rows.length }; });
  db.oneOrNone.mockImplementation(async (sql, p) => run(sql, p)[0] || null);
  sender.sendToRecipient.mockResolvedValue({ ok: true, delivery_id: '555', account_id: '9' });
});

const tags = () => S.calls.map((c) => c.tag);

describe('processBroadcast — окно и пауза', () => {
  test('вне окна 09–21 — ничего не шлём', async () => {
    const b = addBroadcast();
    addRec();
    await w.processBroadcast(b, at(21, 0));
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
    expect(tags()).not.toContain('claim');
  });

  test('рассылка на паузе — ничего не шлём', async () => {
    const b = addBroadcast({ paused: true, pause_reason: 'manual' });
    addRec();
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
  });

  test('pending → in_progress со started_at', async () => {
    const b = addBroadcast({ status: 'pending' });
    addRec();
    addRec(); // второй whatsapp ждёт паузу — рассылка не завершится в этом тике
    await w.processBroadcast(b, NOW);
    expect(bc(1).status).toBe('in_progress');
    expect(bc(1).started_at).toBeTruthy();
  });

  test('мессенджер на паузе (last_ms строкой) — не шлём в него', async () => {
    const b = addBroadcast();
    addRec({ status: 'sent', sent_at: new Date(NOW - 60 * 1000) }); // whatsapp, пауза 180 с
    const r2 = addRec();
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
    expect(r2.status).toBe('pending');
  });

  test('channel_settings строкой JSON тоже разбирается', async () => {
    const b = addBroadcast();
    b.channel_settings = JSON.stringify(b.channel_settings);
    addRec();
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1);
  });
});

describe('processBroadcast — отправка', () => {
  test('по одной отправке на свободный мессенджер, первому в очереди', async () => {
    const b = addBroadcast({ image_url: '/uploads/broadcast_7_1.jpg' });
    const w1 = addRec({ sort_order: 1 });
    const w2 = addRec({ sort_order: 2 });
    const t1 = addRec({ cascade: ['tdlib'], sort_order: 3 });
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(2);
    expect(sender.sendToRecipient).toHaveBeenCalledWith({ salonId: 7, phone: w1.phone, channel: 'whatsapp', text: 'Привет', imageUrl: '/uploads/broadcast_7_1.jpg' });
    expect(w1.status).toBe('sent');
    expect(w1.delivery_id).toBe('555');
    expect(w1.account_id).toBe('9');
    expect(w1.delivery_status).toBe('accepted');
    expect(w1.cascade_log).toEqual([expect.objectContaining({ channel: 'whatsapp', ok: true })]);
    expect(t1.status).toBe('sent');
    expect(w2.status).toBe('pending');
    expect(bc(1).sent).toBe(2);
  });

  test('rejected → следующий шаг каскада, в этом тике повторно не шлём', async () => {
    const b = addBroadcast();
    const r = addRec({ cascade: ['whatsapp', 'tdlib'] });
    sender.sendToRecipient.mockResolvedValueOnce({ ok: false, kind: 'rejected', error: '422 нет в WhatsApp' });
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('pending');
    expect(r.sent_at).toBeNull();
    expect(r.step).toBe(1);
    expect(r.channel).toBe('tdlib');
    expect(r.cascade_log).toEqual([expect.objectContaining({ from: 'whatsapp', to: 'tdlib', why: 'rejected', error: '422 нет в WhatsApp' })]);
    expect(bc(1).failed).toBe(0);
    expect(bc(1).status).toBe('in_progress');
  });

  test('rejected на последнем шаге → failed all_rejected', async () => {
    const b = addBroadcast();
    const r = addRec({ cascade: ['whatsapp'] });
    sender.sendToRecipient.mockResolvedValueOnce({ ok: false, kind: 'rejected', error: 'нет адресата' });
    await w.processBroadcast(b, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('all_rejected');
    expect(r.error).toBe('нет адресата');
    expect(bc(1).failed).toBe(1);
    expect(bc(1).status).toBe('completed');
  });

  test('unreachable → получатель pending на том же шаге, рассылка на паузе, цикл прерван', async () => {
    const b = addBroadcast();
    const r1 = addRec({ cascade: ['tdlib', 'whatsapp'], sort_order: 1 });
    const r2 = addRec({ cascade: ['whatsapp'], sort_order: 2 });
    sender.sendToRecipient.mockResolvedValueOnce({ ok: false, kind: 'unreachable', error: 'connect ECONNREFUSED' });
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1); // whatsapp-голова в этом тике уже не шлётся
    const first = sender.sendToRecipient.mock.calls[0][0].phone === r1.phone ? r1 : r2;
    expect(first.status).toBe('pending');
    expect(first.sent_at).toBeNull();
    expect(first.step).toBe(0);
    expect(bc(1).paused).toBe(true);
    expect(bc(1).pause_reason).toBe('gateway_unreachable');
    expect(r1.status === 'pending' && r2.status === 'pending').toBe(true);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  test('ambiguous → failed ambiguous_failure, без отката на другой шаг', async () => {
    const b = addBroadcast();
    const r = addRec({ cascade: ['whatsapp', 'tdlib'] });
    sender.sendToRecipient.mockResolvedValueOnce({ ok: false, kind: 'ambiguous', error: 'timeout' });
    await w.processBroadcast(b, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('ambiguous_failure');
    expect(r.step).toBe(0);
    expect(bc(1).failed).toBe(1);
  });

  test('захват не лёг (строку забрали) — не шлём', async () => {
    const b = addBroadcast();
    addRec();
    const orig = db.any.getMockImplementation();
    db.any.mockImplementation(async (sql, p) => (tagOf(sql) === 'claim' ? [] : orig(sql, p)));
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
  });

  test('сбой UPDATE после отправки не бросает и не возвращает строку в pending', async () => {
    const b = addBroadcast();
    const r = addRec();
    const orig = db.any.getMockImplementation();
    db.any.mockImplementation(async (sql, p) => { if (tagOf(sql) === 'mark-sent') throw new Error('db down'); return orig(sql, p); });
    await expect(w.processBroadcast(b, NOW)).resolves.toBeUndefined();
    expect(r.status).toBe('sending');
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('processBroadcast — лимит', () => {
  test('on_limit=next_channel: исчерпанный whatsapp → получатель на следующий шаг', async () => {
    const b = addBroadcast();
    b.channel_settings.whatsapp.limit = 1;
    addRec({ status: 'sent', sent_at: new Date(NOW - 3600 * 1000) });
    const r = addRec({ cascade: ['whatsapp', 'tdlib'] });
    await w.processBroadcast(b, NOW);
    expect(r.cascade_log[0]).toEqual(expect.objectContaining({ from: 'whatsapp', to: 'tdlib', why: 'limit' }));
    // tdlib свободен — в этом же тике получатель уходит туда
    expect(sender.sendToRecipient).toHaveBeenCalledWith(expect.objectContaining({ phone: r.phone, channel: 'tdlib' }));
    expect(r.status).toBe('sent');
  });

  test('on_limit=next_channel, следующего шага нет → skipped limit', async () => {
    const b = addBroadcast();
    b.channel_settings.whatsapp.limit = 1;
    addRec({ status: 'sent', sent_at: new Date(NOW - 3600 * 1000) });
    const r = addRec({ cascade: ['whatsapp'] });
    await w.processBroadcast(b, NOW);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('limit');
    expect(bc(1).skipped).toBe(1);
    expect(bc(1).status).toBe('completed');
  });

  test('on_limit=skip → skipped limit, хотя шаг есть', async () => {
    const b = addBroadcast({ on_limit: 'skip' });
    b.channel_settings.whatsapp.limit = 1;
    addRec({ status: 'sent', sent_at: new Date(NOW - 3600 * 1000) });
    const r = addRec({ cascade: ['whatsapp', 'tdlib'] });
    await w.processBroadcast(b, NOW);
    expect(r.status).toBe('skipped');
    expect(bc(1).skipped).toBe(1);
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
  });

  test('лимит не перескакивает на выключенный мессенджер', async () => {
    const b = addBroadcast();
    b.channel_settings.whatsapp.limit = 1;
    b.channel_settings.tdlib.enabled = false;
    addRec({ status: 'sent', sent_at: new Date(NOW - 3600 * 1000) });
    const r = addRec({ cascade: ['whatsapp', 'tdlib', 'max'] });
    await w.processBroadcast(b, NOW);
    expect(r.cascade_log[0]).toEqual(expect.objectContaining({ to: 'max' }));
  });
});

describe('processBroadcast — отмена и завершение', () => {
  test('cancel_requested гасит pending и закрывает рассылку', async () => {
    const b = addBroadcast({ cancel_requested: true });
    const r1 = addRec();
    const r2 = addRec({ status: 'sent', sent_at: new Date(NOW - 1000) });
    await w.processBroadcast(b, NOW);
    expect(r1.status).toBe('cancelled');
    expect(r2.status).toBe('sent');
    expect(bc(1).status).toBe('cancelled');
    expect(bc(1).finished_at).toBeTruthy();
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
  });

  test('отмена действует и вне окна', async () => {
    const b = addBroadcast({ cancel_requested: true });
    const r1 = addRec();
    await w.processBroadcast(b, at(23, 0));
    expect(r1.status).toBe('cancelled');
    expect(bc(1).status).toBe('cancelled');
  });

  test('нет pending/sending → completed', async () => {
    const b = addBroadcast();
    addRec({ status: 'sent', sent_at: new Date(NOW - 1000) });
    await w.processBroadcast(b, NOW);
    expect(bc(1).status).toBe('completed');
  });

  test('висит sending — не завершаем', async () => {
    const b = addBroadcast();
    addRec({ status: 'sending', sent_at: new Date(NOW - 1000) });
    await w.processBroadcast(b, NOW);
    expect(bc(1).status).toBe('in_progress');
  });
});

// Строка CHECK_SQL: поля получателя + рассылки (каскад продолжается только у живой рассылки).
function drow(r, over = {}) {
  const b = bc(r.broadcast_id);
  return {
    id: r.id, broadcast_id: r.broadcast_id, channel: r.channel, delivery_id: r.delivery_id, account_id: r.account_id,
    sent_at: r.sent_at, cascade: r.cascade, step: r.step, salon_id: b.salon_id, broadcast_status: b.status,
    cancel_requested: b.cancel_requested, channel_settings: b.channel_settings, ...over,
  };
}

describe('checkDeliveries — шлюз (id g<n>)', () => {
  let r1;
  beforeEach(() => {
    addBroadcast();
    r1 = addRec({ status: 'sent', sent_at: new Date(NOW - 150 * 1000), delivery_status: 'accepted', delivery_id: 'g555', account_id: 9, cascade: ['tdlib'] });
    S.deliveries = [drow(r1)];
  });

  test('status 5 с «исход неизвестен» → unknown, каскад не продолжается', async () => {
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5, description: 'Невозможно доставить' }, error: 'шлюз перезапущен, исход неизвестен' });
    await w.checkDeliveries(NOW);
    expect(transport.getDeliveryStatus).toHaveBeenCalledWith(7, 'tdlib', 'g555', { accountId: 9 });
    expect(rec(1).delivery_status).toBe('unknown');
    expect(rec(1).status).toBe('sent');
    expect(sender.sendToRecipient).not.toHaveBeenCalled();
  });

  test('status 5 свежий → undeliverable', async () => {
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5, description: 'Невозможно доставить' } });
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('undeliverable');
  });

  test('status 5 позже 8 мин после отправки → unknown', async () => {
    S.deliveries = [drow(r1, { sent_at: new Date(NOW - 9 * 60 * 1000) })];
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5 } });
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('unknown');
  });

  test('status 3 → delivered', async () => {
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 3 } });
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('delivered');
  });

  test('«Принято» до 10 мин — остаётся accepted, после — unknown', async () => {
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 1 } });
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('accepted');
    expect(rec(1).checked_at).toBeTruthy();
    S.deliveries = [drow(r1, { sent_at: new Date(NOW - 11 * 60 * 1000) })];
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('unknown');
  });

  test('ошибка чтения статуса не финальна: до 10 мин — accepted (перечитаем), после — unknown', async () => {
    // №65 рассылки 3: один таймаут Chatpush 15 с навсегда записал «доставка неизвестна».
    transport.getDeliveryStatus.mockRejectedValue(new Error('timeout of 15000ms exceeded'));
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('accepted');
    expect(rec(1).checked_at).toBeTruthy();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('timeout of 15000ms exceeded'));
    S.deliveries = [drow(r1, { sent_at: new Date(NOW - 11 * 60 * 1000) })];
    await w.checkDeliveries(NOW);
    expect(rec(1).delivery_status).toBe('unknown');
  });
});

describe('checkDeliveries — коды Chatpush (рассылка №3, 06.11.2026)', () => {
  const NF_TG = { status: { status_id: 58, description: 'Пользователь не найден в Telegram' } };
  const NR_MAX = { status: { status_id: 55, description: 'Клиент не зарегистрирован в MAX' } };
  const sentRec = (over = {}) => addRec({
    status: 'sent', sent_at: new Date(NOW - 150 * 1000), delivery_status: 'accepted', delivery_id: '408628094', account_id: 8,
    cascade: ['tdlib', 'whatsapp', 'max'], ...over,
  });

  test('16 «Прочитано» → delivered (раньше: «доставка неизвестна» через 10 мин)', async () => {
    addBroadcast();
    const r = sentRec();
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 16, description: 'Прочитано' } });
    await w.checkDeliveries(NOW);
    expect(r.delivery_status).toBe('delivered');
  });

  test('2 «Доставлено» → delivered; 6 «Принято» — ждём', async () => {
    addBroadcast();
    const a = sentRec();
    const b = sentRec({ delivery_id: '408628095' });
    S.deliveries = [drow(a), drow(b)];
    transport.getDeliveryStatus.mockImplementation(async (_s, _c, id) => (id === '408628094'
      ? { status: { status_id: 2, description: 'Доставлено' } } : { status: { status_id: 6, description: 'Принято' } }));
    await w.checkDeliveries(NOW);
    expect(a.delivery_status).toBe('delivered');
    expect(b.delivery_status).toBe('accepted');
  });

  test('58 «не найден в Telegram» → получатель на следующий шаг каскада, «ушло» −1', async () => {
    const b = addBroadcast({ sent: 5 });
    const r = sentRec();
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    expect(r).toMatchObject({
      status: 'pending', step: 1, channel: 'whatsapp', sent_at: null, delivery_id: null, account_id: null,
      delivery_status: null, error: 'Пользователь не найден в Telegram',
    });
    expect(r.cascade_log[r.cascade_log.length - 1]).toEqual(expect.objectContaining({
      from: 'tdlib', to: 'whatsapp', why: 'not_registered', error: 'Пользователь не найден в Telegram',
      sent_at: new Date(NOW - 150 * 1000).toISOString(), delivery_id: '408628094',
    }));
    expect(b.sent).toBe(4);
    expect(sender.sendToRecipient).not.toHaveBeenCalled(); // отправка — следующим тиком, по правилам паузы
    // следующий тик: уходит в WhatsApp, «ушло» снова 5
    await w.processBroadcast(b, NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledWith(expect.objectContaining({ phone: r.phone, channel: 'whatsapp' }));
    expect(r.status).toBe('sent');
    expect(b.sent).toBe(5);
  });

  test('следующий мессенджер выключен в рассылке — перескакиваем через него', async () => {
    const b = addBroadcast();
    b.channel_settings.whatsapp.enabled = false;
    const r = sentRec();
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    expect(r).toMatchObject({ status: 'pending', step: 2, channel: 'max' });
  });

  test('55 на последнем шаге → undeliverable с причиной, «ушло» не меняется', async () => {
    const b = addBroadcast({ sent: 5 });
    const r = sentRec({ cascade: ['tdlib', 'whatsapp', 'max'], step: 2, channel: 'max', account_id: 10 });
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NR_MAX);
    await w.checkDeliveries(NOW);
    expect(r).toMatchObject({ status: 'sent', channel: 'max', delivery_status: 'undeliverable', error: 'Клиент не зарегистрирован в MAX' });
    expect(b.sent).toBe(5);
  });

  test('рассылка отменена или завершена — каскад не продолжаем, только undeliverable', async () => {
    addBroadcast({ status: 'cancelled', cancel_requested: true });
    const r = sentRec();
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    expect(r).toMatchObject({ status: 'sent', delivery_status: 'undeliverable', error: 'Пользователь не найден в Telegram' });

    bc(1).status = 'completed'; bc(1).cancel_requested = false;
    const r2 = sentRec({ delivery_id: '408628096' });
    S.deliveries = [drow(r2)];
    await w.checkDeliveries(NOW);
    expect(r2).toMatchObject({ status: 'sent', delivery_status: 'undeliverable' });
  });

  test('без каскада в рассылке (один мессенджер) — undeliverable', async () => {
    addBroadcast();
    const r = sentRec({ cascade: ['tdlib'] });
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    expect(r).toMatchObject({ status: 'sent', delivery_status: 'undeliverable' });
  });

  test('ушедшая дальше попытка расходует ЛИМИТ мессенджера-отправителя', async () => {
    const b = addBroadcast();
    b.channel_settings.tdlib.limit = 1;
    const r = sentRec();
    const r2 = addRec({ cascade: ['tdlib', 'whatsapp'], sort_order: 100 });
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    await w.processBroadcast(b, NOW);
    // tdlib: 1 попытка из 1 → r2 уходит по лимиту в WhatsApp, а не в Telegram
    expect(r2.cascade_log).toEqual([expect.objectContaining({ from: 'tdlib', to: 'whatsapp', why: 'limit' })]);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1);
    expect(sender.sendToRecipient).toHaveBeenCalledWith(expect.objectContaining({ phone: r.phone, channel: 'whatsapp' }));
  });

  test('ушедшая дальше попытка держит ПАУЗУ мессенджера-отправителя', async () => {
    const b = addBroadcast();
    b.channel_settings.tdlib.delay_sec = 300; // отправлено 150 с назад → пауза ещё 150 с
    const r = sentRec();
    const r2 = addRec({ cascade: ['tdlib'], sort_order: 100 });
    S.deliveries = [drow(r)];
    transport.getDeliveryStatus.mockResolvedValue(NF_TG);
    await w.checkDeliveries(NOW);
    await w.processBroadcast(b, NOW);
    expect(r2.status).toBe('pending');
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1);
    expect(sender.sendToRecipient).toHaveBeenCalledWith(expect.objectContaining({ phone: r.phone, channel: 'whatsapp' }));
  });
});

describe('завершение рассылки ждёт сверку, если каскад ещё может продолжиться', () => {
  test('отправлено, вердикта нет, следующий шаг есть — не завершаем', async () => {
    const b = addBroadcast();
    addRec({ status: 'sent', sent_at: new Date(NOW - 60 * 1000), delivery_status: 'accepted', delivery_id: '1', cascade: ['tdlib', 'max'] });
    await w.processBroadcast(b, at(22, 0));
    expect(bc(1).status).toBe('in_progress');
  });
  test('последний шаг каскада или без delivery_id — ждать нечего, завершаем', async () => {
    const b = addBroadcast();
    addRec({ status: 'sent', sent_at: new Date(NOW - 60 * 1000), delivery_status: 'accepted', delivery_id: '1', cascade: ['tdlib'] });
    addRec({ status: 'sent', sent_at: new Date(NOW - 60 * 1000), delivery_status: 'accepted', delivery_id: null, cascade: ['tdlib', 'max'] });
    await w.processBroadcast(b, at(22, 0));
    expect(bc(1).status).toBe('completed');
  });
});

describe('deliveryVerdict', () => {
  test('чистая трактовка статусов: таблица кодов — по провайдеру (id g<n> — шлюз, число — Chatpush)', () => {
    expect(w.deliveryVerdict(null, 0, '1')).toBe('unknown');
    expect(w.deliveryVerdict({ status: { status_id: 2 } }, 0, '1')).toBe('delivered');
    expect(w.deliveryVerdict({ status: { status_id: 16 } }, 0, '1')).toBe('delivered');
    expect(w.deliveryVerdict({ status: { status_id: 4 } }, 0, 'g1')).toBe('delivered');
    expect(w.deliveryVerdict({ status: { status_id: 4 } }, 60 * 1000, '1')).toBeNull(); // у Chatpush 4 — не «Прочитано»
    expect(w.deliveryVerdict({ status: { status_id: 58, description: 'Пользователь не найден в Telegram' } }, 0, '1')).toBe('not_registered');
    expect(w.deliveryVerdict({ status: { status_id: 55 } }, 20 * 60 * 1000, '1')).toBe('not_registered'); // отказ доказан и поздно
    expect(w.deliveryVerdict({ status: { status_id: 5, description: 'исход неизвестен' } }, 0, 'g1')).toBe('unknown');
    expect(w.deliveryVerdict({ status: { status_id: 1 } }, 60 * 1000, 'g1')).toBeNull();
    expect(w.deliveryVerdict({ status: { status_id: 6 } }, 11 * 60 * 1000, '1')).toBe('unknown');
  });
});

describe('closeStaleSending', () => {
  test('один запрос с CTE, возвращает число закрытых', async () => {
    S.closeStaleRows = [{ id: 1, n: 2 }, { id: 3, n: 1 }];
    await expect(w.closeStaleSending()).resolves.toBe(3);
    expect(S.calls).toHaveLength(1);
    expect(w.CLOSE_STALE_SQL).toMatch(/WITH upd AS/);
    expect(w.CLOSE_STALE_SQL).toMatch(/status\s*=\s*'sending'/);
    expect(w.CLOSE_STALE_SQL).toMatch(/interval '2 minutes'/);
    expect(w.CLOSE_STALE_SQL).toMatch(/failed\s*=\s*b\.failed\s*\+/);
  });

  test('сбой БД — не бросает', async () => {
    db.any.mockRejectedValueOnce(new Error('db down'));
    await expect(w.closeStaleSending()).resolves.toBe(0);
  });
});

describe('tick', () => {
  test('ошибка одной рассылки не мешает другой, затем сверка доставки', async () => {
    addBroadcast({ id: 1, salon_id: 7 });
    addBroadcast({ id: 2, salon_id: 8 });
    addRec({ broadcast_id: 2 });
    const orig = db.any.getMockImplementation();
    db.any.mockImplementation(async (sql, p) => { if (tagOf(sql) === 'stats' && p[0] === 1) throw new Error('boom'); return orig(sql, p); });
    await w.tick(NOW);
    expect(sender.sendToRecipient).toHaveBeenCalledTimes(1);
    expect(tags()).toContain('deliveries');
  });

  test('guard: второй тик, пока идёт первый, ничего не делает', async () => {
    addBroadcast();
    addRec();
    let release;
    sender.sendToRecipient.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true, delivery_id: '1', account_id: null }); }));
    const p1 = w.tick(NOW);
    await new Promise((r) => setImmediate(r));
    await w.tick(NOW);
    expect(tags().filter((t) => t === 'active')).toHaveLength(1);
    release();
    await p1;
  });
});

describe('SQL-константы', () => {
  test('экспортированы и ограничены мессенджерами', () => {
    expect(w.ACTIVE_SQL).toMatch(/transport\s*=\s*'messengers'/);
    expect(w.ACTIVE_SQL).toMatch(/DISTINCT ON \(salon_id\)/);
    expect(w.STATS_SQL).toMatch(/status IN \('sent','sending'\)/);
    expect(w.STATS_SQL).toMatch(/'not_registered'/); // ушедшие дальше попытки держат паузу и лимит
    expect(w.HEADS_SQL).toMatch(/channel = ANY\(\$2::text\[\]\)/);
    for (const col of ['r.cascade', 'r.step', 'b.status AS broadcast_status', 'b.cancel_requested', 'b.channel_settings']) {
      expect(w.CHECK_SQL).toContain(col);
    }
    // фейк БД выше повторяет эти условия — реальный SQL сверяется тут и живьём (broadcast-messengers-explain.js)
    expect(w.SQL.hasOpen).toMatch(/delivery_status='accepted' AND delivery_id IS NOT NULL/);
    expect(w.SQL.hasOpen).toMatch(/step < COALESCE\(array_length\(cascade, 1\), 0\) - 1/);
    expect(w.SQL.notRegisteredNext).toMatch(/WHERE id=\$1 AND status='sent' AND delivery_status='accepted'/);
    // у новой доставки — свежий цикл сверки (e2e 06.11: checked_at=NOW() откладывал сверку повторной отправки)
    expect(w.SQL.notRegisteredNext).toMatch(/checked_at=NULL/);
  });
});
