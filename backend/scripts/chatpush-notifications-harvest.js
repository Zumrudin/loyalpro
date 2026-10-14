'use strict';
// Выгрузка того, что Chatpush/YClients реально шлют пациентам: уникальные тексты
// служебных исходящих (authored_by='system') и картинки «Рекомендации после
// процедуры» по их подписанным URL (Яндекс S3). Ссылки протухают — срок записан в
// самой ссылке (X-Amz-Date + X-Amz-Expires), у Chatpush он то 7 суток, то 2, —
// поэтому скрипт запускается ПЕРВЫМ. Ничего не пишет в БД, ничего не отправляет.
//
// Запуск: cd backend && node scripts/chatpush-notifications-harvest.js [--salon=1] [--days=45] [--min=3]
//   --days — окно выборки (и для текстов, и для картинок);
//   --min  — сколько раз текст должен встретиться, чтобы попасть в выгрузку. Редкие
//            автоответы (например, на низкую оценку) встречаются 1–2 раза за месяцы,
//            для них порог нужно снижать (--min=2).
//
// ВНИМАНИЕ, ПДн: authored_by='system' — это не только уведомления YClients/Chatpush,
// но и НАШИ исходящие: касания «Заботы» с именами пациентов, реплики Милы, рассылки.
// Они попадают в md-файл. Перед коммитом вычистить из него всё, кроме служебных
// уведомлений: имён пациентов в репозитории быть не должно.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, pool } = require('../db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const salonId = Number(args.salon || 1);
const days = Number(args.days || 45);
const minCount = Number(args.min || 3);
const outDir = path.join(__dirname, '../../frontend/uploads/notify_seed');
const docPath = path.join(__dirname, '../../docs/notifications/chatpush-templates-2026-10-13.md');

function slug(s) { return String(s).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80); }

// Момент (мс), до которого действует подписанная ссылка; 0 — подпись не разобрана.
function signedUntilMs(url) {
  const d = /X-Amz-Date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url);
  const e = /X-Amz-Expires=(\d+)/.exec(url);
  if (!d || !e) return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]) + Number(e[1]) * 1000;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(docPath), { recursive: true });

  const templates = await db.any(
    `SELECT regexp_replace(text, '\\d+', '#', 'g') AS tpl, min(text) AS sample,
            count(*) AS n, array_agg(DISTINCT channel) AS channels,
            to_char(to_timestamp(max(msg_ts)) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS last_at
       FROM chatpush_messages
      WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
        AND msg_ts > extract(epoch from now() - make_interval(days => $2))
      GROUP BY 1 HAVING count(*) >= $3 ORDER BY n DESC`,
    [salonId, days, minCount]);

  // Все «Рекомендации» с файлом за окно; группируем по имени файла уже здесь, а не в SQL:
  // для каждого файла берём ссылку с самым поздним сроком жизни, а не просто самую
  // свежую рассылку — двухсуточная ссылка свежей перекрыла бы ещё живую семисуточную
  // более ранней. «…_media.jpg» — это не файл шаблона, а выгрузка WhatsApp-отправки
  // (имя = момент отправки), по имени услуги её не опознать.
  const rows = await db.any(
    `SELECT substring(file_url from 'delivery_files_new/[^/]+/[^/]+/[^/]+/[^/]+/([^?]+)') AS fname,
            file_url, mime_type
       FROM chatpush_messages
      WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
        AND file_url IS NOT NULL AND text LIKE 'Рекомендации после%'
        AND msg_ts > extract(epoch from now() - make_interval(days => $2))`,
    [salonId, days]);

  const byName = new Map();
  for (const r of rows) {
    if (!r.fname || /_media\.jpg$/.test(r.fname)) continue;
    const g = byName.get(r.fname) || { fname: r.fname, sends: 0, mime: null, best: null };
    g.sends += 1;
    g.mime = g.mime || r.mime_type;
    const until = signedUntilMs(r.file_url);
    if (!g.best || until > g.best.until) g.best = { url: r.file_url, until };
    byName.set(r.fname, g);
  }

  const manifest = [];
  const missing = [];
  const groups = [...byName.values()].sort((a, b) => b.sends - a.sends);
  for (const g of groups) {
    const name = slug(decodeURIComponent(g.fname));
    const dest = path.join(outDir, name);
    try {
      const res = await axios.get(g.best.url, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(dest, Buffer.from(res.data));
      manifest.push({ file: name, mime: g.mime || res.headers['content-type'] || null, sends: g.sends });
      console.log(`saved ${name} (${res.data.byteLength} b, ${g.sends} отправок)`);
    } catch (e) {
      // e.message без URL: подписанная ссылка — это доступ к файлу, в логи её не пишем
      const status = e.response ? `HTTP ${e.response.status}` : e.message;
      const until = g.best.until ? `, подпись действовала до ${new Date(g.best.until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
      missing.push({ file: name, sends: g.sends, why: `${status}${until}` });
      console.warn(`WARN ${name}: ${status}${until}`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const lines = [`# Шаблоны Chatpush/YClients для салона ${salonId} (последние ${days} дней)`, '',
    'Выгружено скриптом `backend/scripts/chatpush-notifications-harvest.js`. Шаблоны сгруппированы по тексту с числами, замененными на `#`; в блоке показан реальный пример текста.', ''];
  for (const t of templates) {
    lines.push(`## ${t.n} отправок · каналы ${t.channels.join(', ')} · последняя ${t.last_at}`, '', '```', t.sample, '```', '');
  }
  lines.push('## Картинки «Рекомендации после процедуры»', '',
    '(отправки по max/tdlib; в WhatsApp файл уходит под именем `<время>_media.jpg`, по услуге его не опознать)', '',
    ...manifest.map((m) => `- ${m.file} — ${m.sends} отправок`));
  if (missing.length) {
    lines.push('', '### Не получены (подписанная ссылка протухла или недоступна)', '',
      ...missing.map((m) => `- ${m.file} — ${m.sends} отправок; ${m.why}`));
  }
  fs.writeFileSync(docPath, lines.join('\n') + '\n');
  console.log(`templates: ${templates.length}, photos: ${manifest.length}, missing: ${missing.length} → ${docPath}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
