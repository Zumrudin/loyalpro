#!/usr/bin/env node
'use strict';
// Замер «роботского» стиля Милы — те же счётчики, что в разборе 27.10.2026
// (спека docs/superpowers/specs/2026-10-27-mila-human-tone-design.md, раздел 6):
// доля markdown, обращение с заглавной/строчной, представления и из них
// приклеенные к ответу по делу, эмодзи, вопрос в конце, серии реплик подряд
// без ответа пациента. Снимать до выката и через неделю после — одним инструментом.
//
//   node scripts/mila-style-metrics.js [--days=14] [--salon=1] [--db=loyalpro]
//
// Только чтение. --db подменяет имя БД в DATABASE_URL: с дева через туннель
// так читается прод-БД `loyalpro` (дев — `loyalpro_test`).
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const INTRO_RE = /(я\s+Мила|это\s+Мила|на\s+связи\s+Мила|виртуальн[а-яё]+\s+администратор)/i;
const MD_RE = /\*\*|^\s*[*\-]\s+\S|#{1,3}\s/m;
const CAP_RE = /(?<![\p{L}])(Вы|Вас|Вам|Вами|Ваш[а-яё]*)(?![\p{L}])/u;
const LOW_RE = /(?<![\p{L}])(вы|вас|вам|вами|ваш[а-яё]*)(?![\p{L}])/u;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
// «Чистое» приветствие: приветствие + представление (+ дежурный вопрос) и ничего
// больше; всё остальное с представлением — приклеено к ответу по делу.
const PURE_GREETING_RE = /^Здравствуйте[^\n]*\n?(?:Это|Я) Мила, виртуальный администратор[^.\n]*\.\s*(?:Подскажите, чем могу помочь\?|Чем могу помочь\?|Подскажите, как могу к Вам обращаться[^\n]*)?\s*$/i;

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// rows: [{ key, direction, authored_by, text, msg_ts }] в хронологическом порядке
// внутри ключа диалога. Чистая функция — покрыта mila-style-metrics.test.js.
function computeStyleMetrics(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const agent = all.filter(r => r.direction === 'outgoing' && r.authored_by === 'agent' && r.text && String(r.text).trim());
  const n = agent.length;
  const pct = k => (n ? Math.round(100 * k / n) : 0);
  const lens = agent.map(r => String(r.text).length);
  const count = re => agent.filter(r => re.test(String(r.text))).length;
  const intros = agent.filter(r => INTRO_RE.test(String(r.text)));
  const introsStapled = intros.filter(r => !PURE_GREETING_RE.test(String(r.text).trim())).length;
  // Серии реплик Милы подряд: любое чужое сообщение (пациент, администратор,
  // автоуведомление) серию обрывает.
  let cur = null; const runs = [];
  for (const m of all) {
    const isAgent = m.direction === 'outgoing' && m.authored_by === 'agent';
    if (isAgent) {
      if (cur && cur.key === m.key) cur.n++;
      else { cur = { key: m.key, n: 1 }; runs.push(cur); }
    } else cur = null;
  }
  return {
    replies: n,
    dialogs: new Set(agent.map(r => r.key)).size,
    avgChars: n ? Math.round(lens.reduce((a, b) => a + b, 0) / n) : 0,
    medianChars: median(lens),
    markdownPct: pct(count(MD_RE)),
    capitalAddressPct: pct(count(CAP_RE)),
    lowerAddressPct: pct(count(LOW_RE)),
    intros: intros.length,
    introsStapled,
    emojiPct: pct(count(EMOJI_RE)),
    endsWithQuestionPct: pct(count(/\?\s*$/)),
    runs2: runs.filter(r => r.n === 2).length,
    runs3plus: runs.filter(r => r.n >= 3).length,
  };
}

const SQL = `
  SELECT coalesce(phone, chat_id) AS key, direction, authored_by, text, msg_ts
    FROM chatpush_messages
   WHERE salon_id = $1
     AND msg_ts >= extract(epoch from now() - ($2::int || ' days')::interval)
     AND (direction = 'incoming' OR authored_by IN ('agent', 'operator', 'system'))
   ORDER BY coalesce(phone, chat_id), msg_ts`;

async function main() {
  const { Client } = require('pg');
  const args = process.argv.slice(2);
  const opt = (name, def) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const days = Number(opt('days', 14));
  const salon = Number(opt('salon', 1));
  const dbName = opt('db', null);
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(salon)) {
    console.error('usage: node scripts/mila-style-metrics.js [--days=14] [--salon=1] [--db=loyalpro]');
    process.exit(2);
  }
  let url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL не задан'); process.exit(2); }
  if (dbName) url = url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(SQL, [salon, days]);
    const m = computeStyleMetrics(rows);
    console.log(JSON.stringify({ db: dbName || 'default', salon, days, ...m }, null, 2));
  } finally {
    await client.end();
  }
}

module.exports = { computeStyleMetrics, INTRO_RE, PURE_GREETING_RE };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
