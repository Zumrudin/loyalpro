'use strict';
// Разовый догон «Отдела заботы»: состоявшиеся визиты последних N дней → прохождения программ заботы,
// как если бы программы работали всё это время, но БЕЗ касаний задним числом.
//
//   cd backend && TZ=Europe/Moscow node scripts/care-backfill.js [--salon=1] [--days=30] [--program=5,6]
//                                                               [--write] [--out=журнал.json]
//
// По умолчанию СУХОЙ ПРОГОН: читает записи YClients и БД, ничего не пишет и никому не отправляет.
// --write заводит care_enrollments и строки care_touch_sends. Отправляет не скрипт, а воркер «Заботы»
// в назначенное время — со всеми своими проверками (гейт Милы, диалог на операторе, анти-спам,
// повторный визит, решение модели «слать ли»).
//
// ЗАЧЕМ: зачисление в «Заботу» чисто событийное (вебхук в момент, когда визит стал состоявшимся), и
// программа, созданная или включённая сегодня, прошлые визиты не подхватывает.
//
// Отбор — те же функции, что у вебхука (services/care/enroll.js): classifyRecordEvent (удалённые,
// отменённые и неявки отсекаются ПЕРВЫМИ — у предоплаченной неявки paid_full=1 стоит вместе с
// attendance=-1), evaluateRule с той же картой «услуга → категория», normalizePhoneKey, чёрный список,
// computeScheduledAt. Отличия от вебхука — все в сторону «не писать лишнего»:
//   - касание, чей расчётный срок уже прошёл, в очередь НЕ ставится. Визит, у которого прошли все
//     касания программы, пропускается целиком. У цепочки из нескольких касаний прошедшие пишутся сразу
//     'skipped': иначе самолечение вебхука (повторная доставка той же записи дописывает недостающие
//     касания) поставило бы их 'scheduled' задним числом, и воркер отправил бы их немедленно;
//   - из нескольких подходящих визитов клиента в одной программе берётся самый поздний (в бою он же
//     перекрыл бы прежние цепочки — superseded), активная цепочка от более позднего ИЛИ того же по
//     времени визита — пропуск (иначе два касания одному человеку);
//   - визит, чьё время ещё не наступило (предоплата сегодняшнего вечера), пропускается — его зачислит
//     вебхук, когда визит состоится.
//
// Повтор безопасен: UNIQUE (program_id, yclients_record_id) — уже зачисленная запись не трогается.
// Откат записанного: DELETE FROM care_enrollments WHERE id = ANY(<enrollmentIds из журнала>) —
// касания уходят каскадом.
const fs = require('fs');
const { db, withTransaction } = require('../db');
const { ycGet } = require('../services/yclients');
const { withRateLimitRetry } = require('../services/yclients-retry');
const { evaluateRule, getServiceCategoryMap } = require('../services/notifications');
const { normalizePhoneKey } = require('../services/agent-gate');
const { classifyRecordEvent } = require('../services/care/enroll');
const { parseVisitAt, computeScheduledAt } = require('../services/care/schedule');

const PAGE = 200;
const MAX_PAGES = 50;                  // 10 000 записей — с запасом на 90 дней PERI (~450 в месяц)
const PAGE_PAUSE_MS = 300;
const RECORDS_RETRY = { retries: 2, delayMs: 60_000 };   // лимит YClients минутный
const MAX_DAYS = 90;
const PAST_REASON = 'догон: срок касания прошёл';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
const fmt = (d) => (d ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(d) : '—');
const maskPhone = (p) => (p ? `+${p.slice(0, 1)}•••${p.slice(-4)}` : '—');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Записи салона за [startDate, endDate] (московские даты визита), без дублей по id. */
async function fetchRecords(salon, startDate, endDate) {
  const byId = new Map();
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await withRateLimitRetry(
      () => ycGet(salon, `/records/${salon.yclients_company_id}`, { start_date: startDate, end_date: endDate, page, count: PAGE }),
      RECORDS_RETRY);
    if (!Array.isArray(chunk) || !chunk.length) break;
    // Записи создаются, пока идём по страницам: сдвиг выдачи может отдать одну запись дважды.
    for (const r of chunk) if (r && r.id != null) byId.set(String(r.id), r);
    if (chunk.length < PAGE) break;
    if (page === MAX_PAGES) truncated = true;
    await sleep(PAGE_PAUSE_MS);
  }
  return { records: [...byId.values()], truncated };
}

/** Тот же контекст правила, что в care/enroll.js. */
function recordCtx(r, catMap) {
  const serviceIds = (Array.isArray(r.services) ? r.services : []).map(s => s && s.id).filter(v => v != null);
  return {
    staffId: r.staff && r.staff.id != null ? r.staff.id : null,
    serviceIds,
    categoryIds: [...new Set(serviceIds.map(id => catMap.get(String(id))).filter(Boolean))],
  };
}

(async () => {
  const salonId = Number(args.salon || 1);
  const salon = Number.isInteger(salonId) ? await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [salonId]) : null;
  if (!salon) throw new Error(`салон не найден (--salon=${args.salon})`);
  if (!salon.yclients_company_id) throw new Error('у салона не настроен YClients');
  const rawDays = args.days === undefined ? 30 : Number(args.days);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > MAX_DAYS) throw new Error(`--days — целое 1…${MAX_DAYS} (получено ${args.days})`);
  const write = args.write === true;
  const onlyPrograms = args.program ? new Set(String(args.program).split(',').map(Number)) : null;

  let programs = await db.any(
    `SELECT p.id, p.title, p.conditions,
            COALESCE(json_agg(json_build_object(
              'id', t.id, 'title', t.title, 'delay_days', t.delay_days, 'send_time', t.send_time
            ) ORDER BY t.sort_order, t.id) FILTER (WHERE t.id IS NOT NULL), '[]') AS touches
       FROM care_programs p
       LEFT JOIN care_touches t ON t.program_id = p.id
      WHERE p.salon_id = $1 AND p.is_enabled = TRUE
      GROUP BY p.id
      ORDER BY p.id`, [salon.id]);
  if (onlyPrograms) {
    const missing = [...onlyPrograms].filter(id => !programs.some(p => p.id === id));
    // Выключенная программа вебхуком не наполняется — догоняем ровно то, что зачислил бы бой.
    if (missing.length) throw new Error(`программы ${missing.join(',')} не найдены среди ВКЛЮЧЁННЫХ программ салона`);
    programs = programs.filter(p => onlyPrograms.has(p.id));
  }
  if (!programs.length) { console.log('включённых программ заботы нет — догонять нечего'); return; }

  const now = new Date();
  const startDate = ymd(new Date(now.getTime() - rawDays * 86400000));
  const endDate = ymd(now);

  // Карта «услуга → категория» — тот же кэшируемый источник, что у вебхука. Пустая карта молча не
  // матчит условия ПО КАТЕГОРИИ, поэтому при таких условиях пустая карта — стоп, а не «никто не подошёл».
  const catMap = await getServiceCategoryMap(salon);
  const catIds = new Set();
  for (const p of programs) {
    for (const it of ((p.conditions && p.conditions.items) || [])) {
      if (it && it.type === 'category') for (const id of (it.ids || [])) catIds.add(String(id));
    }
  }
  if (catIds.size && !catMap.size) throw new Error('карта «услуга → категория» пуста (YClients не ответил) — условия по категории не сматчатся; повторите позже');
  for (const cat of catIds) {
    const n = [...catMap.values()].filter(v => String(v) === cat).length;
    console.log(`категория ${cat}: услуг в карте ${n}${n ? '' : ' — ВНИМАНИЕ: условие по этой категории не сработает ни в догоне, ни у вебхука'}`);
  }

  const { records, truncated } = await fetchRecords(salon, startDate, endDate);
  if (truncated) throw new Error(`выдача /records обрезана потолком ${MAX_PAGES * PAGE} — уменьшите --days`);

  // Клиент: точное совпадение по yclients_client_id главнее телефона (как в enroll.js). Телефон в clients
  // лежит как пришёл из YClients ('+7…'), поэтому сравниваем каноничные ключи с обеих сторон. В ЧС — если
  // в ЧС карточка по id ИЛИ любая карточка с этим номером (безопасная сторона).
  const clientRows = await db.any(
    'SELECT id, name, phone, yclients_client_id, is_blacklisted FROM clients WHERE salon_id = $1', [salon.id]);
  const byYcId = new Map();
  const byPhone = new Map();
  const blacklistedPhones = new Set();
  for (const c of clientRows) {
    if (c.yclients_client_id != null) byYcId.set(String(c.yclients_client_id), c);
    const k = normalizePhoneKey(c.phone);
    if (!k) continue;
    if (!byPhone.has(k)) byPhone.set(k, c);
    if (c.is_blacklisted) blacklistedPhones.add(k);
  }

  const existing = await db.any(
    `SELECT id, program_id, yclients_record_id, phone, visit_at, status
       FROM care_enrollments WHERE salon_id = $1`, [salon.id]);

  const nowMs = now.getTime();
  const report = [];
  const journal = {
    at: now.toISOString(), salonId: salon.id, period: [startDate, endDate], mode: write ? 'write' : 'dry-run',
    records: records.length, programs: [],
  };
  console.log(`${write ? 'WRITE' : 'DRY-RUN'}: салон ${salon.id}, визиты ${startDate}…${endDate}, записей YClients ${records.length}, сейчас ${fmt(now)} мск`);

  for (const p of programs) {
    const touches = Array.isArray(p.touches) ? p.touches : JSON.parse(p.touches || '[]');
    const stat = {
      matched: 0, no_phone: 0, blacklist: 0, no_date: 0, not_yet: 0, superseded: 0,
      past: 0, already_enrolled: 0, later_active: 0, enroll: 0, written: 0,
    };
    const rows = [];
    const candidates = [];

    for (const r of records) {
      if (classifyRecordEvent(r, null) !== 'enroll') continue;
      let ok = false;
      try { ok = evaluateRule(p.conditions, recordCtx(r, catMap)); } catch { ok = false; }
      if (!ok) continue;
      stat.matched++;

      const phone = normalizePhoneKey(r.client && r.client.phone);
      const visitAt = parseVisitAt(r.date);
      const ycClientId = r.client && r.client.id != null ? String(r.client.id) : null;
      const client = (ycClientId && byYcId.get(ycClientId)) || (phone && byPhone.get(phone)) || null;
      const row = {
        recordId: r.id, phone, visitAt, client,
        name: (client && client.name) || (r.client && r.client.name) || '',
        staffYcId: (r.staff && r.staff.id) || null,
        staffName: (r.staff && r.staff.name) || null,
        services: (Array.isArray(r.services) ? r.services : [])
          .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title),
        decision: null, touchAt: null,
      };
      rows.push(row);
      if (!phone) { row.decision = 'no_phone'; continue; }
      if ((client && client.is_blacklisted) || blacklistedPhones.has(phone)) { row.decision = 'blacklist'; continue; }
      if (!visitAt) { row.decision = 'no_date'; continue; }
      if (visitAt.getTime() > nowMs) { row.decision = 'not_yet'; continue; }
      candidates.push(row);
    }

    // Самый поздний подходящий визит клиента — якорь, прежние перекрыты им же (как в бою).
    candidates.sort((a, b) => b.visitAt - a.visitAt || Number(b.recordId) - Number(a.recordId));
    const seen = new Set();
    for (const row of candidates) {
      if (seen.has(row.phone)) { row.decision = 'superseded'; continue; }
      seen.add(row.phone);
      row.schedule = touches.map(t => ({ touch: t, at: computeScheduledAt(row.visitAt, t.delay_days, t.send_time) }))
        .filter(s => s.at);
      const future = row.schedule.filter(s => s.at.getTime() > nowMs);
      row.touchAt = (future[0] || row.schedule[row.schedule.length - 1] || {}).at || null;
      if (!future.length) { row.decision = 'past'; continue; }
      if (existing.some(e => e.program_id === p.id && String(e.yclients_record_id) === String(row.recordId))) {
        row.decision = 'already_enrolled'; continue;
      }
      if (existing.some(e => e.program_id === p.id && e.phone === row.phone && e.status === 'active'
                          && e.visit_at && new Date(e.visit_at) >= row.visitAt)) {
        row.decision = 'later_active'; continue;
      }
      row.decision = 'enroll';
    }
    for (const row of rows) stat[row.decision]++;

    if (write) {
      for (const row of rows.filter(x => x.decision === 'enroll')) {
        // Одна транзакция на прохождение: вебхук той же записи, пришедший посреди, упрётся в UNIQUE и
        // увидит прохождение уже со всеми касаниями (самолечению дописывать нечего).
        const res = await withTransaction(async (c) => {
          await c.query("SET LOCAL lock_timeout = '5s'");
          const dup = await c.query(
            'SELECT id FROM care_enrollments WHERE program_id = $1 AND yclients_record_id = $2', [p.id, row.recordId]);
          if (dup.rows.length) return { decision: 'already_enrolled' };
          const later = await c.query(
            `SELECT id FROM care_enrollments
              WHERE salon_id = $1 AND program_id = $2 AND phone = $3 AND status = 'active' AND visit_at >= $4
              LIMIT 1`, [salon.id, p.id, row.phone, row.visitAt]);
          if (later.rows.length) return { decision: 'later_active' };
          const ins = await c.query(
            `INSERT INTO care_enrollments
               (salon_id, program_id, client_id, phone, yclients_record_id, visit_at, staff_yc_id, staff_name, services)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
             ON CONFLICT (program_id, yclients_record_id) DO NOTHING
             RETURNING id`,
            [salon.id, p.id, row.client ? row.client.id : null, row.phone, row.recordId, row.visitAt,
             row.staffYcId, row.staffName, JSON.stringify(row.services)]);
          if (!ins.rows.length) return { decision: 'already_enrolled' };
          const enrollmentId = ins.rows[0].id;
          // Прежние активные цепочки клиента от БОЛЕЕ РАННИХ визитов перекрываются — как в enroll.js.
          const old = await c.query(
            `UPDATE care_enrollments
                SET status = 'superseded', status_reason = 'новый визит перезапустил программу', updated_at = NOW()
              WHERE salon_id = $1 AND program_id = $2 AND phone = $3 AND status = 'active' AND id <> $4
                AND (visit_at IS NULL OR visit_at < $5)
              RETURNING id`, [salon.id, p.id, row.phone, enrollmentId, row.visitAt]);
          if (old.rows.length) {
            await c.query(
              `UPDATE care_touch_sends SET status = 'cancelled', decision_reason = 'enrollment superseded'
                WHERE enrollment_id = ANY($1::bigint[]) AND status = 'scheduled'`, [old.rows.map(o => o.id)]);
          }
          let scheduled = 0;
          for (const s of row.schedule) {
            // Срок перепроверяется в момент записи: прогон мог перевалить за время касания.
            const due = s.at.getTime() > Date.now();
            await c.query(
              `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at, status, decision_reason)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (enrollment_id, touch_id) DO NOTHING`,
              [salon.id, enrollmentId, s.touch.id, s.at, due ? 'scheduled' : 'skipped', due ? null : PAST_REASON]);
            if (due) scheduled++;
          }
          if (!scheduled) throw Object.assign(new Error('срок прошёл во время прогона'), { code: 'PAST_DURING_RUN' });
          return { decision: 'written', enrollmentId: String(enrollmentId), superseded: old.rows.map(o => String(o.id)) };
        }).catch((e) => {
          if (e.code === 'PAST_DURING_RUN') return { decision: 'past' };
          throw e;
        });
        stat.enroll--;
        stat[res.decision]++;
        row.decision = res.decision;
        row.enrollmentId = res.enrollmentId || null;
        row.supersededIds = res.superseded || [];
      }
    }

    const touchList = touches.map(t => `+${t.delay_days} дн. ${t.send_time}`).join(', ') || 'касаний нет';
    console.log(`\nпрограмма #${p.id} «${p.title}» (${touchList})`);
    console.log(`  ${Object.entries(stat).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'подходящих визитов нет'}`);
    rows.sort((a, b) => (b.visitAt || 0) - (a.visitAt || 0));
    for (const row of rows) {
      console.log(`  ${String(row.decision).padEnd(16)} визит ${fmt(row.visitAt)}  касание ${fmt(row.touchAt)}  rec=${row.recordId}  ${maskPhone(row.phone)}  ${row.name}  ${row.services.map(s => s.title).join('; ')}${row.enrollmentId ? `  → enrollment #${row.enrollmentId}` : ''}`);
    }
    journal.programs.push({
      id: p.id, title: p.title, stat,
      rows: rows.map(row => ({
        recordId: row.recordId, decision: row.decision, visitAt: row.visitAt, touchAt: row.touchAt,
        phone: row.phone, clientId: row.client ? row.client.id : null, enrollmentId: row.enrollmentId || null,
        supersededIds: row.supersededIds || [],
      })),
    });
    report.push(...rows);
  }

  const written = report.filter(r => r.decision === 'written');
  const toEnroll = report.filter(r => r.decision === 'enroll');
  console.log(`\nИТОГО: ${write ? `поставлено в расписание ${written.length}` : `будет поставлено ${toEnroll.length}`}, `
    + `пропущено (срок прошёл) ${report.filter(r => r.decision === 'past').length}`);
  if (write) journal.enrollmentIds = written.map(r => r.enrollmentId);
  if (args.out) {
    fs.writeFileSync(String(args.out), JSON.stringify(journal, null, 2), { mode: 0o600 });
    console.log(`журнал: ${args.out}`);
  }
})()
  .catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exitCode = 1; })
  .finally(() => require('../db').pool.end().catch(() => {}));
