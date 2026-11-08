'use strict';
// Автоматика «Документов» (спека 2026-10-25 §7), крон раз в минуту. По умолчанию выключена.
//   Перед визитом — договор и согласие (данных не хватает → анкета в мессенджер);
//   акт — через N минут после оплаты визита; повтор — неподписанная ссылка / незаполненная анкета.
// Каждое действие сначала «застолбляется» строкой edoc_auto_jobs (UNIQUE): повторов не бывает,
// неудача остаётся в журнале с причиной и видна на карточке дашборда — дальше человек.
// В тихие часы салона (настройки автоуведомлений) ничего не столбится и не шлётся: действие
// подберёт первый прогон после их окончания. Отправки F.Doc идут от имени выбранного сотрудника.
const store = require('./store');
const boardStore = require('./board-store');
const auto = require('./automation-store');
const packages = require('./packages');
const forms = require('./forms');
const testPhones = require('./test-phones');
const { kindState, BAD, PRE_KINDS, addDays, mskDay } = require('./board');
const { missingFor, KIND_LABELS } = require('./placeholders');
const notifSettings = require('../notifications/settings');
const { applyQuietHours } = require('../notifications/events');
const config = require('../../config');
const { shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsAuto');
const VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
const ACT_LOOKBACK_DAYS = 3;
const WARN_EVERY_MS = 60 * 60 * 1000;
const warned = new Map();
function warnOnce(key, text) {
  const now = Date.now();
  if (warned.has(key) && now - warned.get(key) < WARN_EVERY_MS) return;
  warned.set(key, now);
  logger.warn(text);
}
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;
const kindNames = (kinds) => kinds.map((k) => (KIND_LABELS[k] || k).toLowerCase()).join(', ');

/** Готов ли F.Doc для автоматики салона: модуль включён и проверен, выбран сотрудник с рабочей учёткой. */
async function fdocReady(s) {
  if (!s.enabled || !s.corp_id) return { ok: false, reason: 'модуль «Документы» выключен или F.Doc не подключён' };
  if (!s.auto_sender_user_id) return { ok: false, reason: 'не выбран сотрудник для автоотправки' };
  const cred = await store.getCredentials(s.salon_id, s.auto_sender_user_id);
  if (!cred || cred.fail_count >= 3) return { ok: false, reason: 'у сотрудника для автоотправки нет рабочей учётки F.Doc' };
  return { ok: true, userId: s.auto_sender_user_id };
}

async function previsit(ctx) {
  const { s, salonId, tplByKind, nowMs } = ctx;
  const hours = Math.min(168, Math.max(2, Number(s.auto_previsit_hours) || 24));
  const list = await auto.previsitCandidates(salonId, new Date(nowMs).toISOString(), new Date(nowMs + hours * 3600000).toISOString(), s.auto_previsit_scope !== 'all');
  let n = 0;
  for (const r of list) {
    if (!testPhones.isAllowed(r.phone)) continue;   // тестовый режим: чужих пациентов не трогаем и не столбим
    const docs = await boardStore.listDocsForClients(salonId, [r.client_id]);
    const bad = PRE_KINDS.filter((k) => tplByKind[k] && BAD.has(kindState(docs, k, { nowMs }).state));
    if (!bad.length) continue;   // всё подписано или ждёт подписи
    const latest = (await boardStore.listLatestForms(salonId, [r.client_id]))[0];
    if (latest && latest.status === 'active' && Date.parse(latest.expires_at) > nowMs) continue;   // анкета уже у пациента
    const templates = bad.map((k) => tplByKind[k]);
    const miss = missingFor(await store.getIdentityRow(salonId, r.client_id), templates, ctx.requisites,
      { autoContractNo: packages.usesAutoContractNo(s, templates) });
    // Проблемы настройки салона, а не пациента, действие не столбят: после исправления оно случится.
    if (miss.org.length) { warnOnce(`org:${salonId}`, `edocs auto: салон ${salonId} — не заполнены реквизиты клиники, автоотправка ждёт`); continue; }
    if (!miss.identity.length && !ctx.fdoc.ok) { warnOnce(`previsit:${salonId}`, `edocs auto: салон ${salonId} — отправка перед визитом ждёт: ${ctx.fdoc.reason}`); continue; }
    if (miss.identity.length && s.auto_previsit_form && !config.EDOCS_PUBLIC_URL) {
      warnOnce(`url:${salonId}`, `edocs auto: салон ${salonId} — не задан EDOCS_PUBLIC_URL, анкеты не отправляются`);
      continue;
    }
    const job = await auto.claim(salonId, 'previsit', r.id, { clientId: r.client_id, recordId: r.id });
    if (!job) continue;
    n++;
    try {
      if (!miss.identity.length) {
        const res = await packages.send({ salonId, userId: ctx.fdoc.userId, clientId: r.client_id, templateIds: templates.map((t) => t.id), source: 'auto' });
        await auto.finish(job, 'done', `отправлено: ${kindNames(bad)}`, { packageId: res.packageId });
      } else if (s.auto_previsit_form) {
        const f = await forms.createForm({ salonId, clientId: r.client_id, recordId: r.id, kinds: bad, sendDocs: ctx.fdoc.ok, deliver: 'messenger',
          source: 'auto', senderUserId: s.auto_sender_user_id || null });
        if (f.delivery && f.delivery.ok) await auto.finish(job, 'done', `анкета отправлена в ${VIA[f.delivery.channel] || f.delivery.channel}`, { formId: f.formId });
        else await auto.finish(job, 'failed', `анкета не доставлена: ${(f.delivery && f.delivery.error) || 'нет ответа'}`, { formId: f.formId });
      } else {
        await auto.finish(job, 'skipped', `нет данных пациента: ${miss.identity.map((x) => x.label.toLowerCase()).join(', ')}`);
      }
    } catch (e) {
      await auto.finish(job, 'failed', shortError(e));
    }
  }
  return n;
}

async function acts(ctx) {
  const { s, salonId, tplByKind, nowMs } = ctx;
  if (!tplByKind.act) return 0;
  if (!ctx.fdoc.ok) { warnOnce(`act:${salonId}`, `edocs auto: салон ${salonId} — автоакт ждёт: ${ctx.fdoc.reason}`); return 0; }
  const floor = addDays(mskDay(nowMs), -ACT_LOOKBACK_DAYS);
  const from = s.acts_required_from && String(s.acts_required_from) > floor ? String(s.acts_required_from) : floor;
  const delay = Math.min(240, Math.max(5, Number(s.auto_act_delay_min) || 15));
  let n = 0;
  for (const r of await auto.actCandidates(salonId, from, delay)) {
    if (!testPhones.isAllowed(r.phone)) continue;
    const job = await auto.claim(salonId, 'act', r.id, { clientId: r.client_id, recordId: r.id });
    if (!job) continue;
    n++;
    try {
      const res = await packages.send({ salonId, userId: ctx.fdoc.userId, clientId: r.client_id, templateIds: [tplByKind.act.id], recordId: r.id, source: 'auto' });
      await auto.finish(job, 'done', 'акт отправлен', { packageId: res.packageId });
    } catch (e) {
      await auto.finish(job, 'failed', shortError(e));
    }
  }
  return n;
}

const CRED_CODES = new Set(['fdoc_no_credentials', 'fdoc_credentials_invalid']);
async function reminders(ctx) {
  const { s, salonId } = ctx;
  const hours = Math.min(48, Math.max(1, Number(s.auto_remind_hours) || 2));
  let n = 0;
  if (ctx.fdoc.ok) {
    for (const p of await auto.remindPackages(salonId, hours)) {
      const phone = (p.payload && p.payload.patient && p.payload.patient.phone) || p.client_phone;
      if (!testPhones.isAllowed(phone)) continue;
      const job = await auto.claim(salonId, 'remind', p.id, { clientId: p.client_id, packageId: p.id });
      if (!job) continue;
      n++;
      try {
        // Комплект в F.Doc может быть виден только отправителю — сначала его учёткой, нет её — учёткой автоматики.
        try { await packages.permalink({ salonId, userId: p.sent_by || ctx.fdoc.userId, packageId: p.id }); } catch (e) {
          if (!e || !CRED_CODES.has(e.code) || !p.sent_by || p.sent_by === ctx.fdoc.userId) throw e;
          await packages.permalink({ salonId, userId: ctx.fdoc.userId, packageId: p.id });
        }
        await auto.finish(job, 'done', 'ссылка на подпись отправлена повторно');
      } catch (e) {
        await auto.finish(job, 'failed', shortError(e));
      }
    }
  }
  if (config.EDOCS_PUBLIC_URL) {
    for (const f of await auto.remindForms(salonId, hours)) {
      if (!testPhones.isAllowed(f.phone)) continue;
      const job = await auto.claim(salonId, 'remind_form', f.id, { clientId: f.client_id, formId: f.id });
      if (!job) continue;
      n++;
      try {
        const r = await forms.resendForm({ salonId, formId: f.id });
        if (r.ok) await auto.finish(job, 'done', `анкета отправлена повторно в ${VIA[r.channel] || r.channel}`);
        else await auto.finish(job, 'failed', `анкета не доставлена: ${r.error}`);
      } catch (e) {
        await auto.finish(job, 'failed', shortError(e));
      }
    }
  }
  return n;
}

async function runSalon(s, nowMs) {
  const salonId = s.salon_id;
  const cfg = await notifSettings.getSettings(salonId);
  if (applyQuietHours(nowMs, cfg) > nowMs) return { quiet: true };
  const tpls = (await store.listTemplates(salonId, { activeOnly: true })).sort(bySort);
  const tplByKind = {};
  for (const t of tpls) if (!tplByKind[t.kind]) tplByKind[t.kind] = t;
  const ctx = { s, salonId, tplByKind, nowMs, requisites: s.requisites || {}, fdoc: await fdocReady(s) };
  const out = { previsit: 0, act: 0, remind: 0 };
  if (s.auto_previsit) out.previsit = await previsit(ctx);
  if (s.auto_act) out.act = await acts(ctx);
  if (s.auto_remind) out.remind = await reminders(ctx);
  return out;
}

let running = false;
/** Один прогон на процесс; салоны по очереди, сбой салона не останавливает остальных. */
async function runOnce({ nowMs = Date.now() } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { expired: 0, previsit: 0, act: 0, remind: 0, errors: 0 };
  try {
    try { out.expired = await forms.expireForms(); } catch (e) { warnOnce('expire', `edocs auto: анкеты не переведены в expired: ${shortError(e)}`); }
    for (const s of await auto.listAutomationSalons()) {
      try {
        const r = await runSalon(s, nowMs);
        for (const k of ['previsit', 'act', 'remind']) out[k] += r[k] || 0;
      } catch (e) {
        out.errors++;
        warnOnce(`salon:${s.salon_id}`, `edocs auto: салон ${s.salon_id}: ${shortError(e)}`);
      }
    }
    return out;
  } finally { running = false; }
}

function _reset() { warned.clear(); running = false; }

module.exports = { runOnce, runSalon, fdocReady, _reset };
