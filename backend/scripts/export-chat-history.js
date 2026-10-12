// Разовая выгрузка истории «Чата» с ПРОДА в CSV (клиент + переписка).
// Запуск: cd backend && node tmp-analysis/export-chat-history.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT_DIR = path.join(__dirname, '..', '..', 'exports');
const u = new URL(process.env.DATABASE_URL);
u.pathname = '/loyalpro'; // ПРОД-база (dev = loyalpro_test), тот же SSH-туннель 127.0.0.1:5433

// Ключ диалога — зеркало DIALOG_KEY_SQL из services/chat.js
const DIALOG_KEY_SQL =
  `CASE WHEN chat_id LIKE '-%' THEN 'g:' || chat_id
        ELSE COALESCE(NULLIF(phone,''), chat_id) END`;

// До 05.08.2026 журнала авторства не было (AUTHORSHIP_SINCE_TS в agent/history.js):
// исходящее с authored_by IS NULL — это либо администратор руками, либо
// автоуведомление YClients. Различаем по шаблонам самих уведомлений.
const AUTO_PATTERNS = [
  /^Вы записаны на прием/i,
  /^Здравствуйте!\s*\n?Напоминаем о записи/i,
  /^Ваша запись .*перенесена/i,
  /^Ваша запись .*отменена/i,
  /^✅ Ваша запись подтверждена/i,
  /Просим Вас оценить обслуживание/i,
  /^Спасибо за отличную оценку/i,
  /^Рекомендации после процедуры/i,
  /Присоединяйтесь к программе лояльности PERI CLINIC/i,
  /В нашей команде появился врач-косметолог/i,
];

function authorRole(row) {
  if (row.direction === 'incoming') return 'клиент';
  if (row.authored_by === 'agent') return 'Мила (бот)';
  if (row.authored_by === 'operator') return 'администратор';
  if (row.authored_by === 'system') return 'авто-уведомление';
  const t = String(row.text || '');
  if (AUTO_PATTERNS.some((re) => re.test(t))) return 'авто-уведомление';
  return 'администратор';
}

// Тип диалога. Внутренние — по ключу (владелец, главврач, касса, врачи, свой же
// номер клиники); B2B/спам — по словарю холодных рассылок во ВХОДЯЩИХ.
const INTERNAL_KEYS = new Set([
  '79200255591',        // Зумрудин — владелец (тестовые прогоны + рабочие вопросы админов)
  'g:-72962629261478',  // рабочая группа
  '759317051',          // kevvkka — сводки по кассе
  '79202577754',        // Гаджиева Пери Исамудиновна — главврач
  '79678033545',        // врач Астемир
  '79094787882',        // Зарета (сотрудник)
  '79250177778',        // собственный номер клиники (фантомный диалог, инцидент 10.08)
]);
const B2B_RE = /(сотрудничеств|дистрибьютор|коммерческое предложение|наше предложение|поставщик|оптов|мы предлагаем|веб-дизайн|разрабатываю сайты|продвижени|таргет|Роскомнадзор|152-ФЗ|франшиз|инвестиц|вакансия|резюме|ищу салон|ищу работу|аренду места|перманентн\w* макияж|конгресс|вебинар|обучени|закупк|эквайринг)/i;

function dialogType(key, isGroup, msgs) {
  if (INTERNAL_KEYS.has(key)) return 'внутренний';
  if (isGroup) return 'группа';
  const incoming = msgs.filter((m) => m.direction === 'incoming').map((m) => m.text || '').join(' ');
  if (B2B_RE.test(incoming)) return 'B2B/спам';
  return 'клиент';
}

function msk(ts) {
  // msg_ts — unix-секунды; created_at — timestamp without time zone (сервер уже в мск)
  const d = ts ? new Date(Number(ts) * 1000) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace('T', ' ');
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
};
const csvRow = (arr) => arr.map(csvCell).join(',');

function bodyOf(row) {
  const t = (row.text || '').trim();
  if (t) return t;
  if (row.file_url) return `[вложение: ${row.msg_type || 'file'}]`;
  return `[${row.msg_type || 'пусто'}]`;
}

(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: false });
  await c.connect();

  const { rows } = await c.query(`
    SELECT m.id, m.salon_id, m.channel, m.direction, m.msg_type, m.text, m.file_url,
           m.sender_name, m.phone, m.chat_id, m.msg_ts, m.created_at, m.authored_by,
           ${DIALOG_KEY_SQL} AS dialog_key
      FROM chatpush_messages m
     ORDER BY dialog_key, COALESCE(m.msg_ts, 0), m.id`);

  // Имена клиентов: телефоны в clients лежат в разных формах (+7…, 8…),
  // поэтому сверяем по последним 10 цифрам.
  const { rows: clients } = await c.query(`
    SELECT name, phone, yclients_client_id, visits_count, bonus_balance, gender, last_visit_at
      FROM clients WHERE phone IS NOT NULL AND phone <> ''`);
  const byTail = new Map();
  for (const cl of clients) {
    const digits = String(cl.phone).replace(/\D/g, '');
    if (digits.length >= 10) byTail.set(digits.slice(-10), cl);
  }
  await c.end();

  const dialogs = new Map();
  for (const r of rows) {
    const key = r.dialog_key;
    if (!dialogs.has(key)) dialogs.set(key, []);
    dialogs.get(key).push(r);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const msgHeader = ['dialog_key', 'dialog_type', 'is_group', 'client_name', 'phone', 'visits_count',
    'channel', 'msg_index', 'datetime_msk', 'author', 'msg_type', 'text', 'file_url'];
  const dlgHeader = ['dialog_key', 'dialog_type', 'is_group', 'client_name', 'phone', 'yclients_client_id',
    'visits_count', 'bonus_balance', 'gender', 'channels', 'first_msg_msk', 'last_msg_msk',
    'messages_total', 'from_client', 'from_admin', 'from_mila', 'auto_notifications',
    'transcript'];

  const msgLines = [csvRow(msgHeader)];
  const dlgLines = [csvRow(dlgHeader)];
  const jsonDialogs = [];

  for (const [key, msgs] of [...dialogs.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const isGroup = key.startsWith('g:');
    const phone = (msgs.find((m) => m.phone)?.phone) || '';
    const tail = String(phone).replace(/\D/g, '').slice(-10);
    const cl = (!isGroup && tail.length === 10) ? byTail.get(tail) : null;
    const name = isGroup
      ? `[групповой чат] ${msgs.find((m) => m.sender_name)?.sender_name || ''}`.trim()
      : (cl?.name || msgs.find((m) => m.direction === 'incoming' && m.sender_name)?.sender_name || '');
    const channels = [...new Set(msgs.map((m) => m.channel).filter(Boolean))].join('|');
    const dtype = dialogType(key, isGroup, msgs);

    const counts = { 'клиент': 0, 'администратор': 0, 'Мила (бот)': 0, 'авто-уведомление': 0 };
    const transcript = [];
    msgs.forEach((m, i) => {
      const role = authorRole(m);
      counts[role] = (counts[role] || 0) + 1;
      const when = msk(m.msg_ts) || String(m.created_at || '');
      const body = bodyOf(m);
      msgLines.push(csvRow([key, dtype, isGroup ? 'да' : 'нет', name, phone, cl?.visits_count ?? '',
        m.channel, i + 1, when, role, m.msg_type, body, m.file_url || '']));
      transcript.push(`[${when}] ${role}: ${body.replace(/\s*\n\s*/g, ' ⏎ ')}`);
    });

    dlgLines.push(csvRow([key, dtype, isGroup ? 'да' : 'нет', name, phone, cl?.yclients_client_id ?? '',
      cl?.visits_count ?? '', cl?.bonus_balance ?? '', cl?.gender ?? '', channels,
      msk(msgs[0].msg_ts), msk(msgs[msgs.length - 1].msg_ts), msgs.length,
      counts['клиент'], counts['администратор'], counts['Мила (бот)'], counts['авто-уведомление'],
      transcript.join('\n')]));

    jsonDialogs.push({ key, dtype, isGroup, name, phone, channels, counts, transcript });
  }

  const bom = '﻿';
  fs.writeFileSync(path.join(OUT_DIR, 'chat_history_messages.csv'), bom + msgLines.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'chat_history_dialogs.csv'), bom + dlgLines.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'chat_history_dialogs.json'), JSON.stringify(jsonDialogs, null, 1));

  console.log(`диалогов: ${dialogs.size}, сообщений: ${rows.length}`);
  console.log(`имя клиента найдено у: ${jsonDialogs.filter((d) => d.name && !d.isGroup).length} из ${jsonDialogs.filter((d) => !d.isGroup).length} личных диалогов`);
  console.log('→', OUT_DIR);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
