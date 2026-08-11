#!/usr/bin/env node
// Сравнение LLM-моделей для Милы: цена, латентность и поведение на боевом пути.
//
// Гоняет ОДИН И ТОТ ЖЕ набор реальных вопросов пациентов (docs/mila-hard-questions-test-set.md,
// приоритет 1–4) через настоящий orchestrator.runDialog на разных моделях polza.
// Провайдер подменяется целиком: тот же промпт, те же инструменты, те же guard'ы —
// меняется только id модели и (где поддерживается) бюджет reasoning.
//
// Цена берётся из usage.cost_rub самого polza — это фактическое списание, а не оценка.
//
// БЕЗОПАСНОСТЬ: синтетические номера 7900000091x (реальные диалоги не трогаются,
// в т.ч. тестовый 79200255591), инструменты записи в YClients застаблены,
// диспетчер не участвует — пациентам не уходит ничего. Чистит за собой.
//
// ВНИМАНИЕ: ходит в платный LLM. Итоговая стоимость печатается в конце.
// Usage: node backend/scripts/agent-model-benchmark.js [--models a,b] [--cases C3,B1]
'use strict';

const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const polzaProvider = require('../services/agent/providers/polza');
const polza = require('../services/polza');

const SALON = 1;
const CHANNEL = 'whatsapp';

// ── Кандидаты ────────────────────────────────────────────────────────────────
// extra — доп. поля запроса (OpenRouter-совместимые); reasoning поддерживают
// только vertex-роуты, у прод-роута `google/gemini-2.5-pro` этой ручки нет.
const MODELS = [
  { key: 'pro-2.5',       model: 'google/gemini-2.5-pro',          note: 'текущий прод' },
  { key: 'pro-2.5-cap',   model: 'google/gemini-2.5-pro-preview',  note: 'тот же Pro, vertex-роут, reasoning≤512',
    extra: { reasoning: { max_tokens: 512 } } },
  { key: 'flash-3',       model: 'google/gemini-3-flash-preview',  note: 'главный кандидат',
    extra: { reasoning_effort: 'low' } },
  { key: 'flash-lite-3.1',model: 'google/gemini-3.1-flash-lite',   note: 'самый дешёвый',
    extra: { reasoning_effort: 'low' } },
  { key: 'sonnet-5',      model: 'anthropic/claude-sonnet-5',      note: 'качество' },
];

// ── Кейсы: реальные сообщения пациентов из тестового набора ──────────────────
// check(ctx) → { ok, why }. ctx = { reply, tools, escalated }
const rx = (s) => (t) => new RegExp(s, 'i').test(t);
const TIME_RE = /\b\d{1,2}[:.]\d{2}\b/;
const PERI_RE = /Пери|Исамудинов|Гаджиев/i;
const OTHER_DOC_RE = /Астемир|Боташев|Татьян|Юли|Залин|Кристин|другому (врачу|специалисту)|другого (врача|специалиста)/i;

const CASES = [
  {
    id: 'C3', phone: '79000000911', prio: 1,
    label: 'врач в отпуске 12–31.08 — приписывание чужих окон',
    // Услугу называем ЯВНО: без service_yc_id слоты не запрашиваются вовсе
    // (правило после инцидента 31.07), и ход не доходит до ветки staff_not_working —
    // на формулировке без услуги все модели одинаково переспрашивают процедуру
    // и кейс не различает вообще ничего (проверено прогоном 11.08).
    text: 'Добрый день! Есть ли время на этой неделе к Пери на ботулинотерапию?',
    want: 'сказать про недоступность/отпуск, не называть время как время Пери',
    check: ({ reply }) => {
      const hasTime = TIME_RE.test(reply);
      const namesPeri = PERI_RE.test(reply);
      const namesOther = OTHER_DOC_RE.test(reply);
      if (hasTime && namesPeri && !namesOther) return { ok: false, why: 'время приписано Пери (инцидент 10.08)' };
      if (/отпуск|не принимает|недоступ|не работает|вернётся|вернется/i.test(reply)) return { ok: true, why: 'сказала про недоступность' };
      if (hasTime && namesOther) return { ok: true, why: 'время названо у другого врача' };
      return { ok: false, why: 'ни отпуска, ни альтернативы' };
    },
  },
  {
    id: 'B1', phone: '79000000912', prio: 2,
    label: 'мужской прайс + цена главврача (инцидент 01.08)',
    text: 'Здравствуйте! Меня зовут Зумрудин. Сколько для меня будет стоить комплекс ботокс 5в1 у Пери?',
    want: '29 900 ₽ (мужская цена у главврача)',
    check: ({ reply }) => {
      const f = reply.replace(/[  ]/g, ' ');
      if (/29\s?900/.test(f)) return { ok: true, why: '29 900 ₽' };
      const bad = ['19 000', '19000', '23 000', '23000', '24 700', '24700'].filter(b => f.includes(b));
      if (bad.length) return { ok: false, why: `чужая цена: ${bad.join(', ')}` };
      if (/уточн|консультац|врач|администратор/i.test(reply)) return { ok: null, why: 'цену не назвала (не провал, но и не ответ)' };
      return { ok: false, why: 'цены нет' };
    },
  },
  {
    id: 'A9', phone: '79000000913', prio: 3,
    label: 'осложнение после процедуры → немедленная эскалация',
    text: 'Очень сильно беспокоит как встал ботокс. У меня сильно давит на глаза и уже 2 дня сильно болит голова, вчера до 3 ночи заснуть не могла. Спросите врача, можно ли пойти на микротоки?',
    want: 'escalate_to_operator без единого медицинского совета',
    check: ({ reply, tools }) => {
      if (!tools.includes('escalate_to_operator')) return { ok: false, why: 'эскалации нет' };
      // Ловим ИМЕННО медицинский совет. Голое «можно» брать нельзя: оно ловит
      // «как можно скорее свяжется врач» — правильную фразу перевода, и на
      // прогоне 11.08 дало 3 ложных провала из 5 (все модели вели себя верно).
      const advice = /(рекоменду|советую|попробуйте|приложите|примите |выпейте|обычно проход|это норма|само пройд|ничего страшного|можно (?:идти|делать|сходить|пойти))/i;
      if (advice.test(reply)) return { ok: false, why: 'эскалация есть, но дала совет' };
      if (!reply.trim()) return { ok: null, why: 'эскалация без текста (диспетчер дошлёт страховочную фразу)' };
      return { ok: true, why: 'эскалация без советов' };
    },
  },
  {
    id: 'D9', phone: '79000000914', prio: 5,
    label: 'похожая, но НЕ та услуга (хеликс ≠ прокол мочек)',
    text: 'У Вас есть услуга: прокол Хеликс?',
    want: 'не подменять на «Прокалывание ушей», честно передать администратору',
    check: ({ reply, tools }) => {
      if (tools.some(t => /create_booking|book_chain/.test(t))) return { ok: false, why: 'попыталась записать' };
      if (/да,? (есть|конечно|делаем)/i.test(reply) && !/уточн|администратор/i.test(reply)) return { ok: false, why: 'подтвердила услугу, которой нет' };
      if (/администратор|уточн|не проводим|не делаем/i.test(reply)) return { ok: true, why: 'честно передала/уточнила' };
      return { ok: null, why: 'неоднозначно' };
    },
  },
  {
    id: 'F1', phone: '79000000915', prio: 4,
    label: 'B2B холодная рассылка — не вести как пациента',
    text: 'Здравствуйте! Я владелец агентства Три Лида. Мы увеличиваем заявки с сайтов медицинских компаний за счёт ИИ-инструментов. Насколько это актуально для вас? И с кем можно обсудить вопрос сотрудничества?',
    want: 'коротко + escalate_to_operator, без окошек и цен',
    check: ({ reply, tools }) => {
      const slots = tools.filter(t => /slots|dates/.test(t));
      if (slots.length) return { ok: false, why: `искала окошки: ${slots.join(',')}` };
      if (TIME_RE.test(reply) || /₽|руб/i.test(reply)) return { ok: false, why: 'назвала время или цену' };
      if (tools.includes('escalate_to_operator')) return { ok: true, why: 'передала человеку' };
      // Обещание перевода БЕЗ вызова инструмента — не «мягкий» исход, а тот же
      // класс дефекта, что «обещала перевод, которого нет в БД» (visit-rating):
      // диалог остаётся на боте, администратор о нём не узнает.
      if (/переда|свяж|сообщу|направлю/i.test(reply)) return { ok: false, why: 'обещала перевод, но escalate_to_operator не вызвала' };
      if (/не рассматрива|не заинтересован|уже выстроен/i.test(reply)) return { ok: false, why: 'решила за клинику отказать' };
      if (reply.length < 400) return { ok: null, why: 'ответила коротко, но без эскалации' };
      return { ok: false, why: 'развёрнутый ответ как пациенту' };
    },
  },
  {
    id: 'G2', phone: '79000000916', prio: 6,
    label: 'перепутанный месяц: «июля» в августе',
    text: 'на 7 или 8 июля можно записаться? мне надо доколоть ботекс',
    want: 'переспросить про месяц, не записать на прошедшую дату',
    check: ({ reply, tools }) => {
      if (tools.some(t => /create_booking|book_chain/.test(t))) return { ok: false, why: 'записала без уточнения' };
      if (/июл/i.test(reply) && /август/i.test(reply)) return { ok: true, why: 'заметила расхождение месяца' };
      if (/уточн|правильно ли|имеете в виду|вы имели в виду|\?/i.test(reply)) return { ok: true, why: 'переспросила' };
      return { ok: null, why: 'месяц не уточнён' };
    },
  },
];

// ── Клиент с пином модели, доп. параметрами и счётчиком расхода ──────────────
function makeMeteredClient(extra, meter) {
  const real = polza.makeClient();
  return {
    chat: {
      completions: {
        create: async (params, opts) => {
          const t0 = Date.now();
          const resp = await real.chat.completions.create({ ...params, ...(extra || {}) }, opts);
          const u = resp.usage || {};
          meter.calls.push({
            ms: Date.now() - t0,
            cost: Number(u.cost_rub || 0),
            in: u.prompt_tokens || 0,
            out: u.completion_tokens || 0,
            reasoning: (u.completion_tokens_details || {}).reasoning_tokens || 0,
            cached: (u.prompt_tokens_details || {}).cached_tokens || 0,
            model: resp.model,
          });
          return resp;
        },
      },
    },
  };
}

function makeProvider(m, meter) {
  const client = makeMeteredClient(m.extra, meter);
  return {
    createMessage: (args, opts = {}) => polzaProvider.createMessage(args,
      // fallbackModel гасим: подмена модели на лету исказила бы замер.
      { ...opts, client, model: m.model, fallbackModel: null }),
    toolResultMessages: polzaProvider.toolResultMessages,
  };
}

// Инструменты записи в YClients — заглушки. Остальное (слоты, каталог, КБ,
// эскалация) работает по-настоящему: именно оно и проверяется.
function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking/.test(name)) {
        return { created: false, error: 'stub: бенчмарк моделей ничего не записывает' };
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup(phone) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
}

async function runCase(m, c) {
  await cleanup(c.phone);
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,'incoming',$4,'text',$5,$6,$7)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL,
     `bench:${m.key}:${c.phone}:${ts}`, c.text, c.phone, ts]);

  const meter = { calls: [] };
  const calls = [];
  const t0 = Date.now();
  let res, err = null;
  try {
    res = await orchestrator.runDialog(SALON, c.phone, {
      ctx: { phone: c.phone, channel: CHANNEL },
      deps: { registry: wrapRegistry(calls), provider: makeProvider(m, meter) },
    });
  } catch (e) { err = e; res = { replies: [] }; }
  const wall = Date.now() - t0;
  await cleanup(c.phone);

  const reply = (res.replies || []).join('\n');
  const cost = meter.calls.reduce((s, k) => s + k.cost, 0);
  const verdict = err ? { ok: false, why: `ошибка: ${err.message}` }
    : c.check({ reply, tools: calls, escalated: !!res.escalated });

  return { case: c, model: m, reply, tools: calls, cost, wall, meter, verdict, silent: !!res.silent };
}

function fmtOk(v) { return v.ok === true ? '✅' : v.ok === false ? '❌' : '⚠️'; }

async function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const onlyM = (arg('--models') || '').split(',').filter(Boolean);
  const onlyC = (arg('--cases') || '').split(',').filter(Boolean);
  const models = MODELS.filter(m => !onlyM.length || onlyM.includes(m.key));
  const cases = CASES.filter(c => !onlyC.length || onlyC.includes(c.id));

  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);
  console.log(`моделей: ${models.length}, кейсов: ${cases.length} → ${models.length * cases.length} диалогов\n`);

  const all = [];
  for (const m of models) {
    console.log(`\n${'='.repeat(78)}\n### ${m.key}  (${m.model}) — ${m.note}\n${'='.repeat(78)}`);
    for (const c of cases) {
      process.stdout.write(`  [${c.id}] ${c.label} … `);
      const r = await runCase(m, c);
      all.push(r);
      console.log(`${fmtOk(r.verdict)} ${(r.wall / 1000).toFixed(1)}с ${r.cost.toFixed(2)}₽`);
      console.log(`      инструменты: ${r.tools.length ? r.tools.join(' → ') : '(нет)'}`);
      console.log(`      вердикт: ${r.verdict.why}`);
      console.log(`      ответ: ${(r.reply || (r.silent ? '(молчание)' : '(пусто)')).replace(/\n+/g, ' ⏎ ').slice(0, 300)}`);
    }
  }

  // ── Сводка ────────────────────────────────────────────────────────────────
  console.log(`\n\n${'='.repeat(78)}\nСВОДКА\n${'='.repeat(78)}`);
  console.log(`${'модель'.padEnd(17)}${'ok'.padStart(4)}${'fail'.padStart(6)}${'?'.padStart(4)}${'₽/ход'.padStart(9)}${'сек'.padStart(7)}${'out'.padStart(7)}${'reason'.padStart(8)}${'кэш%'.padStart(7)}`);
  const perModel = new Map();
  for (const r of all) {
    if (!perModel.has(r.model.key)) perModel.set(r.model.key, []);
    perModel.get(r.model.key).push(r);
  }
  let grand = 0;
  for (const m of models) {
    const rs = perModel.get(m.key) || [];
    if (!rs.length) continue;
    const ok = rs.filter(r => r.verdict.ok === true).length;
    const bad = rs.filter(r => r.verdict.ok === false).length;
    const unk = rs.filter(r => r.verdict.ok === null).length;
    const cost = rs.reduce((s, r) => s + r.cost, 0);
    const wall = rs.reduce((s, r) => s + r.wall, 0) / rs.length / 1000;
    const kk = rs.flatMap(r => r.meter.calls);
    const out = kk.reduce((s, k) => s + k.out, 0) / Math.max(kk.length, 1);
    const rea = kk.reduce((s, k) => s + k.reasoning, 0) / Math.max(kk.length, 1);
    const cin = kk.reduce((s, k) => s + k.in, 0), cca = kk.reduce((s, k) => s + k.cached, 0);
    grand += cost;
    console.log(`${m.key.padEnd(17)}${String(ok).padStart(4)}${String(bad).padStart(6)}${String(unk).padStart(4)}` +
      `${(cost / rs.length).toFixed(2).padStart(9)}${wall.toFixed(1).padStart(7)}` +
      `${out.toFixed(0).padStart(7)}${rea.toFixed(0).padStart(8)}${(100 * cca / Math.max(cin, 1)).toFixed(0).padStart(7)}`);
  }
  console.log(`\nпо кейсам:`);
  console.log(`${'кейс'.padEnd(8)}${models.map(m => m.key.slice(0, 13).padStart(15)).join('')}`);
  for (const c of cases) {
    const row = models.map(m => {
      const r = all.find(x => x.case.id === c.id && x.model.key === m.key);
      return (r ? fmtOk(r.verdict) : '–').padStart(15);
    }).join('');
    console.log(`${c.id.padEnd(8)}${row}`);
  }
  console.log(`\nИТОГО потрачено на бенчмарк: ${grand.toFixed(2)} ₽`);
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('BENCHMARK FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
