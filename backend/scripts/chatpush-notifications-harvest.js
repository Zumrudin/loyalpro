'use strict';
// Выгрузка того, что Chatpush/YClients реально шлют пациентам: уникальные тексты
// служебных исходящих (authored_by='system') и картинки «Рекомендации после
// процедуры» по их подписанным URL (Яндекс S3). Ничего не пишет в БД, ничего не отправляет.
//
// Запуск: cd backend && node scripts/chatpush-notifications-harvest.js [--salon=1] [--days=45] [--min=3] [--md=<путь>]
//   --salon, --days, --min — целые числа больше 0;
//   --days — окно выборки (и для текстов, и для картинок);
//   --min  — сколько раз текст должен встретиться, чтобы попасть в выгрузку (по умолчанию 3).
//            Редкие автоответы (например, на низкую оценку — 2 раза за всю историю) требуют --min=2;
//   --md   — куда писать СЫРУЮ выгрузку текстов (по умолчанию <tmp>/chatpush-templates-raw.md, вне репозитория).
//
// ПОРЯДОК РАБОТЫ С md. В сырой выгрузке (authored_by='system') не только уведомления YClients/Chatpush,
// но и НАШИ исходящие: касания «Заботы» с именами пациентов, реплики Милы, рассылки. Поэтому скрипт
// пишет её вне репозитория, а не в docs/ и не во frontend/: frontend/ целиком раздаётся сервером
// статикой без авторизации (templates-raw.md в frontend/uploads/notify_seed отдавался по HTTP 200), так что
// даже игнорируемый git файл там — утечка имён; путь внутри frontend/ скрипт отвергает. Курированный
// docs/notifications/chatpush-templates-2026-10-13.md ведётся ВРУЧНУЮ: из сырого файла в него переносят
// только служебные уведомления; имён пациентов в репозитории быть не должно. Скрипт этот файл не пишет
// и отказывается писать в него через --md.
//
// КАРТИНКИ. Ссылки берутся из двух источников: chatpush_messages и сырых событий chatpush_events
// (исходящие, file_data.caption «Рекомендации после…»). Второй обязателен: когда канал переехал на
// свой шлюз, события Chatpush только сохраняются, а в chatpush_messages их не разбирает гейт
// провайдера (routes/chatpush-webhook.js), — самые свежие рассылки живут лишь в events.
// Подписанная ссылка протухает; срок записан в ней самой (X-Amz-Date + X-Amz-Expires):
// у tdlib ссылки живут 7 суток, у MAX и WhatsApp — 2. Для каждого файла берётся ссылка с самым
// поздним сроком, а не просто самая свежая рассылка. Файлы с именем-идентификатором — WhatsApp
// «<время>_media.jpg», Telegram «<число>_<n>.jpg» (картинку переслали руками), UUID — это не шаблонные
// картинки, по услуге их не опознать: они пропускаются.
// Перезапуск безопасен: уже скачанный файл не перекачивается, manifest.json сливается с прежним
// (записи, которых в этот раз не видно, не теряются), скачанное проверяется по сигнатуре
// (JPEG/PNG/WEBP), иначе WARN и файл не сохраняется.
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { db, pool } = require('../db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

function fail(msg) { console.error(msg); process.exit(1); }
function intArg(name, def) {
  const raw = args[name];
  if (raw === undefined) return def;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(`--${name} должен быть целым числом больше 0 (получено: ${raw === true ? 'флаг без значения' : JSON.stringify(raw)})`);
  }
  return Number(raw);
}

const salonId = intArg('salon', 1);
const days = intArg('days', 45);
const minCount = intArg('min', 3);
const outDir = path.join(__dirname, '../../frontend/uploads/notify_seed');
const curatedDoc = path.join(__dirname, '../../docs/notifications/chatpush-templates-2026-10-13.md');
if (args.md !== undefined && (typeof args.md !== 'string' || !args.md)) fail('--md требует путь: --md=<файл>');
const mdPath = args.md ? path.resolve(args.md) : path.join(os.tmpdir(), 'chatpush-templates-raw.md');
const webRoot = path.resolve(__dirname, '../../frontend');   // раздаётся express.static без авторизации
if (mdPath === path.resolve(curatedDoc)) fail('--md не может указывать на курированный docs/notifications/chatpush-templates-2026-10-13.md: он ведётся вручную');
if (mdPath === webRoot || mdPath.startsWith(webRoot + path.sep)) fail('--md не может лежать в frontend/: каталог раздаётся сервером статикой без авторизации, а в сыром md имена пациентов');
const manifestPath = path.join(outDir, 'manifest.json');

function slug(s) { return String(s).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80); }

// Имя файла из ссылки Chatpush: delivery_files_new/<4 сегмента хэша>/<имя>?<подпись>.
function fileNameOf(url) {
  const m = /delivery_files_new\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([^?]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

// Имя-идентификатор, а не название услуги: «1790007615_media» (WhatsApp), «5368456872735744039_121»
// (Telegram), UUID. Название шаблонной картинки — слова («Пилинг», «Morpheus 8»).
function isIdName(fname) {
  const base = fname.replace(/\.[^.]+$/, '');
  return /_media$/.test(base) || /^(?=.*\d)[0-9a-f_-]{8,}$/i.test(base);
}

// Момент (мс), до которого действует подписанная ссылка; 0 — подпись не разобрана.
function signedUntilMs(url) {
  const d = /X-Amz-Date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url);
  const e = /X-Amz-Expires=(\d+)/.exec(url);
  if (!d || !e) return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]) + Number(e[1]) * 1000;
}

function fmtUtc(ms) { return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`; }

// Сигнатура картинки: JPEG FFD8FF, PNG 89504E470D0A1A0A, WEBP «RIFF….WEBP». Не картинка → null.
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Прежний manifest: повреждённый НЕ затираем (бросаем — лучше остановиться, чем потерять записи).
function loadManifest() {
  if (!fs.existsSync(manifestPath)) return [];
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${manifestPath}: ожидался массив`);
  return data;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  const manifest = loadManifest();
  const byFile = new Map(manifest.map((m) => [m.file, m]));
  // Слияние: запись файла, которого в этот раз не видно, остаётся; sends не уменьшается
  // из-за более узкого окна.
  function upsert(file, mime, sends) {
    const old = byFile.get(file);
    if (old) { old.mime = mime; old.sends = Math.max(Number(old.sends) || 0, sends); return; }
    const entry = { file, mime, sends };
    byFile.set(file, entry); manifest.push(entry);
  }

  const templates = await db.any(
    `SELECT regexp_replace(text, '\\d+', '#', 'g') AS tpl, min(text) AS sample,
            count(*) AS n, array_agg(DISTINCT channel) AS channels,
            to_char(to_timestamp(max(msg_ts)) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS last_at
       FROM chatpush_messages
      WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
        AND msg_ts > extract(epoch from now() - make_interval(days => $2))
      GROUP BY 1 HAVING count(*) >= $3 ORDER BY n DESC`,
    [salonId, days, minCount]);

  // Ссылки на «Рекомендации» из двух источников.
  const msgRows = await db.any(
    `SELECT file_url
       FROM chatpush_messages
      WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
        AND file_url IS NOT NULL AND text LIKE 'Рекомендации после%'
        AND msg_ts > extract(epoch from now() - make_interval(days => $2))`,
    [salonId, days]);
  // У tdlib/MAX файл лежит в payload.message.file_data, у WhatsApp (вложенная форма) —
  // в payload.new_message.message.file_data.
  const evRows = await db.any(
    `SELECT coalesce(payload#>>'{payload,message,file_data,download_url}',
                     payload#>>'{payload,new_message,message,file_data,download_url}') AS file_url
       FROM chatpush_events
      WHERE salon_id = $1 AND direction = 'outgoing'
        AND received_at > now() - make_interval(days => $2)
        AND coalesce(payload#>>'{payload,message,file_data,caption}',
                     payload#>>'{payload,new_message,message,file_data,caption}') LIKE 'Рекомендации после%'`,
    [salonId, days]);

  // Сливаем по имени файла. Одна отправка = один путь загрузки (у каждой свои хэш-сегменты),
  // и в messages, и в events она лежит с той же ссылкой — поэтому отправки считаем по пути, без
  // двойного счёта. Лучшая ссылка — с самым поздним сроком жизни: двухсуточная ссылка свежей
  // рассылки не должна перекрывать ещё живую семисуточную более ранней.
  const byName = new Map();
  const oneOff = new Set();   // разовые файлы с именем-идентификатором (пути загрузки)
  for (const { file_url: url } of [...msgRows, ...evRows]) {
    const fname = fileNameOf(url);
    if (!fname) continue;
    if (isIdName(fname)) { oneOff.add(url.split('?')[0]); continue; }
    const g = byName.get(fname) || { fname, uploads: new Set(), best: null };
    g.uploads.add(url.split('?')[0]);
    const until = signedUntilMs(url);
    if (!g.best || until > g.best.until) g.best = { url, until };
    byName.set(fname, g);
  }

  const now = Date.now();
  const have = [];     // файл уже лежал на диске
  const saved = [];    // скачан в этот прогон
  const missing = [];  // достать не удалось
  const groups = [...byName.values()].sort((a, b) => b.uploads.size - a.uploads.size);
  for (const g of groups) {
    const sends = g.uploads.size;
    let name = g.fname;
    try {
      name = slug(decodeURIComponent(g.fname));
      const dest = path.join(outDir, name);
      if (fs.existsSync(dest)) {
        const mime = sniffImage(fs.readFileSync(dest));
        if (mime) {
          upsert(name, mime, sends); have.push({ file: name, sends });
          console.log(`have  ${name} (уже есть, не перекачиваю)`);
          continue;
        }
        console.warn(`WARN ${name}: файл на диске не картинка, скачиваю заново`);
      }
      if (g.best.until && g.best.until <= now) {
        const why = `подпись истекла ${fmtUtc(g.best.until)}`;
        missing.push({ file: name, sends, why });
        console.warn(`WARN ${name}: ${why} (запрос не делался)`);
        continue;
      }
      const res = await axios.get(g.best.url, { responseType: 'arraybuffer', timeout: 60000 });
      const buf = Buffer.from(res.data);
      const mime = sniffImage(buf);
      if (!mime) {
        const why = 'ответ не картинка (сигнатура не JPEG/PNG/WEBP), файл не сохранён';
        missing.push({ file: name, sends, why });
        console.warn(`WARN ${name}: ${why}`);
        continue;
      }
      fs.writeFileSync(dest, buf);
      upsert(name, mime, sends); saved.push({ file: name, sends });
      console.log(`saved ${name} (${buf.length} b, ${sends} отправок)`);
    } catch (e) {
      // e.message без URL: подписанная ссылка — это доступ к файлу, в логи её не пишем
      const status = e.response ? `HTTP ${e.response.status}` : e.message;
      const until = g.best.until ? `, подпись действовала до ${fmtUtc(g.best.until)}` : '';
      missing.push({ file: name, sends, why: `${status}${until}` });
      console.warn(`WARN ${name}: ${status}${until}`);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  for (const m of manifest) {
    if (!fs.existsSync(path.join(outDir, m.file))) console.warn(`WARN manifest: файла ${m.file} нет на диске (запись оставлена)`);
  }

  const lines = [`# Шаблоны Chatpush/YClients для салона ${salonId} (последние ${days} дней) — СЫРАЯ выгрузка`, '',
    'СЫРАЯ выгрузка скриптом `backend/scripts/chatpush-notifications-harvest.js`: в ней есть имена пациентов (касания «Заботы», реплики Милы) — не коммитить. '
    + 'Курированная версия — `docs/notifications/chatpush-templates-2026-10-13.md`, она ведётся вручную: сюда не пишется, в неё из этого файла переносят только служебные уведомления YClients/Chatpush.',
    '', 'Шаблоны сгруппированы по тексту с числами, замененными на `#`; в блоке показан реальный пример текста.', ''];
  for (const t of templates) {
    lines.push(`## ${t.n} отправок · каналы ${t.channels.join(', ')} · последняя ${t.last_at}`, '', '```', t.sample, '```', '');
  }
  lines.push('## Картинки «Рекомендации после процедуры»', '',
    '(ссылки из chatpush_messages и chatpush_events; разовые файлы с именем-идентификатором — WhatsApp `<время>_media.jpg`, Telegram `<число>_<n>.jpg`, UUID — по услуге не опознать, они пропущены)', '',
    ...[...saved, ...have].sort((a, b) => b.sends - a.sends).map((m) => `- ${m.file} — ${m.sends} отправок`));
  if (missing.length) {
    lines.push('', '### Не получены (подписанная ссылка протухла или недоступна)', '',
      ...missing.map((m) => `- ${m.file} — ${m.sends} отправок; ${m.why}`));
  }
  fs.writeFileSync(mdPath, lines.join('\n') + '\n', { mode: 0o600 });   // в сыром md имена пациентов
  console.log(`templates: ${templates.length}; photos: saved ${saved.length}, already had ${have.length}, missing ${missing.length}, пропущено разовых файлов с именем-идентификатором: ${oneOff.size}; raw md → ${mdPath}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
