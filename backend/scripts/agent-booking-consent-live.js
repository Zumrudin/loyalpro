#!/usr/bin/env node
'use strict';
// Opt-in live QA: real configured model, booking tools and CRM; isolated in-memory
// conversation. Never clears patient history. Writes only to the supplied owner
// phone and only moves records created in this run. No patient texts in reports.
// OWNER_TEST_PHONE=... node scripts/agent-booking-consent-live.js --execute
// JSONL stdin: new, tool (read only), seed, turn, records, cleanup, quit.
// cleanup requires an explicit --allow-cleanup flag after user approval.
require('dotenv').config();
process.env.LOG_LEVEL = 'error';
const fs = require('fs');
const readline = require('readline');
const logger = require('../logger');
const originalLogger = logger.createLogger;
logger.createLogger = name => { const l = originalLogger(name); l.silent = true; return l; };
const { db } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');
const listBookings = require('../services/agent/tools/list-client-bookings');
const { ycGetRecord } = require('../services/yclients-records');
const { createSlotEvidence } = require('../services/agent/slot-evidence');
const offers = require('../services/agent/sequential-offers');
const phone = String(process.env.OWNER_TEST_PHONE || '').replace(/\D/g, '');
if (!process.argv.includes('--execute') || !/^7\d{10}$/.test(phone)) throw Error('Explicit live execution and owner phone required');
const salonId = Number(process.env.TEST_SALON_ID || 1);
const runId = `consent-live-${Date.now()}`;
// LIVE_EXTRA_IDS: записи прошлых прогонов этого же теста (YClients оживляет отменённые
// записи клиента при создании новой в тот же день) — считаются тестовыми.
const created = new Set(String(process.env.LIVE_EXTRA_IDS || '').split(',').filter(Boolean).map(Number));
const report = { runId, scenarios: [], created: [], verifications: [] };
const reportPath = `/tmp/${runId}.json`;
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
let salon, owner, messages = [], journal = [], calls = [], scenario = 'initial', serial = 0, key, watermark = 0, writes = 0;
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const brief = (name, result, input = {}) => ({ tool: name, pc: input.patient_confirmed, opt: input.option_id, err: result?.error ? String(result.error).slice(0, 90) : undefined, error: !!result?.error,
  code: ['needs_confirmation','requires_reschedule','wrong_service','unverified_slot','option_expired','reschedule_blocked','partial','not_bookable'].filter(k => result?.[k]),
  created: !!result?.created, rescheduled: !!result?.rescheduled, booked_all: !!result?.booked_all,
  duplicate: !!result?.duplicate, record_ids: [result?.record_id, ...(result?.records || []).map(r => r.record_id)].filter(Boolean) });
const rememberIds = result => {
  if (result?.created && result.record_id) created.add(Number(result.record_id));
  for (const r of result?.records || []) if (r.record_id) created.add(Number(r.record_id));
  report.created = [...created]; save();
};
const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
const handlers = Object.fromEntries(Object.entries(base.handlers).map(([name, fn]) => [name, async (sid, input, ctx) => {
  if (sid !== salonId || (input.client_phone && String(input.client_phone).replace(/\D/g, '') !== phone)) throw Error('OUTSIDE_OWNER_SCOPE');
  if (['cancel_booking','modify_booking_services','escalate_to_operator','send_price_list'].includes(name)) return { error: 'Операция вне текущего тестового сценария.' };
  if (name === 'reschedule_booking' && !created.has(Number(input.record_id))) return { error: 'Разрешён перенос только записей текущего тестового прогона.' };
  if (name === 'book_chain' && ctx.liveBookings?.some(r => !created.has(Number(r.record_id)))) return { error: 'Вне тестового набора есть существующая запись.' };
  if (['create_booking','book_chain','reschedule_booking'].includes(name)) {
    if (++writes > 30) throw Error('LIVE_WRITE_LIMIT');
    input = { ...input, comment: `[${runId}] owner-authorized live QA` };
  }
  const result = await fn(sid, input, ctx);
  if (['create_booking','book_chain'].includes(name)) rememberIds(result);
  const b = brief(name, result, input); calls.push(b); emit({ event: 'tool', ...b });
  return result;
}]));
const memoryEvents = {
  loadRecent: async () => journal.map(r => ({ ...r, age_ms: Date.now() - r.at })),
  createBuffer: () => {
    const turnId = `${runId}-${++serial}`; let done = false; const rows = [];
    return { turnId, push: (tool, input, result, is_error) => rows.push({ tool, input, result, is_error, turn_id: turnId, at: Date.now(), delivered: true }),
      flush: async () => { if (!done) { journal.push(...rows); done = true; } } };
  },
};
const history = {
  loadTranscript: async () => ({ messages: messages.map(m => ({ ...m })), watermark: messages.length, session: { newSession: false }, leadingClinic: [] }),
  hasIncomingAfter: async () => false,
  hasEverAnswered: async () => messages.some(m => m.role === 'assistant'),
  hasAgentEverWritten: async () => messages.some(m => m.role === 'assistant'),
  lastOutgoing: async () => null, lastOutgoingAuthor: async () => 'agent',
  followupStopReason: async () => null,
};
const state = { getOrCreate: async () => ({ status: 'bot', last_processed_ts: watermark }), setWatermark: async (_s,_k,w) => { watermark = w; } };
// LIVE_PROVIDER=claude: прямой вызов локального моста (Claude Sonnet), как на проде.
const provider = process.env.LIVE_PROVIDER === 'claude'
  ? require('../services/agent/providers/codex-relay').createProvider({ engine: 'claude', allowLoopback: true })
  : providers.getProviderForSalon(salonId);
async function actualRecords() {
  const r = await listBookings.run(salonId, {}, { clientPhone: phone });
  if (r.error || !Array.isArray(r.bookings)) throw Error('BOOKINGS_READ_FAILED');
  return r.bookings.map(b => ({ id: b.record_id, datetime: b.datetime, staff: b.staff_yc_id, services: b.service_yc_ids, test: created.has(Number(b.record_id)) }));
}
async function command(c) {
  if (c.op === 'new') { scenario = String(c.name); key = `${runId}-${++serial}`; messages = []; journal = []; calls = []; watermark = 0; emit({ scenario, key }); return; }
  if (c.op === 'tool') {
    if (!/^(get_|list_|search_)/.test(c.name) || !base.handlers[c.name]) throw Error('READ_TOOL_REQUIRED');
    const result = await base.handlers[c.name](salonId, c.input || {}, { dialogKey: key, clientPhone: phone, clientName: owner.name, nowMs: Date.now(), patientLastText: c.patientText || '' });
    journal.push({ tool: c.name, input: c.input || {}, result, is_error: !!result?.error, at: Date.now(), delivered: true });
    if (c.name === 'list_services') { emit({ services: (result.services || []).filter(s => !c.ids || c.ids.includes(s.yc_id)).map(s => ({ id:s.yc_id,title:s.title,staff:s.staff?.map(m=>({id:m.yc_id,name:m.name})) })) }); return; }
    if (c.name === 'list_client_bookings') { emit({ records: await actualRecords() }); return; }
    emit({ tool: c.name, result }); return;
  }
  if (c.op === 'seed') { messages = c.messages; watermark = 0; emit({ seeded: messages.length }); return; }
  if (c.op === 'turn') {
    messages.push({ role: 'user', content: c.text }); const start = calls.length;
    emit({ event: 'turn_started', scenario });
    const out = await orchestrator.runDialog(salonId, key, { ctx: { phone, channel: 'whatsapp' }, deps: { history, state, provider, toolEvents: memoryEvents, registry: { schemas: base.schemas, handlers } } });
    for (const text of out.replies || []) messages.push({ role: 'assistant', content: text });
    const reply = (out.replies || []).join('\n');
    const summary = { scenario, user: c.text, reply, calls: calls.slice(start), replyCount: out.replies?.length, question: reply.includes('?'), times: [...new Set(reply.match(/\b\d{1,2}:\d{2}\b/g) || [])],
      needsPhone: /номер.*телефон|телефон.*номер/iu.test(reply), escalated: !!out.escalated, followupStopReason: out.followupStopReason,
      writeSucceeded: !!out.writeSucceeded, falseSuccess: !!out.falseSuccess, records: await actualRecords() };
    report.scenarios.push(summary); save(); emit(summary); return;
  }
  if (c.op === 'records') { const result = await actualRecords(); for (const id of created) { const r = await ycGetRecord(salon, id); if (String(r?.client?.id) !== String(owner.yclients_client_id)) throw Error('OWNER_MISMATCH'); } report.verifications.push({ at:new Date().toISOString(), records: result, owners_verified: true }); save(); emit({records:result,owners_verified:true,reportPath}); return; }
  if (c.op === 'cleanup') {
    if (!process.argv.includes('--allow-cleanup')) throw Error('CLEANUP_NOT_APPROVED');
    const mod = require('../services/agent/booking-modify');
    for (const id of created) { const r = await mod.cancelBookingRecord(salonId, { dialogKey: runId, recordId: id, expectedYcClientId: owner.yclients_client_id }); emit({cancelled:!!r.ok,id}); }
    report.cleanup = await actualRecords(); save(); return;
  }
  if (c.op === 'quit') { save(); emit({reportPath,created:[...created]}); process.exit(0); }
  throw Error('UNKNOWN_COMMAND');
}
(async()=>{
  salon = await db.one('SELECT * FROM salons WHERE id=$1',[salonId]);
  owner = await db.one("SELECT name,yclients_client_id FROM clients WHERE salon_id=$1 AND right(regexp_replace(phone,'[^0-9]','','g'),10)=$2",[salonId,phone.slice(-10)]);
  if (!salon || !owner?.yclients_client_id) throw Error('OWNER_NOT_FOUND');
  const baseline=await actualRecords(); report.baseline=baseline; save();
  if(baseline.length) throw Error('OWNER_ALREADY_HAS_BOOKINGS');
  key=runId; emit({ready:true,runId,baseline:baseline.length,reportPath});
  for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    try { await command(JSON.parse(line)); } catch(e) { emit({error:e.code||'COMMAND_FAILED',detail:/^[A-Z_]+$/.test(e.message)?e.message:undefined}); }
  }
  save();process.exit(0);
})().catch(e=>{emit({error:/^[A-Z_]+$/.test(e.message)?e.message:'SETUP_FAILED'});process.exit(1)});
