'use strict';
// ============================================================
// Правила уведомлений: условия по специалисту/категории/услугам, каскад каналов,
// карта услуга → категория, последний входящий канал клиента.
// Переезд из services/notifications.js (v1) БЕЗ изменений поведения — этим
// пользуются «Забота», напоминания и followup Милы через фасад.
// Новое здесь одно — lastConversation (адресаты каскада мессенджеров, cascade.js).
// Фасад из этой папки НЕ импортируем: он сам импортирует нас (цикл).
// ============================================================
const { db } = require('../../db');
const chatpush = require('../chatpush');
const { ycGet } = require('../yclients');
const { canonPhone } = require('./cascade');
const { isGroupChatId } = require('../agent/group-chat');

// Значения dispatch_routing Chatpush, которые разрешаем в правиле.
const ALLOWED_CHANNELS = ['telegram', 'whatsapp', 'tdlib', 'max', 'max_bot', 'notify'];

/**
 * Оценить условия правила против контекста записи.
 * conditions = { logic:'and'|'or', items:[{type:'staff'|'category'|'service', ids:[…]}] }
 * ctx = { staffId, serviceIds:[], categoryIds:[] } (все id — числа или строки)
 * Пустой items ⇒ true (правило на любую запись). Внутри условия — ИЛИ по ids.
 */
function evaluateRule(conditions, ctx) {
  const items = Array.isArray(conditions && conditions.items) ? conditions.items : [];
  if (!items.length) return true;
  const logic = conditions.logic === 'or' ? 'or' : 'and';

  const has = (list, ids) => {
    const set = new Set((ids || []).map(String));
    return (list || []).some(v => set.has(String(v)));
  };
  const results = items.map(it => {
    if (!it || !Array.isArray(it.ids) || !it.ids.length) return true; // пустое условие не ограничивает
    switch (it.type) {
      case 'staff':    return has([ctx.staffId], it.ids);
      case 'category': return has(ctx.categoryIds, it.ids);
      case 'service':  return has(ctx.serviceIds, it.ids);
      default:         return false; // неизвестный тип условия не должен «пропускать всё»
    }
  });
  return logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** '2026-08-02 14:00:00' → { date:'02.08.2026', time:'14:00' } (строка YClients уже салон-локальная). */
function splitVisitDatetime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { date: '', time: '' };
  return { date: `${m[3]}.${m[2]}.${m[1]}`, time: `${m[4]}:${m[5]}` };
}

/**
 * Каскад каналов для отправки: последний входящий канал клиента (если известен и
 * prefer_last_channel) ставится первым, остальные каналы правила — следом как
 * страховка. Неизвестные значения отбрасываются.
 */
function resolveRouting(ruleChannels, preferLastChannel, lastChannel) {
  const base = (Array.isArray(ruleChannels) ? ruleChannels : [])
    .filter(c => ALLOWED_CHANNELS.includes(c));
  const routing = base.length ? base : ['telegram', 'whatsapp'];
  if (preferLastChannel && lastChannel && ALLOWED_CHANNELS.includes(lastChannel)) {
    return [lastChannel, ...routing.filter(c => c !== lastChannel)];
  }
  return routing;
}

// ── маппинг услуга → категория (кэш) ───────────────────────────
//
// Категорий в payload записи нет (только services[].id) — маппинг
// serviceId → categoryId строится из booking-каталога YClients (полный список,
// без фильтра по цене) и кэшируется в памяти.

const _catMapCache = {};             // salonId → { ts, map: Map<serviceIdStr, categoryIdStr> }
const CAT_MAP_TTL = 10 * 60 * 1000;

async function getServiceCategoryMap(salon) {
  const cached = _catMapCache[salon.id];
  if (cached && Date.now() - cached.ts < CAT_MAP_TTL) return cached.map;
  const cid = salon.yclients_company_id;
  const map = new Map();
  if (cid) {
    const raw = await ycGet(salon, `/services/${cid}`).catch(() => null);
    for (const s of (Array.isArray(raw) ? raw : [])) {
      if (s && s.id != null && s.category_id != null) map.set(String(s.id), String(s.category_id));
    }
  }
  if (map.size) _catMapCache[salon.id] = { ts: Date.now(), map }; // сбой каталога не кэшируем
  return map;
}

// ── последний входящий канал клиента ───────────────────────────

/** Последний канал, из которого клиент нам писал (значение dispatch_routing) или null. */
async function lastIncomingChannel(salonId, phone) {
  const row = await db.oneOrNone(
    `SELECT channel FROM chatpush_messages
      WHERE salon_id = $1 AND phone = $2 AND direction = 'incoming'
      ORDER BY msg_ts DESC NULLS LAST
      LIMIT 1`,
    [salonId, phone]
  );
  return row ? chatpush.replyRoutingFor(row.channel) : null;
}

/**
 * Что известно о переписке с клиентом: мессенджер, из которого он писал
 * последним (только входящие — наши же уведомления не должны сами себя
 * продвигать), и id личных чатов Telegram/MAX по этому номеру (адресация при
 * скрытом номере). Номер ищется во всех формах, в которых он лежит в
 * chatpush_messages.
 *
 * Группы в chats не попадают. SQL отсекает их ДО DISTINCT ON: иначе свежее
 * сообщение участника в рабочей группе (там phone = номер УЧАСТНИКА) вытеснило
 * бы его личный чат. Общий признак agent/group-chat.isGroupChatId — последнее
 * слово: он шире SQL (WhatsApp-jid @g.us/@broadcast), и своей копии правила тут
 * нет. Индекс — idx_chatpush_messages_dialog (salon_id, phone, msg_ts DESC).
 */
async function lastConversation(salonId, phone) {
  const canon = canonPhone(phone);
  if (!canon) return { lastChannel: null, chats: {} };
  const p10 = canon.slice(1);
  const forms = ['7' + p10, '+7' + p10, '8' + p10, p10];
  const rows = await db.any(
    `SELECT DISTINCT ON (channel) channel, chat_id
       FROM chatpush_messages
      WHERE salon_id = $1 AND phone = ANY($2)
        AND channel IN ('tdlib','max') AND COALESCE(chat_id,'') <> ''
        AND chat_id NOT LIKE '-%' AND chat_id NOT LIKE 'g:%'
      ORDER BY channel, msg_ts DESC NULLS LAST`,
    [salonId, forms]);
  const chats = {};
  for (const r of rows) {
    if (!isGroupChatId(r.chat_id)) chats[r.channel] = r.chat_id;
  }
  const last = await db.oneOrNone(
    `SELECT channel FROM chatpush_messages
      WHERE salon_id = $1 AND phone = ANY($2) AND direction = 'incoming'
      ORDER BY msg_ts DESC NULLS LAST LIMIT 1`,
    [salonId, forms]);
  return { lastChannel: last ? chatpush.replyRoutingFor(last.channel) : null, chats };
}

module.exports = {
  evaluateRule,
  resolveRouting,
  ALLOWED_CHANNELS,
  getServiceCategoryMap,
  lastIncomingChannel,
  lastConversation,
  splitVisitDatetime,
};
