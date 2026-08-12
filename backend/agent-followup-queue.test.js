'use strict';

const queue = require('./services/agent/followup-queue');

// Мок пула: собираем вызовы, отдаём заранее подготовленные результаты.
function mockDb(result = { rowCount: 1, rows: [] }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return result; },
    oneOrNone: async (sql, params) => { calls.push({ sql, params }); return result.rows[0] || null; },
  };
}

const SETTINGS = { followupDelay1Min: 15, followupDelay2Min: 60 };
const META = { phone: '79200255591', channel: 'whatsapp', chatId: null };

describe('schedule', () => {
  test('выключенная фича не пишет в БД вовсе', async () => {
    const db = mockDb();
    const r = await queue.schedule(1, '79200255591', META,
      { followupDelay1Min: 0, followupDelay2Min: 60 }, { db });
    expect(r).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('ставит строку на якорь + первый интервал', async () => {
    const db = mockDb();
    const anchor = new Date('2026-08-11T10:00:00.000Z');
    const ok = await queue.schedule(1, '79200255591', META, SETTINGS, { db, now: anchor });
    expect(ok).toBe(true);
    expect(db.calls).toHaveLength(1);
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_followups/);
    // Свежая реплика Милы перезаводит ожидание: якорь и стадия сбрасываются.
    expect(sql).toMatch(/ON CONFLICT/);
    expect(params[1]).toBe('79200255591');
    expect(new Date(params[6]).toISOString()).toBe('2026-08-11T10:15:00.000Z');
  });

  // Перезавод — НОВЫЙ цикл ожидания. Журнал прошлого цикла на живой строке
  // оставлять нельзя: stage=0 при заполненном nudge1_at читается разбором
  // инцидента как «напомнили в текущем цикле», чего не было.
  test('перезавод сбрасывает журнал прошлого цикла', () => {
    const db = mockDb();
    return queue.schedule(1, 'k', META, SETTINGS, { db }).then(() => {
      const { sql } = db.calls[0];
      for (const f of ['nudge1_at=NULL', 'final_at=NULL', 'rendered_text=NULL', 'error=NULL']) {
        expect(sql.replace(/\s+/g, '')).toContain(f.replace(/\s+/g, ''));
      }
    });
  });

  test('без dialogKey не пишет ничего', async () => {
    const db = mockDb();
    expect(await queue.schedule(1, '', META, SETTINGS, { db })).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('сбой БД не бросает наружу — ход клиента важнее строки очереди', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    await expect(queue.schedule(1, 'k', META, SETTINGS, { db })).resolves.toBe(false);
  });
});

describe('close', () => {
  test('гасит только живую строку и пишет причину', async () => {
    const db = mockDb({ rowCount: 1, rows: [] });
    const ok = await queue.close(1, '79200255591', 'answered', 'client_replied', { db });
    expect(ok).toBe(true);
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/UPDATE agent_followups/);
    expect(sql).toMatch(/status\s*=\s*'scheduled'/);
    expect(params).toEqual([1, '79200255591', 'answered', 'client_replied']);
  });

  test('неизвестный статус отвергается — опечатка не должна писать мусор', async () => {
    const db = mockDb();
    await expect(queue.close(1, 'k', 'ответили', 'x', { db })).rejects.toThrow(/bad status/);
  });

  test('сбой БД не бросает наружу', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    await expect(queue.close(1, 'k', 'answered', 'client_replied', { db })).resolves.toBe(false);
  });
});
