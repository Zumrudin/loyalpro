#!/usr/bin/env node
'use strict';
// ============================================================
// Сид правил автоуведомлений салона из выгрузки Chatpush
// (docs/notifications/chatpush-templates-2026-10-13.md) через боевой API
// /api/notification-rules — ту же валидацию и те же файлы, что и админка.
//
//   node scripts/notifications-seed-templates.js --salon=1 [--base=http://127.0.0.1:3001] [--dry]
//
// Что делает:
//  • минтит JWT владельца салона и строку sessions (как scripts/reminders-ui-e2e.js), в конце удаляет её;
//  • создаёт 7 основных правил (тексты — дословно из выгрузки, даты/время — плейсхолдерами);
//  • создаёт правила «Рекомендации после процедуры» по направлениям: 6 с картинками из
//    frontend/uploads/notify_seed/ (загружаются POST /:id/attachment — файл копируется в
//    /uploads/notify_<салон>_<правило>_<ts>.jpg) и 3 ВЫКЛЮЧЕННЫХ без картинки (Липолитики, Volnewmer,
//    Morpheus 8 — оригиналы от салона не получены, см. выгрузку);
//  • ставит текст отбивки на оценку 5 (ссылки на отзывы + 500 бонусов) — остальные тексты настроек
//    совпадают с дефолтами модуля. РЕЖИМ (off/shadow/live) НЕ ТРОГАЕТ.
// Идемпотентность: правило с таким же title у салона уже есть → пропуск (вложение не перезаливается).
// Условия «Рекомендаций» — по услугам YClients; id сверены с визитами, по которым Chatpush реально слал
// каждую картинку (chatpush_messages × records за 07–10.2026), плюс услуги того же направления по названию.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const SALON_ID = Number(args.salon || 1);
const BASE = String(args.base || process.env.E2E_BASE || 'http://127.0.0.1:3001');
const DRY = !!args.dry;
const SEED_DIR = path.join(__dirname, '../../frontend/uploads/notify_seed');

const ADDRESS = 'По адресу: ул. Генерала Белова, 28 корпус 3';
const CLINIC = 'Клиника Эстетической Медицины «PERI CLINIC»';
const PHONE = 'Телефон: +79250177778';

// ── основные правила (тексты из выгрузки Chatpush, числа → плейсхолдеры) ──
const MAIN_RULES = [
  {
    title: 'Запись создана — «Вы записаны на прием»',
    triggerType: 'record_created',
    messageTemplate: `Вы записаны на прием {date} {time} в «PERI CLINIC».\n${ADDRESS}\n${CLINIC}.\n${PHONE}`,
  },
  {
    title: 'Напоминание за 24 часа с подтверждением',
    triggerType: 'visit_reminder',
    hoursBefore: 24,
    askConfirmation: true,
    messageTemplate: `Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись {date} в {time}\n${ADDRESS}\n${CLINIC}\nПожалуйста, подтвердите визит`,
  },
  {
    title: 'Запись перенесена',
    triggerType: 'record_rescheduled',
    messageTemplate: `Ваша запись в «PERI CLINIC» перенесена.\nНовое время записи {date} в {time}\n${ADDRESS}\n${CLINIC}\n${PHONE}`,
  },
  {
    title: 'Запись отменена («клиент не придёт»)',
    triggerType: 'record_cancelled',
    onNoShow: true,
    messageTemplate: `❌ Ваша запись в «PERI CLINIC»\n{date} в {time} отменена🙁\nМы очень надеемся, что Вы все же сможете посетить нас в будущем☺️\nС заботой о Вас ${CLINIC}.\n${PHONE}`,
  },
  {
    title: 'Опрос после визита (оценка 2–5)',
    triggerType: 'visit_review',
    delayMinutes: 5,
    messageTemplate: 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5, где\n2- Вы совершенно недовольны визитом\n3- больше минусов, чем плюсов\n4- были мелкие недочеты, но в целом всё Ок\n5- все отлично',
  },
  {
    title: 'Первый визит — приглашение в программу лояльности',
    triggerType: 'first_visit',
    messageTemplate: 'Присоединяйтесь к программе лояльности PERI CLINIC и получайте приветственные бонусы уже на первый визит! Копите кешбэк с каждой процедуры и пользуйтесь привилегиями постоянного клиента по ссылке: https://www.peri-clinic.ru/loyaltyprogram',
  },
];

// ── «Рекомендации после процедуры» по направлениям ──
// Сопоставление картинка → услуги: по визитам, за которыми Chatpush слал именно эту картинку
// (chatpush_messages × records), дополнено услугами того же направления по названию.
const AFTER_TEXT = 'Рекомендации после процедуры';
const AFTER_RULES = [
  {
    title: 'Рекомендации — Ботулинотерапия',
    file: 'Ботулинотерапия.jpg',
    match: (s) => /^ботулинотерапия|миотокс|botox|^муж\. (комплекс 5в1|кончик носа|коррекция нижней|крылья носа|лечение гипергидроза|лечение десневой|лифтинг бровей|лоб\+межбровье|межбровье|подбородок|поднятие уголков|спинка носа|уголки глаз|шея)/i.test(s.title)
      || /^5в1лоб/i.test(s.title) || /лечение гипергидроза 1 зона/i.test(s.title),
  },
  {
    title: 'Рекомендации — Биоревитализация, мезотерапия, коллаген, плазма',
    file: 'Био-Мезо-Коллаген-Плазма.jpg',
    categories: ['15394164'], // Коллагенотерапия целиком
    match: (s) => /^revi |^profhilo|^meso|^мезотерапия|^биоревитализация|плазмолифтинг|плазмотерапия|xantin|wharton|экзосом|curacen|bellarti|jalupro|novacutan|hialrepair|hyalrepair|viscoderm|plinest|skinko|ialest|asce|nithia|hairfiller/i.test(s.title),
  },
  {
    title: 'Рекомендации — Фотоомоложение',
    file: 'Фотоомоложение.jpg',
    match: (s) => /^фотоомоложение/i.test(s.title),
  },
  {
    title: 'Рекомендации — Чистка лица',
    file: 'Комбинированная_чистка_лица.jpg',
    match: (s) => /чистк/i.test(s.title),
  },
  {
    title: 'Рекомендации — Пилинг',
    file: 'Пилинг.jpg',
    match: (s) => (/пилинг|пиллинг|peel|enerpeel|милайн|m\.e\. line/i.test(s.title)) && !/^процедура hydrafacial \(гидропилинг\+уход\)/i.test(s.title),
  },
  {
    title: 'Рекомендации — Полимолочная кислота',
    file: 'Полимолочная_кислота.jpg',
    categories: ['28053996'], // Полимолочная кислота
    match: () => false,
  },
  // Картинок нет (подписанные ссылки Chatpush протухли, оригиналы от салона не получены) — правила
  // создаются ВЫКЛЮЧЕННЫМИ, чтобы салону осталось только загрузить картинку и включить.
  {
    title: 'Рекомендации — Липолитики (НЕТ КАРТИНКИ: загрузить и включить)',
    file: null, isEnabled: false,
    match: (s) => /липолитич/i.test(s.title),
  },
  {
    title: 'Рекомендации — Volnewmer (НЕТ КАРТИНКИ: загрузить и включить)',
    file: null, isEnabled: false,
    categories: ['18845024'], match: () => false,
  },
  {
    title: 'Рекомендации — Morpheus 8 (НЕТ КАРТИНКИ: загрузить и включить)',
    file: null, isEnabled: false,
    match: (s) => /^morpheus/i.test(s.title),
  },
];

const RATING_HIGH_TEXT = 'Спасибо за отличную оценку нашей работы! 🙏🏻\nМы были бы очень благодарны за отзыв о нас\nЯндекс https://ya.cc/t/L67_91Vl3BR3eb\n2ГИС https://clck.ru/332Ls5\nЗа опубликованный отзыв дарим 500 бонусов по программе лояльности!🌹';

async function api(token, method, url, body, { form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = $1 ORDER BY (role='owner') DESC, id LIMIT 1`, [SALON_ID]);
  if (!user) throw new Error(`нет owner/admin в салоне ${SALON_ID}`);
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role }, config.JWT_SECRET, { expiresIn: '30m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'notifications-seed', NOW() + INTERVAL '30 minutes')`, [user.id, token]);
  const report = { created: [], skipped: [], attachments: [], settings: null };
  try {
    const dicts = await api(token, 'GET', '/api/notification-rules/dictionaries');
    const existing = (await api(token, 'GET', '/api/notification-rules/')).rules || [];
    const byTitle = new Map(existing.map((r) => [r.title, r]));

    const createRule = async (body) => {
      if (byTitle.has(body.title)) { report.skipped.push(body.title); return byTitle.get(body.title); }
      if (DRY) { report.created.push(`${body.title} [dry]`); return null; }
      const r = await api(token, 'POST', '/api/notification-rules/', body);
      report.created.push(`#${r.rule.id} ${body.title}`);
      return r.rule;
    };

    for (const r of MAIN_RULES) await createRule({ conditions: { logic: 'and', items: [] }, ...r });

    for (const r of AFTER_RULES) {
      const serviceIds = dicts.services.filter(r.match).map((s) => s.id);
      const items = [];
      if (r.categories && r.categories.length) items.push({ type: 'category', ids: r.categories.map(Number) });
      if (serviceIds.length) items.push({ type: 'service', ids: serviceIds });
      if (!items.length) throw new Error(`${r.title}: ни одной услуги/категории не сопоставлено`);
      const body = {
        title: r.title, triggerType: 'visit_after', delayMinutes: 5, messageTemplate: AFTER_TEXT,
        // Категория ИЛИ услуга: у Коллагенотерапии/Полимолочной — целая категория плюс отдельные услуги других категорий.
        conditions: { logic: 'or', items },
        isEnabled: r.isEnabled !== false,
      };
      console.log(`  ${r.title}: услуг ${serviceIds.length}${r.categories ? `, категорий ${r.categories.length}` : ''}`);
      const rule = await createRule(body);
      if (!rule || !r.file || rule.attachment_url) continue;
      const abs = path.join(SEED_DIR, r.file);
      if (!fs.existsSync(abs)) { report.attachments.push(`${r.title}: файла ${r.file} нет`); continue; }
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(abs)], { type: 'image/jpeg' }), r.file);
      const up = await api(token, 'POST', `/api/notification-rules/${rule.id}/attachment`, undefined, { form });
      report.attachments.push(`#${rule.id} ${r.file} → ${up.attachmentUrl}`);
    }

    const cfg = await api(token, 'GET', '/api/notification-rules/settings');
    if (cfg.rating_high_text !== RATING_HIGH_TEXT) {
      if (!DRY) await api(token, 'PUT', '/api/notification-rules/settings', { rating_high_text: RATING_HIGH_TEXT });
      report.settings = 'rating_high_text обновлён (ссылки на отзывы + 500 бонусов); режим не тронут: ' + cfg.mode;
    } else report.settings = 'rating_high_text уже актуален; режим: ' + cfg.mode;
  } finally {
    await db.query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
  }
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
