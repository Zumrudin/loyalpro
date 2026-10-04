// backend/dialog-verdicts-run.test.js
'use strict';
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const run = require('./services/dialog-verdicts/run');
const { TAXONOMY_VERSION } = require('./services/dialog-verdicts/taxonomy');

const dd = (over) => ({ dkey: 'test-contact', day: '2026-10-03', channel: 'tdlib', phone: 'test-contact',
  max_ts: '1759500000', verdict_id: null, source_max_ts: null, taxonomy_version: null, status: null, ...over });
const msgRow = (dkey, over) => ({ dkey, direction: 'incoming', authored_by: null, text: 'хочу записаться', msg_type: 'text', msg_ts: 1759500000, day: '2026-10-03', ...over });

function mkStore(dialogDays, over = {}) {
  return {
    createRun: jest.fn(async () => 7),
    finishRun: jest.fn(async () => {}),
    progressRun: jest.fn(async () => {}),
    listDialogDays: jest.fn(async () => dialogDays),
    loadMessages: jest.fn(async (_s, keys, day) => keys.map(k => msgRow(k, { day }))),
    loadBookedCrm: jest.fn(async () => new Set()),
    upsertVerdicts: jest.fn(async rows => rows.length),
    ...over,
  };
}
const okText = (ids, status = 'pending') => JSON.stringify({ verdicts: ids.map(id => ({ id, status, note: 'n' })) });
const base = { salonId: 1, from: '2026-10-01', to: '2026-10-03', trigger: 'manual' };

afterEach(() => run._resetForTests());

describe('runVerdicts', () => {
  test('счастливый путь: строка прогона, пачки по дням от свежих к старым, UPSERT после каждой, done', async () => {
    const store = mkStore([dd({ dkey: 'a', day: '2026-10-01' }), dd({ dkey: 'b', day: '2026-10-03' }), dd({ dkey: 'c', day: '2026-10-03' })]);
    const calls = [];
    const provider = { createMessage: jest.fn(async ({ system, messages }) => {
      calls.push(messages[0].content);
      const ids = [...messages[0].content.matchAll(/^### (d\d+)/gm)].map(m => m[1]);
      expect(system).toMatch(/аналитик переписок/);
      return { text: okText(ids, 'booked'), model: 'gpt-6-sol' };
    }) };
    const r = await run.runVerdicts(base, { store, provider, sleep: async () => {} });
    expect(r.runId).toBe(7);
    const res = await r.done;
    expect(store.createRun).toHaveBeenCalledWith(expect.objectContaining({ salonId: 1, trigger: 'manual', from: '2026-10-01', to: '2026-10-03', recompute: false }));
    expect(provider.createMessage).toHaveBeenCalledTimes(2);           // два дня → два запроса
    expect(calls[0]).toContain('### d2');                               // первым — день 03.10 (2 диалога)
    expect(calls[1]).not.toContain('### d2');                           // потом 01.10 (1 диалог)
    expect(store.upsertVerdicts).toHaveBeenCalledTimes(2);
    const rows = store.upsertVerdicts.mock.calls[0][1];
    expect(rows[0]).toMatchObject({ dialog_key: 'b', day: '2026-10-03', status: 'booked', note: 'n', label: null,
      notified: false, booked_crm: false, taxonomy_version: TAXONOMY_VERSION, model: 'gpt-6-sol', run_id: 7, source_max_ts: '1759500000' });
    expect(store.finishRun).toHaveBeenCalledWith(1, 7, expect.objectContaining({ status: 'done', requested: 3, analyzed: 3, failed: 0, batches: 2, model: 'gpt-6-sol' }));
    expect(res).toMatchObject({ requested: 3, analyzed: 3, failed: 0 });
  });

  test('notified и booked_crm считаются кодом и ложатся в строку', async () => {
    const store = mkStore([dd({ dkey: 'a' })], {
      loadMessages: jest.fn(async () => [msgRow('a'), msgRow('a', { direction: 'outgoing', authored_by: 'system', text: 'Вы записаны на прием 04.10.2026 12:00 в «PERI CLINIC».' })]),
      loadBookedCrm: jest.fn(async () => new Set(['a'])),
    });
    const provider = { createMessage: async () => ({ text: okText(['d1'], 'booked'), model: 'm' }) };
    await (await run.runVerdicts(base, { store, provider, sleep: async () => {} })).done;
    expect(store.upsertVerdicts.mock.calls[0][1][0]).toMatchObject({ notified: true, booked_crm: true });
    expect(store.loadBookedCrm).toHaveBeenCalledWith(1, ['a'], '2026-10-03', ['test-contact']);
  });

  test('невалидный ответ → один повтор с причинами; вторая неудача → failed, строки не пишутся, прогон продолжается', async () => {
    const store = mkStore([dd({ dkey: 'a', day: '2026-10-03' }), dd({ dkey: 'b', day: '2026-10-02' })]);
    let n = 0;
    const provider = { createMessage: jest.fn(async ({ messages }) => {
      n++;
      if (n <= 2) { if (n === 2) expect(messages[0].content).toContain('В прошлый раз ответ был невалиден'); return { text: 'мусор', model: 'm' }; }
      return { text: okText(['d1']), model: 'm' };
    }) };
    const sleep = jest.fn(async () => {});
    const res = await (await run.runVerdicts(base, { store, provider, sleep })).done;
    expect(sleep).toHaveBeenCalledWith(run.PAUSE_MS);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(provider.createMessage).toHaveBeenCalledTimes(3);
    expect(store.upsertVerdicts).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ requested: 2, analyzed: 1, failed: 1, batches: 2 });
  });

  test('пачки режутся по BATCH_SIZE внутри дня', async () => {
    const days = Array.from({ length: run.BATCH_SIZE + 1 }, (_, i) => dd({ dkey: 'k' + i }));
    const store = mkStore(days);
    const provider = { createMessage: jest.fn(async ({ messages }) => {
      const ids = [...messages[0].content.matchAll(/^### (d\d+)/gm)].map(m => m[1]);
      return { text: okText(ids), model: 'm' };
    }) };
    await (await run.runVerdicts(base, { store, provider, sleep: async () => {} })).done;
    expect(provider.createMessage).toHaveBeenCalledTimes(2);
    expect(store.upsertVerdicts.mock.calls[0][1]).toHaveLength(run.BATCH_SIZE);
    expect(store.upsertVerdicts.mock.calls[1][1]).toHaveLength(1);
  });

  test('уже проанализированные без recompute не отправляются; sinceHours режет окно', async () => {
    const now = 1759600000;
    const store = mkStore([
      dd({ dkey: 'done', verdict_id: 1, source_max_ts: '1759500000', taxonomy_version: TAXONOMY_VERSION, status: 'booked' }),
      dd({ dkey: 'old', max_ts: String(now - 48 * 3600) }),
      dd({ dkey: 'fresh', max_ts: String(now - 3600) }),
    ]);
    const provider = { createMessage: jest.fn(async () => ({ text: okText(['d1']), model: 'm' })) };
    const res = await (await run.runVerdicts({ ...base, sinceHours: 36 }, { store, provider, sleep: async () => {}, now: () => now * 1000 })).done;
    expect(res.requested).toBe(1);
    expect(store.upsertVerdicts.mock.calls[0][1][0].dialog_key).toBe('fresh');
  });

  test('падение провайдера на всех звеньях → прогон error, сделанное остаётся', async () => {
    const store = mkStore([dd({ dkey: 'a', day: '2026-10-03' }), dd({ dkey: 'b', day: '2026-10-02' })]);
    let n = 0;
    const provider = { createMessage: async () => { if (n++ === 0) return { text: okText(['d1']), model: 'm' }; throw Object.assign(new Error('all down'), { code: 'VERDICT_PROVIDER_FAILED' }); } };
    const r = await run.runVerdicts(base, { store, provider, sleep: async () => {} });
    await expect(r.done).rejects.toThrow('all down');
    expect(store.upsertVerdicts).toHaveBeenCalledTimes(1);
    expect(store.finishRun).toHaveBeenCalledWith(1, 7, expect.objectContaining({ status: 'error', analyzed: 1, error: 'VERDICT_PROVIDER_FAILED' }));
  });

  test('второй запуск во время прогона → RUN_IN_PROGRESS; после завершения можно снова', async () => {
    const store = mkStore([dd({ dkey: 'a' })]);
    let release;
    const provider = { createMessage: () => new Promise(res => { release = () => res({ text: okText(['d1']), model: 'm' }); }) };
    const r1 = await run.runVerdicts(base, { store, provider, sleep: async () => {} });
    await expect(run.runVerdicts(base, { store, provider })).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    await r1.done;
    const r2 = await run.runVerdicts(base, { store, provider: { createMessage: async () => ({ text: okText([]), model: 'm' }) }, sleep: async () => {} });
    await r2.done;
    expect(store.createRun).toHaveBeenCalledTimes(2);
  });

  test('dryRun: ни createRun, ни upsert, но onBatch получает items и вердикты', async () => {
    const store = mkStore([dd({ dkey: 'a' })]);
    const onBatch = jest.fn();
    const provider = { createMessage: async () => ({ text: okText(['d1'], 'question'), model: 'm' }) };
    const r = await run.runVerdicts(base, { store, provider, sleep: async () => {}, dryRun: true, onBatch });
    await r.done;
    expect(r.runId).toBeNull();
    expect(store.createRun).not.toHaveBeenCalled();
    expect(store.upsertVerdicts).not.toHaveBeenCalled();
    expect(onBatch).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-03', items: [expect.objectContaining({ id: 'd1' })], verdicts: [expect.objectContaining({ status: 'question' })] }));
  });
});
