'use strict';

// ── Сырой журнал tool-цикла Милы (agent_tool_events) ────────────────────────
// ЗАЧЕМ. Транскрипт диалога собирается из ТЕКСТОВ chatpush_messages: весь
// tool-цикл (вызовы + результаты) живёт один прогон runDialog и выбрасывается.
// Журнал сохраняет его в БД: форензика инцидентов без debug-preload + источник
// «памяти» между ходами (выжимку рендерит tool-memory.js, чистый модуль).
// Строго best-effort: сбой БД никогда не роняет ход (паттерн outgoing-authorship).

const crypto = require('crypto');
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentToolEvents');

const KEEP_DAYS = 30;
// Кап сериализованного результата: слот-выдачи и истории визитов помещаются с
// запасом, а патологически большой ответ не раздувает таблицу.
const RESULT_CAP_CHARS = 64 * 1024;
const PREVIEW_CHARS = 2000;

function capResult(result) {
  if (result == null) return null;
  let s;
  try { s = JSON.stringify(result); } catch (e) { return { truncated: true }; }
  if (s.length <= RESULT_CAP_CHARS) return result;
  return { truncated: true, preview: s.slice(0, PREVIEW_CHARS) };
}

// Буфер одной ПОПЫТКИ runDialog. События копятся в памяти и уходят одним батчем
// в конце попытки (flush) — выброшенная перегенерацией попытка помечается целиком.
// delivered: true/false — вердикт известен сразу; null — решит диспетчер после
// отправки (markDelivered).
function createBuffer(salonId, dialogKey) {
  const turnId = crypto.randomUUID();
  const rows = [];
  let flushed = false;
  return {
    turnId,
    push(tool, input, result, isError) {
      // После flush() массив rows больше никуда не уходит — молчаливое
      // накопление здесь было бы утечкой памяти И потерей события без следа.
      if (flushed) {
        logger.warn(`tool-events push ${dialogKey}: событие после flush() — в журнал не попадёт (tool=${tool})`);
        return;
      }
      rows.push({ tool, input: input == null ? null : input, result: capResult(result), isError: !!isError });
    },
    // Протокол PostgreSQL ограничивает запрос 65535 параметрами; при 8 колонках
    // на строку это ≈8191 событий за одну попытку. Сегодня недостижимо — предел
    // держит лимит итераций tool-цикла в оркестраторе (десятки вызовов на ход),
    // не этот файл. Если тот лимит когда-нибудь вырастет на порядки, INSERT
    // молча упадёт целиком (см. catch ниже) — кап по числу строк здесь
    // намеренно не вводится, это чужая ответственность.
    async flush(delivered) {
      if (flushed || !rows.length) { flushed = true; return; }
      flushed = true;
      try {
        const values = [];
        const params = [];
        rows.forEach((r, i) => {
          const b = i * 8;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
          params.push(salonId, String(dialogKey || ''), turnId, r.tool,
            r.input == null ? null : JSON.stringify(r.input),
            r.result == null ? null : JSON.stringify(r.result),
            r.isError,
            delivered == null ? null : !!delivered);
        });
        await db.query(
          `INSERT INTO agent_tool_events
             (salon_id, dialog_key, turn_id, tool, input, result, is_error, delivered)
           VALUES ${values.join(',')}`, params);
      } catch (e) {
        logger.warn(`tool-events flush ${dialogKey}: ${e.message} — журнал попытки пропущен`);
      }
    },
  };
}

// Вердикт доставки для хода, флашнутого с delivered=null. Зовёт диспетчер после
// отправки реплик (fire-and-forget). Строки с уже известным вердиктом не трогаем.
async function markDelivered(turnId, delivered) {
  if (!turnId) return;
  try {
    await db.query(
      `UPDATE agent_tool_events SET delivered = $2
        WHERE turn_id = $1 AND delivered IS NULL`, [turnId, !!delivered]);
  } catch (e) {
    logger.warn(`tool-events markDelivered ${turnId}: ${e.message}`);
  }
}

// События диалога за окно памяти, в хронологическом порядке. Возраст считается
// В SQL (created_at — timestamp without time zone, JS-Date сюда нельзя — гочта
// resumeOperatorPauseIfWindowReopened); наружу уходит age_ms, tool-memory
// восстанавливает абсолютное время как nowMs - age_ms.
//
// НЕ best-effort — единственная функция файла с таким исключением. Ошибка БД
// НАМЕРЕННО не глотается: вызывающий оркестратор ловит её сам, со своим
// логом и fail-open (промпт без выжимки памяти лучше, чем упавший ход).
// Не оборачивать в try/catch «для единообразия» — это молча убьёт тот лог.
async function loadRecent(salonId, dialogKey, opts = {}) {
  const hours = opts.hours || 48;
  const limit = opts.limit || 120;
  const rows = await db.any(
    `SELECT tool, input, result, is_error, delivered,
            EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms
       FROM agent_tool_events
      WHERE salon_id = $1 AND dialog_key = $2
        AND created_at > NOW() - ($3 || ' hours')::interval
      ORDER BY id DESC
      LIMIT $4`, [salonId, dialogKey, hours, limit]);
  return rows.reverse();
}

/** Удалить строки старше KEEP_DAYS (зовётся кроном 40 4 * * * из server.js). */
async function cleanup() {
  try {
    await db.query(
      `DELETE FROM agent_tool_events WHERE created_at < NOW() - INTERVAL '${KEEP_DAYS} days'`);
  } catch (e) {
    // Не молча: чистка — единственная гарантия 30-дневного хранения СЫРЫХ
    // input/result (там, в частности, история визитов пациента). Тихо
    // сломавшийся крон = бессрочное хранение, о котором никто не узнает.
    logger.warn(`tool-events cleanup: ${e.message} — старые события не удалены`);
  }
}

module.exports = { createBuffer, markDelivered, loadRecent, cleanup, KEEP_DAYS };
