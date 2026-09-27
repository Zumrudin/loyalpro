'use strict';

// Production is READ ONLY. Replays only text inputs in private chats. Prior
// replies are historical context, not expected answers or future information.
const fs = require('node:fs/promises');
const { main, safeRegistry } = require('./mila-codex-full-prompt');
const DAY = '2026-09-26';
const REPORT = `/tmp/mila-codex-production-${DAY}.json`;
const LEDGER = `/tmp/mila-codex-production-${DAY}-booking.json`;
const normalize = s => String(s || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');

async function downloadTestImage(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('EVAL_MEDIA_URL_REJECTED');
  const addresses = await require('node:dns/promises').lookup(url.hostname, { all: true });
  if (addresses.some(a => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::|fc|fd|fe80)/i.test(a.address))) {
    throw new Error('EVAL_MEDIA_URL_REJECTED');
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('EVAL_MEDIA_DOWNLOAD_FAILED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('EVAL_MEDIA_TOO_LARGE');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const jpg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!jpg && !png) throw new Error('EVAL_MEDIA_FORMAT_UNSUPPORTED');
  const dir = await fs.mkdtemp('/tmp/mila-codex-photo-');
  const filename = `${dir}/input.${jpg ? 'jpg' : 'png'}`;
  await fs.writeFile(filename, buffer, { mode: 0o600 });
  return filename;
}

function anonymizer(names, testPhone) {
  const dictionary = [...new Set(names.filter(Boolean).flatMap(n => {
    const full = String(n).trim();
    return [full, ...full.split(/\s+/).filter(w => w.length >= 3)];
  }))].sort((a, b) => b.length - a.length);
  return text => {
    let s = String(text || '');
    for (const name of dictionary) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'giu'), '[клиент]');
    }
    return s
      .replace(/(?<!\d)(?:\+?7|8)[\s().-]*(?:\d[\s().-]*){9}\d(?!\d)/g, testPhone || '[номер скрыт]')
      .replace(/\b\d{10,}\b/g, testPhone || '[номер скрыт]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email скрыт]')
      .replace(/https?:\/\/[^\s]+/gi, '[ссылка скрыта]')
      .replace(/@[A-Za-z0-9_]{3,}/g, '[аккаунт скрыт]');
  };
}

function buildCases(rows, dayStart, dayEnd, clean) {
  const byDialog = new Map();
  for (const row of rows) {
    if (!byDialog.has(row.dialog_key)) byDialog.set(row.dialog_key, []);
    byDialog.get(row.dialog_key).push(row);
  }
  const cases = [];
  let dialogIndex = 0, inputCount = 0, mediaSkipped = 0, emptySkipped = 0;
  for (const timeline of byDialog.values()) {
    const dialog = `D${String(++dialogIndex).padStart(2, '0')}`;
    const history = [];
    let lastOutgoing = null;
    for (let i = 0; i < timeline.length; i++) {
      const row = timeline[i];
      const inDay = row.msg_ts >= dayStart && row.msg_ts < dayEnd;
      const isText = ['text', 'formattedText'].includes(row.msg_type);
      if (!isText || !String(row.text || '').trim()) {
        if (inDay && row.direction === 'incoming') {
          if (!isText) mediaSkipped++; else emptySkipped++;
        }
        continue;
      }
      const body = clean(row.text);
      if (row.direction !== 'incoming') {
        lastOutgoing = { author: row.authored_by || 'operator', text: body };
        const prefix = row.authored_by === 'agent' ? '' : '[сообщение администратора клиники] ';
        history.push({ role: 'assistant', content: prefix + body });
        continue;
      }
      const burst = [body];
      let last = row;
      // Match the 5-second debounce: all original incoming messages are counted.
      if (inDay) while (i + 1 < timeline.length) {
        const next = timeline[i + 1];
        if (next.direction !== 'incoming' || next.msg_ts >= dayEnd
            || next.msg_ts - last.msg_ts > 5 || !['text', 'formattedText'].includes(next.msg_type)
            || !String(next.text || '').trim()) break;
        burst.push(clean(next.text)); last = next; i++;
      }
      history.push({ role: 'user', content: burst.join('\n') });
      if (!inDay) continue;
      inputCount += burst.length;
      const nowMs = Number(last.msg_ts) * 1000;
      cases.push({ id: `${dialog}-T${String(cases.filter(c => c.dialog === dialog).length + 1).padStart(2, '0')}`,
        dialog, question: burst.join('\n'), sourceMessageCount: burst.length, nowMs,
        sourceTime: new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }),
        lastOutgoing,
        messages: history.slice(-20).map(m => ({ ...m })),
        // Do not misidentify every original customer as the male test-account
        // owner. Phone remains the owner's; original names are not forwarded.
        identity: { name: 'Тестовый клиент', givenName: null },
      });
    }
  }
  return { cases, metadata: { date: DAY, timezone: 'Europe/Moscow', dialogs: dialogIndex,
    inputCount, mediaSkipped, emptySkipped, turns: cases.length,
    mode: 'historical-context-current-read-tools', historicalAvailability: false } };
}

async function loadCases({ config, salonId, phone }) {
  const { Client } = require('pg');
  const url = new URL(config.DATABASE_URL);
  if (url.pathname !== '/loyalpro_test') throw new Error('EVAL_TEST_DATABASE_REQUIRED');
  url.pathname = '/loyalpro';
  const prod = new Client({ connectionString: url.toString(), ssl: config.DB_SSL,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000', connectionTimeoutMillis: 10000 });
  try {
    await prod.connect();
    const start = Date.parse(`${DAY}T00:00:00+03:00`) / 1000, end = start + 86400;
    const { rows } = await prod.query(`
      WITH targets AS (
        SELECT DISTINCT COALESCE(NULLIF(phone,''),chat_id) AS dialog_key
        FROM chatpush_messages
        WHERE salon_id=$1 AND direction='incoming' AND msg_ts >= $2 AND msg_ts < $3
          AND COALESCE(chat_id,'') !~ '^(-|g:)' AND COALESCE(chat_id,'') !~ '@(g.us|broadcast)$'
      ), prior AS (
        SELECT p.* FROM targets t CROSS JOIN LATERAL (
          SELECT id,direction,msg_type,text,msg_ts,authored_by,sender_name,phone,file_url,
            COALESCE(NULLIF(phone,''),chat_id) AS dialog_key
          FROM chatpush_messages WHERE salon_id=$1
            AND COALESCE(NULLIF(phone,''),chat_id)=t.dialog_key AND msg_ts < $2
            AND COALESCE(chat_id,'') !~ '^(-|g:)' AND COALESCE(chat_id,'') !~ '@(g.us|broadcast)$'
          ORDER BY msg_ts DESC,id DESC LIMIT 20
        ) p
      ), current_day AS (
        SELECT id,direction,msg_type,text,msg_ts,authored_by,sender_name,phone,file_url,
          COALESCE(NULLIF(phone,''),chat_id) AS dialog_key
        FROM chatpush_messages WHERE salon_id=$1 AND msg_ts >= $2 AND msg_ts < $3
          AND COALESCE(NULLIF(phone,''),chat_id) IN (SELECT dialog_key FROM targets)
          AND COALESCE(chat_id,'') !~ '^(-|g:)' AND COALESCE(chat_id,'') !~ '@(g.us|broadcast)$'
      ) SELECT * FROM prior UNION ALL SELECT * FROM current_day ORDER BY dialog_key,msg_ts,id
    `, [salonId, start, end]);
    const tails = [...new Set(rows.map(r => normalize(r.phone).slice(-10)).filter(t => t.length === 10))];
    const contacts = await prod.query(`SELECT id,name,phone,yclients_data FROM clients WHERE salon_id=$1
      AND right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=ANY($2::text[])`, [salonId, tails]);
    const names = [...contacts.rows.map(r => r.name), ...rows.filter(r => r.direction === 'incoming').map(r => r.sender_name)];
    const clean = anonymizer(names, phone);
    // Also strip personal contacts from the saved report; never persist raw rows.
    reportCleaner = anonymizer(names);
    const dataset = buildCases(rows, start, end, clean);
    if (process.argv.includes('--media-only')) {
      const keys = [...new Set(rows.map(r => r.dialog_key))];
      const photos = rows.filter(r => r.direction === 'incoming' && r.msg_type === 'messagePhoto'
        && r.msg_ts >= start && r.msg_ts < end && r.file_url);
      dataset.cases = [];
      for (const row of photos) {
        const image = await downloadTestImage(row.file_url);
        const prior = rows.filter(r => r.dialog_key === row.dialog_key &&
          (r.msg_ts < row.msg_ts || (r.msg_ts === row.msg_ts && Number(r.id) < Number(row.id)))
          && ['text', 'formattedText'].includes(r.msg_type) && r.text).slice(-20);
        const question = '[Входящее фото; изображение приложено к запросу]';
        const dialog = `D${String(keys.indexOf(row.dialog_key) + 1).padStart(2, '0')}`;
        dataset.cases.push({ id: `${dialog}-PHOTO`, dialog, question, imagePaths: [image],
          sourceMessageCount: 1, nowMs: Number(row.msg_ts) * 1000,
          sourceTime: new Date(Number(row.msg_ts) * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }),
          messages: [...prior.map(r => ({ role: r.direction === 'incoming' ? 'user' : 'assistant',
            content: clean(r.text) })), { role: 'user', content: question }] });
      }
      dataset.metadata = { ...dataset.metadata, turns: dataset.cases.length, inputCount: photos.length,
        mediaSkipped: 0, modality: 'image' };
    }
    const { rows: records } = await prod.query(`SELECT client_id,visit_datetime,services,staff,
        specialist_name,raw_payload,status,created_at
      FROM records WHERE salon_id=$1 AND client_id=ANY($2::int[])
        AND visit_datetime < to_timestamp($3) + interval '90 days'
      ORDER BY visit_datetime`, [salonId, contacts.rows.map(c => c.id), start]);
    const keys = [...new Set(rows.map(r => r.dialog_key))];
    const byPhone = new Map(contacts.rows.map(c => [normalize(c.phone).slice(-10), c]));
    const { resolveGivenName } = require('../utils/person-name');
    const dictionary = await require('../utils/salon-names').load(salonId);
    for (const test of dataset.cases) {
      const key = keys[Number(test.dialog.slice(1)) - 1];
      const sourceRow = rows.find(r => r.dialog_key === key && r.phone);
      const contact = byPhone.get(normalize(sourceRow?.phone).slice(-10));
      let given = null;
      if (contact) {
        given = resolveGivenName(contact.yclients_data?.name ? contact.yclients_data : contact.name, { dictionary });
      }
      // Keep only the given name internally for gender/known-client behavior;
      // source identifiers and full names never enter the model or report.
      test.identity = contact ? { name: given || 'Тестовый клиент', givenName: given } : { name: null, givenName: null };
      test.bookings = !contact ? null : records.filter(r => r.client_id === contact.id
        && new Date(r.visit_datetime).getTime() >= test.nowMs
        && new Date(r.created_at).getTime() <= test.nowMs
        && r.raw_payload?.deleted !== true && Number(r.raw_payload?.attendance) !== -1
        && !/cancel|отмен|delete/i.test(r.status || '') && (r.services || []).length)
        .map((r, index) => ({ record_id: 800000000 + index,
          datetime: new Date(r.visit_datetime).toISOString(),
          services: (r.services || []).map(s => typeof s === 'string' ? s : s.title).filter(Boolean),
          staff_yc_id: r.raw_payload?.staff_id || r.staff?.id || null,
          staff_name: r.specialist_name || r.staff?.name || null }));
      test.visits = !contact ? null : records.filter(r => r.client_id === contact.id
        && new Date(r.visit_datetime).getTime() < test.nowMs
        && new Date(r.created_at).getTime() <= test.nowMs
        && r.raw_payload?.deleted !== true && Number(r.raw_payload?.attendance) !== -1
        && !/cancel|отмен|delete/i.test(r.status || ''))
        .slice(-10).reverse().map(r => ({ datetime: new Date(r.visit_datetime).toISOString(),
          services: (r.services || []).map(s => typeof s === 'string' ? s : s.title).filter(Boolean),
          staff_name: r.specialist_name || r.staff?.name || null }));
    }
    dataset.metadata.identityMode = 'original-given-name-in-memory-redacted-in-report';
    dataset.metadata.bookingsMode = 'production-database-snapshot-synthetic-record-ids';
    dataset.metadata.knownIdentityTurns = dataset.cases.filter(c => c.identity?.givenName).length;
    dataset.metadata.withBookingTurns = dataset.cases.filter(c => c.bookings?.length).length;
    dataset.metadata.unknownBookingTurns = dataset.cases.filter(c => c.bookings === null).length;
    return dataset;
  } finally { await prod.end(); }
}

let reportCleaner = anonymizer([]);

function testBookingArgs(input, phone, ownerName) {
  if (!/^7\d{10}$/.test(phone) || !ownerName) throw new Error('EVAL_TEST_CLIENT_REQUIRED');
  return { ...input, client_phone: phone, client_name: ownerName,
    comment: `Тест Codex: воспроизведение сообщений за ${DAY}.` };
}

async function configure({ config, salonId, phone, client, pool, db }) {
  const allowBookings = process.argv.includes('--allow-test-booking');
  if (allowBookings && !client?.name) throw new Error('EVAL_TEST_CLIENT_REQUIRED');
  const { Pool } = require('pg');
  // Only create-booking's transaction may use a writable DEVELOPMENT connection.
  // All normal queries, source reads and other tools retain read-only connections.
  const writePool = allowBookings ? new Pool({ connectionString: config.DATABASE_URL, ssl: config.DB_SSL,
    max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000 }) : null;
  let writing = false;
  const connectRead = pool.connect.bind(pool);
  if (allowBookings) pool.connect = (...args) => writing ? writePool.connect(...args) : connectRead(...args);
  return { registry(base, sid, targetPhone, calls, test) {
    const wrapped = safeRegistry(base, sid, targetPhone, calls);
    // Reading the owner's records here would contradict the historical dialog.
    wrapped.handlers.list_client_bookings = async () => {
      calls.push({ name: 'list_client_bookings', simulated: false, sourceSnapshot: true });
      return test.bookings === null ? { error: 'historical_bookings_unavailable' } : { bookings: test.bookings || [] };
    };
    wrapped.handlers.get_client = async () => ({ found: !!test.identity?.givenName,
      client: test.identity?.givenName ? { name: test.identity.givenName } : undefined });
    wrapped.handlers.get_client_visit_history = async () => {
      calls.push({ name: 'get_client_visit_history', simulated: false, sourceSnapshot: true });
      return test.visits === null ? { visits: [], reason: 'client_not_found' } : { visits: test.visits || [] };
    };
    for (const name of ['get_bonus_balance', 'get_client_abonements']) {
      wrapped.handlers[name] = async () => {
        calls.push({ name, simulated: true, blocked: 'historical_data_not_loaded' });
        return { error: 'Эти данные клиента недоступны в историческом тесте. Не используй данные тестового владельца.' };
      };
    }
    if (!allowBookings) return wrapped;
    wrapped.handlers.create_booking = async (actualSalon, input, ctx) => {
      if (actualSalon !== salonId || normalize(ctx?.clientPhone) !== phone) throw new Error('EVAL_CONTEXT_MISMATCH');
      const entry = { name: 'create_booking', simulated: false, authorizedTestNumber: true };
      calls.push(entry);
      const date = String(input?.datetime || '');
      const timestamp = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(date) ? date : date.replace(' ', 'T') + '+03:00');
      if (!Number.isFinite(timestamp) || timestamp < Date.now() + 2 * 3600000) {
        entry.blocked = 'historical_or_too_soon';
        return { too_soon: true, error: 'Время визита уже прошло или слишком близко для текущего тестового запуска. Запись не создана.' };
      }
      if (ctx.slotEvidence && !ctx.slotEvidence.has(input.datetime, { staffYcId: input.staff_yc_id })) {
        entry.blocked = 'unverified_slot';
        return { unverified_slot: true, error: 'Сначала проверь это время инструментом get_available_slots. Запись пока не создана.' };
      }
      // One real booking at most in this day's replay, including restarts.
      let lock;
      try { lock = await fs.open(LEDGER, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        entry.blocked = 'one_booking_limit';
        return { error: 'Лимит реальных тестовых записей исчерпан. Новая запись не создана.' };
      }
      await lock.writeFile(JSON.stringify({ status: 'attempt_started', date }));
      await lock.close();
      try {
        writing = true;
        const result = await base.handlers.create_booking(actualSalon,
          testBookingArgs(input, phone, client.name),
          { ...ctx, clientPhone: phone, clientName: client.name, nowMs: Date.now() });
        entry.created = !!result?.created;
        entry.error = !!result?.error;
        await fs.writeFile(LEDGER, JSON.stringify({ status: result?.created ? 'created' : 'not_created',
          recordId: result?.record_id || null, datetime: date }), { mode: 0o600 });
        return result;
      } finally { writing = false; }
    };
    return wrapped;
  } };
}

if (require.main === module) main({ loadCases, configure,
  reportPath: process.argv.includes('--media-only') ? REPORT.replace('.json', '-media.json') : REPORT,
  allowBookings: process.argv.includes('--allow-test-booking'),
  sanitizeReport: text => reportCleaner(text) }).then(() => process.exit(0)).catch(() => {
  process.stderr.write('EVAL_PRODUCTION_REPLAY_FAILED\n'); process.exit(1);
});
module.exports = { anonymizer, buildCases, loadCases, testBookingArgs };
