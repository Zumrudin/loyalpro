#!/usr/bin/env node
'use strict';
// Живая проверка разовой рассылки через мессенджеры на дев-БД: создаёт рассылку по списку номеров через
// service.createBroadcast (с картинкой и каскадом из всех трёх мессенджеров), гоняет настоящий
// worker.processBroadcast с УСКОРЕННЫМ временем (пауза истекает за итерацию), печатает монитор и получателей.
//
//   node scripts/broadcast-messengers-e2e.js [--phones 79200255591,...] [--salon 1] [--send] [--keep]
//                                            [--allow-worker-running]
//
// По умолчанию НИЧЕГО НЕ ОТПРАВЛЯЕТ: sender.sendToRecipient подменён стабом (присвоением свойства модуля —
// worker.js зовёт его как `sender.sendToRecipient`). Стаб: первому вызову — отказ `rejected`, если в каскаде
// получателя больше одного шага (проверка перехода по каскаду), остальным — успех. --send — реальная отправка,
// но только на номера из --phones (по умолчанию тестовый 79200255591).
//
// ОПАСНОСТЬ, поэтому скрипт отказывается работать при online-процессе pm2 `loyalpro`: он крутит код из
// /root/loyalpro, где воркер бота без фильтра transport арендовал бы рассылку скрипта, а после выката нового
// кода его воркер рассылок пошёл бы с НАСТОЯЩИМ sender. Обход — --allow-worker-running (осознанно).
//
// checkDeliveries не вызывается: delivery_id стаба фиктивный. В конце рассылка удаляется (каскадом уходят
// получатели), копия картинки тоже; --keep оставляет рассылку (для explain).

// Планировщик считает окно 09–21 по локальным часам процесса; хост дева в UTC, боевой процесс — Europe/Moscow.
process.env.TZ = 'Europe/Moscow';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, pool } = require('../db');
const sender = require('../services/broadcast-messengers/sender');
const worker = require('../services/broadcast-messengers/worker');
const service = require('../services/broadcast-messengers/service');
const scheduler = require('../services/broadcast-messengers/scheduler');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const PHONES = val('--phones', '79200255591').split(',').map(s => s.trim()).filter(Boolean);
const SALON_ID = Number(val('--salon', 1));
const REAL_SEND = flag('--send');
const KEEP = flag('--keep');
const MAX_ITER = 20;
const E2E_DELAY_SEC = 5;

function pm2Online(name) {
  let out;
  try { out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }); } catch (e) {
    console.warn(`⚠️  не удалось спросить pm2 (${e.message}) — проверка боевого воркера ПРОПУЩЕНА`);
    return false;
  }
  try {
    const p = JSON.parse(out).find(x => x && x.name === name);
    return !!(p && p.pm2_env && p.pm2_env.status === 'online');
  } catch (e) {
    console.warn(`⚠️  pm2 jlist вернул не-JSON (${e.message}) — проверка ПРОПУЩЕНА`);
    return false;
  }
}

function guardAgainstLiveWorker() {
  if (flag('--allow-worker-running')) { console.warn('⚠️  --allow-worker-running: проверка pm2 ОБОЙДЕНА осознанно.'); return; }
  if (!pm2Online('loyalpro')) return;
  console.error([
    '', 'ОТКАЗ: pm2-процесс «loyalpro» сейчас ONLINE.',
    'Он крутит код из /root/loyalpro: воркер бота без фильтра transport арендовал бы рассылку скрипта, а после',
    'выката нового кода его воркер рассылок отправил бы её НАСТОЯЩИМ sender-ом.', '',
    '  1) export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH; pm2 stop loyalpro',
    '  2) node scripts/broadcast-messengers-e2e.js',
    '  3) cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro', '  4) pm2 status', '',
  ].join('\n'));
  process.exit(1);
}

/** Первый подходящий файл-картинка: сначала в этом worktree, потом в основной копии (notify_seed не в git). */
function pickSeedImage() {
  const dirs = [path.join(__dirname, '../../frontend/uploads/notify_seed'), '/root/loyalpro/frontend/uploads/notify_seed'];
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d).sort(); } catch (_) { continue; }
    const f = names.find(n => /\.(jpe?g|png|webp)$/i.test(n));
    if (f) return path.join(d, f);
  }
  return null;
}

/** Начало ускоренного времени: сейчас, если в окне 09–21 мск, иначе ближайшие 09:05. Всегда ≥ реального now. */
function startNowMs() {
  const now = Date.now();
  if (scheduler.inSendWindow(now)) return now;
  let t = Math.ceil(now / 60000) * 60000;
  while (!scheduler.inSendWindow(t)) t += 60000;
  return t + 5 * 60000; // 09:00 + 5 мин
}

(async () => {
  guardAgainstLiveWorker();
  const t0 = Date.now();
  const ownerRow = await db.oneOrNone(`SELECT id FROM users WHERE salon_id = $1 AND role = 'owner' ORDER BY id LIMIT 1`, [SALON_ID]);
  const userId = ownerRow ? ownerRow.id : null;
  console.log(`салон #${SALON_ID}, автор #${userId}, номера ${PHONES.join(', ')}, ${REAL_SEND ? 'РЕАЛЬНАЯ ОТПРАВКА' : 'стаб отправки'}`);

  let imageCopy = null;
  let imageUrl = null;
  const seed = pickSeedImage();
  if (seed) {
    const ext = path.extname(seed).toLowerCase();
    const name = `broadcast_${SALON_ID}_${Date.now()}${ext}`;
    imageCopy = path.join(__dirname, '../../frontend/uploads', name);
    fs.copyFileSync(seed, imageCopy);
    imageUrl = `/uploads/${name}`;
    console.log(`картинка: ${path.basename(seed)} → ${imageUrl}`);
  } else {
    console.warn('⚠️  в frontend/uploads/notify_seed нет картинок — рассылка без картинки');
  }

  let broadcastId = null;
  let failed = false;
  try {
    const parsed = service.parseCreateBody({
      transport: 'messengers', audienceSource: 'list', list: PHONES.map(p => ({ name: 'E2E', phone: p })),
      messageTemplate: '{first_name}, это проверочная рассылка (e2e), отвечать не нужно.',
      imageUrl,
      channelSettings: Object.fromEntries(scheduler.CHANNELS.map(ch => [ch, { enabled: true, delay_sec: E2E_DELAY_SEC, limit: null }])),
      onLimit: 'next_channel', cascadeEnabled: true,
    });
    if (!parsed.ok) throw new Error(`parseCreateBody: ${parsed.error}`);

    // Прогноз той же формы — заодно проверяет, что кэш базы и каскад отрабатывают.
    const fc = await service.forecastBroadcast(SALON_ID, parsed.value);
    console.log(`прогноз: получателей ${fc.total}, пропущено ${fc.skipped}`, JSON.stringify(fc.skippedBy));

    let b;
    try {
      b = await service.createBroadcast(SALON_ID, userId, parsed.value);
    } catch (e) {
      if (e.status) throw new Error(`createBroadcast: ${e.message} (на деве у салона #${SALON_ID} должен быть подключён аккаунт мессенджера)`);
      throw e;
    }
    broadcastId = b.id;
    const recs = await db.any('SELECT id, phone, cascade FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id', [b.id]);
    console.log(`рассылка #${b.id}: получателей ${recs.length}; каскады:`, recs.map(r => `${r.phone}=[${r.cascade.join('>')}]`).join(' '));

    const foreign = recs.filter(r => !PHONES.includes(r.phone));
    if (REAL_SEND && foreign.length) throw new Error(`--send: в списке номера вне --phones: ${foreign.map(r => r.phone).join(', ')}`);

    if (!REAL_SEND) {
      const cascadeLen = new Map(recs.map(r => [r.phone, r.cascade.length]));
      let calls = 0;
      sender.sendToRecipient = async ({ phone, channel }) => {
        calls++;
        console.log(`  стаб #${calls}: ${phone} через ${channel}`);
        if (calls === 1 && (cascadeLen.get(phone) || 0) > 1) return { ok: false, kind: 'rejected', error: 'e2e' };
        return { ok: true, delivery_id: 'e2e', account_id: null };
      };
    }

    // Ускоренное время: sent_at пишет БД (NOW()), поэтому фиктивное время обязано быть ≥ реального, иначе
    // пауза «не истекла». Шаг — самая длинная пауза + 1 с.
    let nowMs = startNowMs();
    const stepMs = (E2E_DELAY_SEC + 1) * 1000;
    console.log(`время старта: ${new Date(nowMs).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} мск (шаг ${stepMs / 1000} с)`);
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const cur = await db.oneOrNone('SELECT * FROM broadcasts WHERE id = $1', [b.id]);
      if (!cur || !['pending', 'in_progress'].includes(cur.status)) break;
      await worker.processBroadcast(cur, Math.max(nowMs, Date.now()));
      const open = await db.any(`SELECT status, count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 GROUP BY 1`, [b.id]);
      console.log(`  итерация ${iter + 1}:`, open.map(r => `${r.status}=${r.n}`).join(' '));
      nowMs += stepMs;
    }
    const mon = await service.monitor(SALON_ID, b.id, Math.max(nowMs, Date.now()));
    console.log('\n=== МОНИТОР ===');
    console.log(JSON.stringify(mon, null, 2));
    const list = await service.recipients(SALON_ID, b.id, {});
    console.log('\n=== ПОЛУЧАТЕЛИ ===');
    for (const r of list.items) {
      console.log(`${r.phone} status=${r.status} channel=${r.channel} reason=${r.reason || '-'} error=${r.error || '-'} delivery=${r.delivery_status || '-'}`);
      console.log('  cascade_log:', JSON.stringify(r.cascade_log));
    }

    if (mon.status !== 'completed') throw new Error(`рассылка не завершилась за ${iter} итераций (status=${mon.status})`);
    const bad = list.items.filter(r => r.status !== 'sent');
    if (bad.length) throw new Error(`не все получатели sent: ${bad.map(r => `${r.phone}:${r.status}`).join(', ')}`);
    if (!REAL_SEND && recs.some(r => r.cascade.length > 1)) {
      const hop = list.items.some(r => (r.cascade_log || []).some(e => e.to));
      if (!hop) throw new Error('переход по каскаду после rejected не зафиксирован в cascade_log');
    }
    console.log(`\nOK за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  } catch (e) {
    failed = true;
    console.error('ОШИБКА:', e.stack || e.message);
  } finally {
    if (broadcastId != null) {
      if (KEEP) console.log(`--keep: рассылка #${broadcastId} оставлена (удалить: DELETE FROM broadcasts WHERE id=${broadcastId})`);
      else await db.query('DELETE FROM broadcasts WHERE id = $1', [broadcastId]).catch(e => console.error('не удалось удалить рассылку:', e.message));
    }
    if (imageCopy) { try { fs.unlinkSync(imageCopy); } catch (_) {} }
    await pool.end().catch(() => {});
  }
  process.exit(failed ? 1 : 0);
})();
