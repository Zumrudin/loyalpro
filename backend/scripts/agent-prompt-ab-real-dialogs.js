#!/usr/bin/env node
'use strict';

// Privacy-safe A/B первого LLM-хода на реальных диалогах.
// - читает не более пяти последних личных текстовых диалогов текущего salon_id;
// - отправляет транскрипт только настроенному production LLM-провайдеру;
// - НИКОГДА не исполняет tool_call, не меняет БД, CRM или ChatPush;
// - печатает только обезличенные метрики, типы ответов и имена выбранных tools.
// Запуск требует явного --live. Сырые тексты пациентов и ответы не логируются.

const { db, pool } = require('../db');
const fs = require('fs');
const config = require('../config');
const history = require('../services/agent/history');
const catalogBlock = require('../services/agent/catalog-block');
const registry = require('../services/agent/tools');
const polza = require('../services/polza');
const provider = require('../services/agent/providers/polza');
const { buildSystemPrompt } = require('../services/agent/system-prompt');
const { buildSystemPromptV2 } = require('../services/agent/system-prompt-v2');
const { detectPromptScenarios } = require('../services/agent/prompt-scenarios');

const MAX_DIALOGS = 5;

function readPositiveIntegerArg(name, fallback, max) {
  const prefix = `--${name}=`;
  const value = process.argv.find(arg => arg.startsWith(prefix));
  if (!value) return fallback;
  const parsed = Number(value.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`--${name} должен быть целым числом от 1 до ${max}`);
  }
  return parsed;
}

function safeToolNames(calls) {
  return (calls || []).map(call => call.name).filter(Boolean).slice(0, 4);
}

function withoutQuality(result) {
  const { _quality, ...publicResult } = result;
  return publicResult;
}

function responseKind(result) {
  const text = String(result.text || '').trim();
  const tools = safeToolNames(result.toolCalls);
  if (tools.length) return `tool:${tools.join(',')}`;
  if (!text) return 'empty';
  if (/escalate_to_operator|администратор/i.test(text)) return 'handover-text';
  return 'text';
}

// Эти признаки намеренно детерминированные: в отчёт не попадает сам текст
// пациента или модели, но можно увидеть базовые ошибки качества первого хода.
function qualitySignals(result, scenarios) {
  const tools = safeToolNames(result.toolCalls);
  const medical = scenarios.includes('medical');
  const booking = scenarios.includes('booking') || scenarios.includes('manage_booking');
  return {
    responsePresent: Boolean(result.hasText || tools.length),
    selectedTool: tools.length > 0,
    // Явная утечка внутренней терминологии в текст для пациента.
    internalJargon: !!result.internalJargon,
    // Для медицинских и осложнённых запросов безопасный первый шаг — передача
    // человеку. Мы не утверждаем, что это единственный критерий качества.
    expectedSafetyAction: medical ? tools.includes('escalate_to_operator') : null,
    expectedBookingAction: booking ? (tools.length > 0 || result.hasText) : null,
  };
}

function makeMeteredClient(meter) {
  const real = polza.makeClient();
  return {
    chat: { completions: { create: async (params, opts) => {
      const response = await real.chat.completions.create(params, opts);
      const usage = response.usage || {};
      meter.cost = Number(usage.cost_rub || 0);
      meter.input = Number(usage.prompt_tokens || 0);
      meter.output = Number(usage.completion_tokens || 0);
      return response;
    } } },
  };
}

async function selectDialogs(salonId, limit, offset) {
  // Последняя строка должна быть входящим текстом, иначе это не ход агента.
  // Группы отсекаем теми же общеизвестными маркерами, что group-chat gate.
  return db.any(
    `WITH latest AS (
       SELECT DISTINCT ON (COALESCE(NULLIF(phone,''), chat_id))
              COALESCE(NULLIF(phone,''), chat_id) AS dialog_key, phone,
              direction, msg_type, text, msg_ts AS last_ts
         FROM chatpush_messages
        WHERE salon_id=$1
          AND COALESCE(NULLIF(phone,''), chat_id) IS NOT NULL
          AND COALESCE(chat_id,'') NOT LIKE '%@g.us'
          AND COALESCE(chat_id,'') NOT LIKE '%@broadcast'
          AND COALESCE(chat_id,'') NOT LIKE 'g:%'
        ORDER BY COALESCE(NULLIF(phone,''), chat_id), msg_ts DESC, id DESC
     )
     SELECT dialog_key, phone
       FROM latest
      WHERE direction='incoming' AND msg_type='text'
        AND text IS NOT NULL AND char_length(trim(text)) BETWEEN 3 AND 800
      ORDER BY last_ts DESC NULLS LAST
      LIMIT $2 OFFSET $3`,
    [salonId, limit, offset]);
}

async function call(version, opts, messages) {
  const meter = {};
  const system = version === 'v2' ? buildSystemPromptV2(opts) : buildSystemPrompt(opts);
  const result = await provider.createMessage({
    system, messages,
    // Схемы оставлены настоящими: измеряем правильность первого решения модели.
    // Исполнителя ниже НЕТ, поэтому ни одного действия во внешних системах не будет.
    tools: registry.catalogMode.schemas,
  }, { client: makeMeteredClient(meter), fallbackModel: null });
  const text = String(result.text || '').trim();
  return {
    kind: responseKind(result),
    tools: safeToolNames(result.toolCalls),
    chars: text.length,
    costRub: meter.cost || 0,
    inputTokens: meter.input || 0,
    outputTokens: meter.output || 0,
    _quality: {
      hasText: Boolean(text),
      toolCalls: result.toolCalls,
      internalJargon: /\b(?:tool[_ -]?call|system prompt|инструмент(?:а|ы|ов)?\s+(?:агента|модели)|системн(?:ый|ого) промпт)\b/i.test(text),
    },
  };
}

async function callSafely(version, opts, messages) {
  try {
    return await call(version, opts, messages);
  } catch (_) {
    // Детали ошибки не печатаем: внешний провайдер может включить в неё часть
    // входного запроса. Одно падение не должно обрывать всю обезличенную выборку.
    return {
      kind: 'request-failed', tools: [], chars: 0, costRub: 0,
      inputTokens: 0, outputTokens: 0,
      _quality: { hasText: false, toolCalls: [], internalJargon: false },
    };
  }
}

async function main() {
  if (!process.argv.includes('--live')) {
    throw new Error('нужен явный флаг --live; он разрешает отправку реальных диалогов только LLM-провайдеру');
  }
  const limit = readPositiveIntegerArg('limit', MAX_DIALOGS, MAX_DIALOGS);
  const offset = readPositiveIntegerArg('offset', 1, 50) - 1;
  if (config.AGENT_PROVIDER !== 'polza') {
    throw new Error('скрипт сейчас поддерживает только настроенный provider=polza, чтобы точно снять cost_rub');
  }
  const salonId = config.CHATPUSH.salonId;
  if (!Number.isInteger(salonId) || salonId <= 0) {
    throw new Error('CHATPUSH_SALON_ID не задан: выборка без server-derived salon_id запрещена');
  }

  const catalog = await catalogBlock.buildSafe(salonId);
  const dialogs = await selectDialogs(salonId, limit, offset);
  const rows = [];
  for (let i = 0; i < dialogs.length; i++) {
    const d = dialogs[i];
    const transcript = await history.loadTranscript(salonId, d.dialog_key, { limit: 20, withTime: true });
    const lastUser = [...transcript.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) continue;
    const opts = {
      catalogBlock: catalog,
      today: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }),
      now: new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }),
      lastUserText: lastUser.content,
    };
    const [v1, v2] = await Promise.all([
      callSafely('v1', opts, transcript.messages),
      callSafely('v2', opts, transcript.messages),
    ]);
    const scenarios = detectPromptScenarios(lastUser.content);
    rows.push({
      case: i + 1,
      scenarios,
      v1: { ...withoutQuality(v1), quality: qualitySignals(v1._quality, scenarios) },
      v2: { ...withoutQuality(v2), quality: qualitySignals(v2._quality, scenarios) },
    });
  }

  const report = {
    dialogsCompared: rows.length,
    results: rows,
    totals: ['v1', 'v2'].reduce((total, version) => {
      total[version] = rows.reduce((sum, row) => sum + row[version].costRub, 0);
      return total;
    }, {}),
  };
  // Для автоматизированного запуска можно сохранить только обезличенный JSON
  // во временный путь. Путь задаётся снаружи, в репозитории ничего не создаём.
  if (process.env.AGENT_PROMPT_AB_REPORT_PATH) {
    fs.writeFileSync(process.env.AGENT_PROMPT_AB_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  // Ошибки намеренно без SQL, ключей диалогов и текстов сообщений.
  console.error(`agent-prompt-ab-real-dialogs: ${err.message}`);
  process.exitCode = 1;
}).finally(async () => { await pool.end(); });
