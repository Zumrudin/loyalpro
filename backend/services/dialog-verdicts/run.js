// backend/services/dialog-verdicts/run.js
'use strict';
// ============================================================
// Прогон вердиктов: отбор диалог-дней → пачки по дням (свежие первыми) →
// модель → разбор → UPSERT после КАЖДОЙ пачки (падение посреди бэкфилла не
// теряет сделанного; повторный запуск доделывает остаток, потому что уже
// проанализированные без recompute не отправляются).
// Один прогон на процесс (как backfillInFlight в reminders): второй запуск
// получает RUN_IN_PROGRESS (409 у кнопки, пропуск тика у крона).
// runVerdicts возвращает { runId, done }: runId известен сразу (кнопке нужен
// 202 с id), done — промис остального прогона (крон его ждёт).
// ============================================================
const { createLogger } = require('../../logger');
const logger = createLogger('DialogVerdicts');
const defaultStore = require('./store');
const { safeError } = require('./errors');
const { createVerdictProvider } = require('./provider');
const { renderDialogDay, detectNotified } = require('./render');
const { SYSTEM_PROMPT, buildUserMessage, retrySuffix } = require('./prompt');
const { parseVerdicts } = require('./parse');
const { pickPending, groupByDayDesc, chunks } = require('./select');
const { TAXONOMY_VERSION } = require('./taxonomy');

const BATCH_SIZE = 50;
const PAUSE_MS = 2000;
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

let inFlight = false;

function groupMessages(msgs) {
  const m = new Map();
  for (const r of msgs) { if (!m.has(r.dkey)) m.set(r.dkey, []); m.get(r.dkey).push(r); }
  return m;
}

async function processBatch({ salonId, day, chunk, runId, store, provider, log, dryRun, onBatch, sleep }) {
  const keys = chunk.map(r => r.dkey);
  const phones = chunk.map(r => r.phone || '');
  const msgs = await store.loadMessages(salonId, keys, day);
  const crm = await store.loadBookedCrm(salonId, keys, day, phones);
  const byKey = groupMessages(msgs);
  const items = chunk.map((row, i) => {
    const all = byKey.get(row.dkey) || [];
    return {
      id: 'd' + (i + 1), row,
      text: renderDialogDay({ dayMessages: all.filter(m => m.day === day), tailMessages: all.filter(m => m.day < day) }),
      notified: detectNotified(all, day),
    };
  });
  const expected = items.map(it => it.id);
  let parsed = null, model = null, reasons = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(PAUSE_MS);
    const content = buildUserMessage(items) + (reasons ? retrySuffix(reasons) : '');
    const res = await provider.createMessage({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content }], tools: [] });
    model = res.model || null;
    parsed = parseVerdicts(res.text, expected);
    if (parsed.ok) break;
    reasons = parsed.reasons;
    log.warn(`день ${day}, пачка из ${chunk.length}: невалидный ответ (ошибок: ${reasons.length})${attempt === 0 ? ' — повтор' : ''}`);
  }
  if (!parsed.ok) return { analyzed: 0, failed: chunk.length, model };
  const rows = items.map((it, i) => {
    const v = parsed.verdicts[i];
    return {
      dialog_key: it.row.dkey, channel: it.row.channel, phone: it.row.phone || null, day,
      status: v.status, label: v.label, note: v.note,
      notified: it.notified, booked_crm: crm.has(it.row.dkey),
      taxonomy_version: TAXONOMY_VERSION, model, run_id: runId, source_max_ts: it.row.max_ts,
    };
  });
  if (onBatch) onBatch({ day, items, verdicts: parsed.verdicts, rows });
  if (!dryRun) await store.upsertVerdicts(salonId, rows);
  return { analyzed: rows.length, failed: 0, model };
}

// opts: { salonId, from, to, trigger, recompute, onlyStale, sinceHours }
// deps: { store, provider, sleep, logger, now, dryRun, onBatch }
async function runVerdicts(opts, deps = {}) {
  const store = deps.store || defaultStore;
  const log = deps.logger || logger;
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || Date.now;
  const dryRun = !!deps.dryRun;
  const { salonId, from, to, trigger = 'manual', recompute = false, onlyStale = false, sinceHours = null } = opts;
  if (inFlight) { const e = new Error('прогон анализа уже идёт'); e.code = 'RUN_IN_PROGRESS'; throw e; }
  inFlight = true;
  let runId = null;
  try {
    if (!dryRun) runId = await store.createRun({ salonId, trigger, from, to, recompute });
  } catch (e) { inFlight = false; throw e; }

  const done = (async () => {
    const c = { requested: 0, analyzed: 0, failed: 0, batches: 0, model: null };
    try {
      const provider = deps.provider || createVerdictProvider();
      const rows = await store.listDialogDays(salonId, from, to);
      const sinceTs = sinceHours ? Math.floor(now() / 1000) - sinceHours * 3600 : null;
      const pending = pickPending(rows, { recompute, onlyStale, sinceTs, taxonomyVersion: TAXONOMY_VERSION });
      c.requested = pending.length;
      if (!dryRun) await store.progressRun(salonId, runId, c);
      log.info(`salon=${salonId} ${trigger} ${from}..${to}: диалог-дней ${rows.length}, к анализу ${pending.length}`);
      for (const [day, dayRows] of groupByDayDesc(pending)) {
        for (const chunk of chunks(dayRows, BATCH_SIZE)) {
          const t0 = Date.now();
          const r = await processBatch({ salonId, day, chunk, runId, store, provider, log, dryRun, onBatch: deps.onBatch, sleep });
          c.batches++; c.analyzed += r.analyzed; c.failed += r.failed; if (r.model) c.model = r.model;
          log.info(`день ${day}: ${chunk.length} диалогов, ок=${r.analyzed} сбой=${r.failed} модель=${r.model} ${Date.now() - t0}мс`);
          if (!dryRun) await store.progressRun(salonId, runId, c).catch(() => {});
          await sleep(PAUSE_MS);
        }
      }
      if (!dryRun) await store.finishRun(salonId, runId, { status: 'done', ...c });
      return { runId, ...c };
    } catch (e) {
      log.error(`salon=${salonId} прогон упал: ${safeError(e)}`);
      if (!dryRun) await store.finishRun(salonId, runId, { status: 'error', error: safeError(e), ...c }).catch(() => {});
      throw e;
    } finally { inFlight = false; }
  })();
  // Отвергнутый done без обработчика у вызывающего не должен ронять процесс.
  done.catch(() => {});
  return { runId, done };
}

function isRunning() { return inFlight; }
function _resetForTests() { inFlight = false; }

module.exports = { runVerdicts, isRunning, BATCH_SIZE, PAUSE_MS, _resetForTests };
