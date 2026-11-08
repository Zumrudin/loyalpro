'use strict';
// Сервис и роуты рассылок через мессенджеры: валидация тела, порядок маршрутов, кэш базы прогноза, монитор.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/broadcast-messengers/audience', () => ({
  loadAudienceBase: jest.fn(), applyCascade: jest.fn(), resolveAudience: jest.fn(),
}));
jest.mock('./services/broadcast-messengers/sender', () => ({ sendToRecipient: jest.fn() }));
jest.mock('./services/messaging/accounts', () => ({ credentialsFor: jest.fn() }));

const { db } = require('./db');
const audience = require('./services/broadcast-messengers/audience');
const svc = require('./services/broadcast-messengers/service');

const CH = {
  tdlib: { enabled: true, delay_sec: 60, limit: null },
  whatsapp: { enabled: false, delay_sec: 180, limit: '' },
  max: { enabled: false, delay_sec: 60 },
};
const valid = () => ({
  transport: 'messengers', audienceSource: 'filters', filters: { bonusMin: 100 },
  messageTemplate: 'Привет, {first_name}', channelSettings: JSON.parse(JSON.stringify(CH)),
  onLimit: 'next_channel', cascadeEnabled: true,
});

describe('parseCreateBody', () => {
  test('валидное тело нормализуется', () => {
    const r = svc.parseCreateBody(valid());
    expect(r.ok).toBe(true);
    expect(r.value.channelSettings.whatsapp.limit).toBeNull();
    expect(r.value.channelSettings.max).toEqual({ enabled: false, delay_sec: 60, limit: null });
    expect(r.value.imageUrl).toBeNull();
  });
  test('список: номера канонизируются повторно, дубли схлопываются', () => {
    const r = svc.parseCreateBody({ ...valid(), audienceSource: 'list', list: [{ name: 'А', phone: '8 (920) 025-55-91' }, { name: 'Б', phone: '+79200255591' }] });
    expect(r.ok).toBe(true);
    expect(r.value.list).toEqual([{ name: 'А', phone: '79200255591' }]);
  });
  const bad = (mut, re) => {
    const b = valid(); mut(b);
    const r = svc.parseCreateBody(b);
    expect(r.ok).toBe(false);
    if (re) expect(r.error).toMatch(re);
  };
  test('ветки отказа', () => {
    bad((b) => { b.transport = 'telegram_bot'; }, /transport/);
    bad((b) => { b.audienceSource = 'x'; }, /Источник/);
    bad((b) => { b.filters = []; }, /Фильтры/);
    bad((b) => { b.audienceSource = 'list'; b.list = []; }, /пуст/);
    bad((b) => { b.audienceSource = 'list'; b.list = [{ phone: 'abc' }]; }, /номер/);
    bad((b) => { b.audienceSource = 'list'; b.list = Array.from({ length: 5001 }, (_, i) => ({ phone: '7920' + String(1000000 + i) })); }, /5000/);
    bad((b) => { b.messageTemplate = '  '; }, /текст/);
    bad((b) => { b.messageTemplate = 'x'.repeat(4001); }, /длинное/);
    bad((b) => { b.imageUrl = '/uploads/evil.php'; }, /картинки/);
    bad((b) => { b.imageUrl = '/uploads/broadcast_1_2.gif'; }, /картинки/);
    bad((b) => { b.channelSettings = null; }, /настройки/);
    bad((b) => { b.channelSettings.tdlib.enabled = 'yes'; }, /enabled/);
    bad((b) => { b.channelSettings.tdlib.delay_sec = 3601; }, /пауза/);
    bad((b) => { b.channelSettings.tdlib.delay_sec = 1.5; }, /пауза/);
    bad((b) => { b.channelSettings.tdlib.limit = 0; }, /лимит/);
    bad((b) => { b.channelSettings.tdlib.limit = 10001; }, /лимит/);
    bad((b) => { b.channelSettings.tdlib.enabled = false; }, /хотя бы один/);
    bad((b) => { b.onLimit = 'boom'; }, /onLimit/);
    bad((b) => { b.cascadeEnabled = 'yes'; }, /cascadeEnabled/);
  });
  test('картинка из загрузки принимается', () => {
    const r = svc.parseCreateBody({ ...valid(), imageUrl: '/uploads/broadcast_1_1730000000000.jpg' });
    expect(r.ok).toBe(true);
  });
});

describe('порядок маршрутов', () => {
  test('статические пути раньше первого /:id', () => {
    const router = require('./routes/broadcasts');
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    const firstId = paths.findIndex((p) => p.startsWith('/:id'));
    for (const p of ['/list/parse', '/image', '/forecast', '/test', '/subscribers/preview']) {
      const i = paths.indexOf(p);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(firstId);
    }
    for (const p of ['/:id/monitor', '/:id/recipients', '/:id/pause', '/:id/resume', '/:id/retry-draft', '/:id/cancel']) {
      expect(paths).toContain(p);
    }
  });
  test('нечисловой id в пути — 404, а не 500 от pg', async () => {
    const router = require('./routes/broadcasts');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:id/monitor' && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ params: { id: 'abc' }, user: { salonId: 1 }, query: {} }, res);
    expect(res.code).toBe(404);
    expect(res.body.error).toBe('Рассылка не найдена');
  });
});

describe('кэш базы прогноза', () => {
  const v1 = () => svc.parseCreateBody({ ...valid(), audienceSource: 'list', list: [{ name: '', phone: '79200255591' }] }).value;
  beforeEach(() => {
    svc.clearForecastCache();
    audience.loadAudienceBase.mockReset().mockResolvedValue({ people: [], convs: [], cfg: {}, skipped: { blacklist: 0, no_recipient: 0 } });
    audience.applyCascade.mockReset().mockReturnValue({
      recipients: [{ cascade: ['tdlib'] }, { cascade: [] }], skipped: { blacklist: 1, no_recipient: 2 },
    });
  });
  test('другие настройки каналов — база не грузится повторно; другой список — грузится', async () => {
    const a = v1();
    const r = await svc.forecastBroadcast(1, a);
    expect(r.total).toBe(2);
    expect(r.skipped).toBe(3);
    expect(r.byChannel.tdlib).toBe(1);
    const b = { ...a, channelSettings: { ...a.channelSettings, tdlib: { enabled: true, delay_sec: 5, limit: 1 } } };
    await svc.forecastBroadcast(1, b);
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(1);
    expect(audience.applyCascade).toHaveBeenCalledTimes(2);
    await svc.forecastBroadcast(1, { ...a, list: [{ name: '', phone: '79200000000' }] });
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(2);
    await svc.forecastBroadcast(2, a); // другой салон
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(3);
  });
  test('TTL: по истечении база грузится заново', async () => {
    const a = v1();
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(1000000);
    await svc.forecastBroadcast(1, a);
    spy.mockReturnValue(1000000 + svc.FORECAST_TTL_MS + 1);
    await svc.forecastBroadcast(1, a);
    spy.mockRestore();
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(2);
  });
  test('кап 20 ключей: старейший вытесняется', async () => {
    const mk = (n) => ({ ...v1(), list: [{ name: '', phone: `7920000${String(1000 + n)}` }] });
    for (let i = 0; i < 21; i++) await svc.forecastBroadcast(1, mk(i));
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(21);
    await svc.forecastBroadcast(1, mk(20)); // свежий — из кэша
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(21);
    await svc.forecastBroadcast(1, mk(0)); // вытеснен
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(22);
  });
  test('упавшая загрузка не остаётся в кэше', async () => {
    audience.loadAudienceBase.mockRejectedValueOnce(new Error('db'));
    await expect(svc.forecastBroadcast(1, v1())).rejects.toThrow('db');
    await svc.forecastBroadcast(1, v1());
    expect(audience.loadAudienceBase).toHaveBeenCalledTimes(2);
  });
});

describe('таблица получателей и «по пропущенным»', () => {
  beforeEach(() => { db.oneOrNone.mockReset(); db.any.mockReset(); });

  test('фильтр «не доставлено» — sent + delivery_status, а не status', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce({ n: 0 });
    db.any.mockResolvedValueOnce([]);
    await svc.recipients(1, 5, { status: 'undeliverable' });
    const [sql, params] = db.oneOrNone.mock.calls[1];
    expect(sql).toMatch(/status = 'sent' AND delivery_status = \$2/);
    expect(params).toEqual([5, 'undeliverable']);
  });

  test('обычный статус фильтруется по status как раньше', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce({ n: 0 });
    db.any.mockResolvedValueOnce([]);
    await svc.recipients(1, 5, { status: 'skipped' });
    const [sql, params] = db.oneOrNone.mock.calls[1];
    expect(sql).toMatch(/AND status = \$2/);
    expect(sql).not.toMatch(/delivery_status/);
    expect(params).toEqual([5, 'skipped']);
  });

  test('«по пропущенным» берёт и не доставленных, но не «доставка неизвестна»', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5 });
    db.any.mockResolvedValueOnce([{ name: 'Волкова Дарья', phone: '79260643864' }, { name: null, phone: '79001542566' }]);
    const list = await svc.retryDraft(1, 5);
    expect(list).toEqual([{ name: 'Волкова Дарья', phone: '79260643864' }, { name: '', phone: '79001542566' }]);
    const sql = db.any.mock.calls[0][0];
    expect(sql).toMatch(/status IN \('skipped','failed','cancelled'\) OR \(status = 'sent' AND delivery_status = 'undeliverable'\)/);
    expect(sql).not.toMatch(/'unknown'/);
  });
});

describe('monitor и scope по салону', () => {
  test('чужая рассылка — 404', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    await expect(svc.monitor(1, 5)).rejects.toMatchObject({ status: 404 });
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([5, 1]);
  });
  test('сводка по каналам', async () => {
    const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
    db.oneOrNone.mockResolvedValueOnce({
      id: 5, status: 'in_progress', paused: false, total: 10, sent: 3, failed: 0, skipped: 1, on_limit: 'skip',
      cascade_enabled: true, channel_settings: JSON.stringify({ tdlib: { enabled: true, delay_sec: 60, limit: 3 }, whatsapp: { enabled: true, delay_sec: 180 }, max: { enabled: false } }),
    });
    db.any
      .mockResolvedValueOnce([{ channel: 'tdlib', last_ms: String(now - 10000), n: 3 }]) // STATS_SQL
      .mockResolvedValueOnce([
        { channel: 'tdlib', status: 'sent', delivery_status: 'delivered', n: 2 },
        { channel: 'tdlib', status: 'sent', delivery_status: 'accepted', n: 1 },
        { channel: 'whatsapp', status: 'pending', delivery_status: null, n: 4 },
      ])
      .mockResolvedValueOnce([{ ch: 'tdlib', n: 2 }])
      .mockResolvedValueOnce([{ id: 9, name: 'Анна', phone: '79200000001', channel: 'whatsapp' }]);
    const m = await svc.monitor(1, 5, now);
    expect(m.inWindow).toBe(true);
    expect(m.channels.tdlib.state).toBe('limit');
    expect(m.channels.tdlib.byDelivery).toEqual({ delivered: 2, accepted: 1 });
    expect(m.channels.tdlib.advancedFrom).toBe(2);
    expect(m.channels.whatsapp.state).toBe('free');
    expect(m.channels.whatsapp.byStatus).toEqual({ pending: 4 });
    expect(m.channels.max.state).toBe('disabled');
    expect(m.byStatus).toEqual({ sent: 3, pending: 4 });
    expect(m.byDelivery).toEqual({ delivered: 2, accepted: 1 });
    expect(m.waiting).toHaveLength(1);
  });
  test('«перешли дальше» разбиты по причинам; итоги доставки по рассылке', async () => {
    const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
    db.any.mockClear(); // ниже смотрим calls[2] — история вызовов не должна зависеть от соседних тестов
    db.oneOrNone.mockResolvedValueOnce({
      id: 5, status: 'completed', total: 98, sent: 90, failed: 0, skipped: 8, on_limit: 'next_channel', cascade_enabled: true,
      channel_settings: { tdlib: { enabled: true, delay_sec: 300, limit: 30 }, whatsapp: { enabled: true, delay_sec: 300, limit: 30 }, max: { enabled: true, delay_sec: 300, limit: 30 } },
    });
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { channel: 'tdlib', status: 'sent', delivery_status: 'delivered', n: 28 },
        { channel: 'max', status: 'sent', delivery_status: 'undeliverable', n: 9 },
        { channel: 'max', status: 'sent', delivery_status: 'unknown', n: 1 },
      ])
      .mockResolvedValueOnce([
        { ch: 'tdlib', why: 'limit', n: 49 }, { ch: 'tdlib', why: 'not_registered', n: 2 }, { ch: 'whatsapp', why: 'limit', n: 31 },
      ])
      .mockResolvedValueOnce([]);
    const m = await svc.monitor(1, 5, now);
    expect(m.channels.tdlib.advancedFrom).toBe(51);
    expect(m.channels.tdlib.advancedBy).toEqual({ limit: 49, not_registered: 2 });
    expect(m.channels.whatsapp.advancedBy).toEqual({ limit: 31 });
    expect(m.channels.max.advancedBy).toEqual({});
    expect(m.byDelivery).toEqual({ delivered: 28, undeliverable: 9, unknown: 1 });
    expect(db.any.mock.calls[2][0]).toMatch(/GROUP BY 1, 2/);
  });
  test('resume снимает паузу и причину', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5 });
    db.query.mockClear();
    await svc.resume(1, 5);
    expect(db.query.mock.calls[0][0]).toMatch(/paused = FALSE, pause_reason = NULL/);
  });
});


describe('изоляция картинки рассылки по салону', () => {
  test('создание и тест отвергают картинку другого салона до побочных действий', async () => {
    const value = svc.parseCreateBody({ ...valid(), imageUrl: '/uploads/broadcast_2_1730000000000.jpg' }).value;
    audience.resolveAudience.mockClear();
    await expect(svc.createBroadcast(1, 1, value)).rejects.toMatchObject({ status: 400 });
    await expect(svc.testSend(1, value, '79000000000')).rejects.toMatchObject({ status: 400 });
    expect(audience.resolveAudience).not.toHaveBeenCalled();
    expect(require('./services/broadcast-messengers/sender').sendToRecipient).not.toHaveBeenCalled();
  });
});
