#!/usr/bin/env node
'use strict';

// Offline/LLM evaluation prompt-v2. Все сообщения синтетические; скрипт не
// обращается к БД, ChatPush, YClients и не исполняет tool_calls. --live делает
// только запросы к настроенному LLM-провайдеру и потому требует явного флага.
const { getProvider } = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const { buildSystemPromptV2 } = require('../services/agent/system-prompt-v2');
const { measurePrompt } = require('../services/agent/prompt-metrics');

const CASES = [
  { id: 'booking-price', text: 'Сколько стоит чистка и можно записаться завтра?' },
  { id: 'medical-urgent', text: 'После процедуры сильный отёк и боль, что делать?' },
  { id: 'reschedule', text: 'Перенесите, пожалуйста, мою запись на пятницу.' },
];

function getArg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] || fallback : fallback;
}

async function main() {
  const live = process.argv.includes('--live');
  const providerName = getArg('--provider');
  const model = getArg('--model');
  const provider = getProvider(providerName);

  for (const test of CASES) {
    const system = buildSystemPromptV2({
      salonName: 'Тестовая клиника', workingHours: '09:00–21:00',
      today: '2026-08-19', now: '12:00', lastUserText: test.text,
    });
    const metrics = measurePrompt(system);
    console.log(`${test.id}: ${metrics.chars} символов (~${metrics.estimatedTokens} токенов)`);
    if (!live) continue;

    const result = await provider.createMessage({
      system,
      messages: [{ role: 'user', content: test.text }],
      // Схемы позволяют проверить выбор следующего действия, но tool_calls здесь
      // намеренно НИКОГДА не исполняются.
      tools: registry.catalogMode.schemas,
    }, { model });
    console.log(JSON.stringify({
      id: test.id,
      reply: result.text,
      toolCalls: (result.toolCalls || []).map(call => call.name),
    }));
  }
}

main().catch(err => {
  console.error(`agent-prompt-v2-eval: ${err.message}`);
  process.exitCode = 1;
});
