#!/usr/bin/env node
'use strict';

// Локальный baseline системного промпта Милы. Только синтетические значения:
// не читает БД, переписку, CRM и не вызывает LLM.
const { buildSystemPrompt } = require('../services/agent/system-prompt');
const { buildSystemPromptV2 } = require('../services/agent/system-prompt-v2');
const { measurePrompt } = require('../services/agent/prompt-metrics');

const BASE = {
  salonName: 'Тестовая клиника',
  workingHours: '09:00–21:00',
  today: '2026-08-19',
  now: '12:00',
};

const CATALOG = [
  'КАТАЛОГ УСЛУГ КЛИНИКИ (синтетический):',
  'Мастера: 1=Анна',
  '10|Тестовая услуга|60|5000|Тестовое направление|1',
].join('\n');

const variants = {
  core: buildSystemPrompt(BASE),
  v2Core: buildSystemPromptV2({ ...BASE, lastUserText: 'Здравствуйте' }),
  catalog: buildSystemPrompt({ ...BASE, catalogBlock: CATALOG }),
  v2Catalog: buildSystemPromptV2({ ...BASE, catalogBlock: CATALOG, lastUserText: 'Сколько стоит услуга?' }),
  volatile: buildSystemPrompt({
    ...BASE,
    catalogBlock: CATALOG,
    firstContact: true,
    activeOffers: ['o1 — 20.08: 10:00 «Тестовая услуга» (Анна)'],
    toolMemory: ['get_available_slots: на 20.08 показано 10:00'],
    liveBookings: ['20.08 10:00 — Тестовая услуга'],
    leadingClinic: ['Напоминание о визите'],
    promoBlock: 'Тестовое предложение месяца',
  }),
  v2Volatile: buildSystemPromptV2({
    ...BASE,
    catalogBlock: CATALOG,
    firstContact: true,
    activeOffers: ['o1 — 20.08: 10:00 «Тестовая услуга» (Анна)'],
    toolMemory: ['get_available_slots: на 20.08 показано 10:00'],
    liveBookings: ['20.08 10:00 — Тестовая услуга'],
    leadingClinic: ['Напоминание о визите'],
    promoBlock: 'Тестовое предложение месяца',
    lastUserText: 'Сколько стоит услуга и можно записаться завтра?',
  }),
};

const result = Object.fromEntries(Object.entries(variants)
  .map(([name, prompt]) => [name, measurePrompt(prompt)]));

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  for (const [name, metrics] of Object.entries(result)) {
    console.log(`${name}: ${metrics.chars} символов, ${metrics.lines} строк, ` +
      `${metrics.headings} заголовков, ~${metrics.estimatedTokens} токенов`);
  }
}
