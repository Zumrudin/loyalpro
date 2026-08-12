'use strict';

const { db } = require('../../db');
const pendingReplies = require('./pending-replies');
const sessionGap = require('./session-gap');
const { formatStamp, stripStamp } = require('./transcript-time');

// Ключ диалога в chatpush_messages — тот же, что во всём коде (routes/chat.js):
// телефон, либо chat_id для каналов без телефона (Telegram/MAX).
const DIALOG_KEY_SQL = `COALESCE(NULLIF(phone,''), chat_id)`;

// Время сообщения. msg_ts NULLABLE (migrations.js), и такие строки на базе есть.
// ПОЧЕМУ COALESCE, а не «WHERE msg_ts IS NOT NULL»: выкинуть сообщение из
// транскрипта нельзя — модель потеряет его ТЕКСТ, а это единственное, ради чего
// транскрипт и грузится. Подставляем время вставки строки: оно на секунды
// расходится с реальным msg_ts (замерено на dev: разница ~4 сек) и для меток и
// разрывов полностью годится.
// ЗАЧЕМ вообще: «ORDER BY msg_ts DESC» в PostgreSQL — это NULLS FIRST, поэтому
// NULL-строка ВСЕГДА попадала в окно LIMIT 20, а после rows.reverse() вставала в
// самый ХВОСТ, то есть выглядела самым свежим сообщением диалога. detectSession
// брала её за хвостовую серию, toTs(null) → null → {newSession:false} — и
// граница переписки (инцидент 2026-08-05) для такого диалога молча выключалась
// навсегда, без единой записи в лог.
// Выражение ОБЯЗАНО совпадать в SELECT и в ORDER BY — потому и вынесено в
// константу: разъехавшись, они дали бы порядок по одному значению, а метку и
// разрыв по другому, и это хуже исходного бага (порядок реплик врал бы модели).
// AT TIME ZONE: created_at — timestamp WITHOUT time zone, куда NOW() кладёт
// МОСКОВСКОЕ стенное время (сессия PG в Europe/Moscow), поэтому голый
// EXTRACT(EPOCH FROM created_at) даёт epoch на 3 часа ВПЕРЁД (проверено на
// dev-БД). Три часа сдвига — это и метка «[дд.мм чч:мм]» в будущем, и ложный
// разрыв при пороге 6 ч, если соседняя строка со своим msg_ts честная.
const MSG_TS_SQL = `COALESCE(msg_ts, EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'Europe/Moscow'))::bigint)`;

// Пометка чужого авторства в транскрипте. Держится в паре с правилом промпта
// «РЕПЛИКИ АДМИНИСТРАТОРА» (services/agent/system-prompt.js) — менять только вместе.
const OPERATOR_MARK = '[сообщение администратора клиники]';

// Срезает OPERATOR_MARK с начала КАЖДОЙ строки текста — реплики серии в
// транскрипте склеены через '\n', одной проверки на весь текст мало. Нужна
// ВСЕМ промптам без tool-цикла (care/reminders/followup): их промпты про эту
// пометку не знают и отдали бы её пациенту дословно — маркер предназначен
// только основному агенту (его промпт и правило «РЕПЛИКИ АДМИНИСТРАТОРА»
// знают, что с ним делать). Раньше жила тремя побайтово одинаковыми копиями
// (services/care/worker.js, services/reminders/worker.js,
// services/agent/followup-prompt.js) — вынесена сюда, к самой константе,
// правкой по ревью 2026-08-12: разъехавшиеся копии означали бы, что при
// изменении формата маркера обновят не все места.
const OPERATOR_MARK_PREFIX = `${OPERATOR_MARK} `;
function stripOperatorMark(text) {
  return String(text || '')
    .split('\n')
    .map((line) => (line.startsWith(OPERATOR_MARK_PREFIX) ? line.slice(OPERATOR_MARK_PREFIX.length) : line))
    .join('\n');
}

// Журнал авторства исходящих (services/outgoing-authorship) выкачен на прод
// 04.08.2026 (коммит 34caa25). У сообщений ДО него authored_by = NULL, и среди
// них есть реплики живых администраторов — без пометки модель считает их своими
// (инцидент 2026-08-05: пациентке не ответили приветствием, потому что неделю
// назад с ней здоровался администратор, а его «Доброе утро» числилось за Милой).
// ПОСЛЕ отсечки NULL значит ДРУГОЕ: classify упал, а там намеренный fail-open,
// чтобы не глушить Милу на её же эхе, — такое NULL оператором НЕ считаем.
// Отсечка взята концом суток 04.08 мск: ошибка в эту сторону заставит Милу лишний
// раз перепроверить собственную договорённость, ошибка в другую — исходный баг.
// Компромисс: под пометку попадут и до-выкатные автоуведомления YClients («Вы
// записаны на прием…», authored_by тоже NULL) — они прочитаются моделью как
// реплика администратора. Это дешевле обратной ошибки, отдельно не разбираем.
const AUTHORSHIP_SINCE_TS = Math.floor(Date.parse('2026-08-05T00:00:00+03:00') / 1000);

// Транскрипт диалога для Claude Messages API.
//  incoming → {role:'user'}, outgoing (наши эхо-ответы) → {role:'assistant'}.
// Возвращает { messages, watermark, session }: watermark = max(msg_ts) входящих,
// session = sessionGap.detectSession(rows) — граница «новой переписки» (Task 5/6).
async function loadTranscript(salonId, dialogKey, opts = {}) {
  const limit = opts.limit || 20;
  // Метки времени включает только оркестратор: care-воркер (services/care/worker.js)
  // собирает из этого же транскрипта свой промпт, и метки там не нужны (он и не
  // передаёт withTime — см. комментарий у его вызова loadTranscript).
  // withTime жёстко связан с reply-guard'ом оркестратора: allowedTimes там
  // собирается из JSON.stringify(messages) через stripAllStamps — без этой чистки
  // КАЖДАЯ метка отправки читалась бы как «разрешённое время», и это ровно та
  // размывка проверки, против которой guard делался (инцидент 2026-07-28). Менять
  // формат метки здесь без синхронной правки stripAllStamps нельзя.
  const withTime = !!opts.withTime;
  const rows = await db.any(
    `SELECT direction, msg_type, text, authored_by,
            ${MSG_TS_SQL} AS msg_ts
       FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND text IS NOT NULL AND text <> ''
      ORDER BY ${MSG_TS_SQL} DESC, id DESC
      LIMIT $3`,
    [salonId, dialogKey, limit]);

  rows.reverse();   // из DESC (свежие сверху) → в хронологический порядок

  // Только что отправленные ответы агента, чьё эхо ещё не легло в БД (Chatpush
  // доставляет с задержкой; WhatsApp эхо не шлёт вовсе). Без них повторный прогон
  // видит серию клиента «без ответа» и отвечает заново (инцидент 2026-07-31).
  // Дедуп по тексту: если эхо уже в выборке — pending-копия не подмешивается.
  const pending = pendingReplies.peek(salonId, dialogKey, opts.nowMs || Date.now());
  if (pending.length) {
    const echoed = new Set(rows.filter((r) => r.direction === 'outgoing').map((r) => r.text));
    // authored_by: конкретное значение тут не важно, важно лишь что не null/
    // 'operator' — pending всегда НАША собственная отправка (диспетчер Милы,
    // care-воркер или notifications.js — 'agent' здесь условность, ниже по
    // потоку различают только 'operator' и null, а 'operator' в pending попасть
    // не может: routes/chat.js кладёт свои реплики через authorship.remember,
    // не через pendingReplies).
    const extra = pending.filter((p) => !echoed.has(p.text))
      .map((p) => ({ direction: 'outgoing', text: p.text, msg_ts: p.ts, authored_by: 'agent' }));
    if (extra.length) {
      rows.push(...extra);
      rows.sort((a, b) => Number(a.msg_ts) - Number(b.msg_ts));   // stable → равные ts не перемешиваются
    }
  }

  // Граница переписки считается на СЫРЫХ строках: ниже серии склеиваются, а
  // хвостовой assistant-блок переносится — границы сообщений теряются.
  const session = sessionGap.detectSession(rows);

  const messages = [];
  let watermark = 0;
  for (const r of rows) {
    if (r.direction === 'incoming' && Number(r.msg_ts) > watermark) watermark = Number(r.msg_ts);
    const role = r.direction === 'outgoing' ? 'assistant' : 'user';
    // Исходящее, написанное ЖИВЫМ администратором (не нами), помечаем явно.
    // Роль всё равно assistant — других ролей у Messages API нет, — но без
    // пометки модель считает такие реплики своими: инцидент 2026-08-04, где
    // время и услугу согласовал человек, а Мила по правилу «выбор варианта =
    // согласие» молча оформила запись, придумав услугу. Автор проставлен
    // вебхуком (services/outgoing-authorship); что делать с NULL — см. AUTHORSHIP_SINCE_TS.
    // Number(r.msg_ts) здесь БЕЗ обвязки toTs намеренно: msg_ts приходит из
    // MSG_TS_SQL, то есть после COALESCE на created_at, и пустым уже не бывает —
    // предикат определён всегда. До COALESCE он вёл себя на битом значении
    // по-разному (null → 0 → «оператор», 'abc' → NaN → сравнение false → «не
    // оператор»); лишний слой проверки поверх гарантии из СУБД только создал бы
    // впечатление, что значение по-прежнему ненадёжно. Единственный источник
    // msg_ts мимо СУБД — pendingReplies (число, наша же отправка), и туда ветка
    // legacyUnknown не заходит: у pending-строк authored_by = 'agent'.
    const legacyUnknown = r.direction === 'outgoing'
      && r.authored_by == null
      && Number(r.msg_ts) < AUTHORSHIP_SINCE_TS;
    // Ведущая метка во входящем тексте — подделка клиента: настоящую ставим мы.
    // Чистка идёт ВСЕГДА, независимо от withTime — правило одно и без копий, и
    // care-путь (withTime=false) тоже получает текст без подделанных меток.
    let body = r.direction === 'incoming' ? stripStamp(r.text) : r.text;
    if (r.authored_by === 'operator' || legacyUnknown) body = `${OPERATOR_MARK} ${body}`;
    const stamp = withTime ? formatStamp(r.msg_ts) : '';
    const text = stamp ? `${stamp} ${body}` : body;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;   // склейка серии
    else messages.push({ role, content: text });
  }
  // Chatpush/MAX доставляет наши ответы и с многоминутной задержкой (наблюдали 19 мин
  // 2026-07-26) — эхо получает msg_ts ПОЗЖЕ нового входящего, и транскрипт кончается
  // assistant-репликой. Polza (Anthropic через Azure) такой диалог отвергает
  // (400 «does not support assistant message prefill»), а по смыслу задержанное эхо —
  // ответ на ПРЕДЫДУЩЕЕ сообщение клиента. Переносим хвостовой assistant-блок перед
  // последний user-блок: транскрипт всегда кончается сообщением клиента.
  if (messages.length > 1 && messages[messages.length - 1].role === 'assistant') {
    const tail = [];
    while (messages.length && messages[messages.length - 1].role === 'assistant') {
      tail.unshift(messages.pop());
    }
    if (messages.length) {
      const lastUser = messages.pop();
      for (const t of tail) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') last.content += `\n${t.content}`;
        else messages.push(t);
      }
      messages.push(lastUser);
    }
  }
  // Claude требует, чтобы первым шёл user — срезаем ведущие assistant-реплики
  // (после переноса хвоста: он мог поставить assistant в начало, если более
  // раннего user-блока в окне не нашлось).
  //
  // Срезанное ВОЗВРАЩАЕТСЯ отдельно, а не пропадает. Инцидент 2026-08-10
  // (79776646672): пациентка ответила «5» на опрос об оценке визита, но все три
  // исходящих в диалоге были служебными и шли подряд в начале окна — их срезало
  // целиком, и в модель ушла ровно одна строка «5», без вопроса, ответом на
  // который она была. Мила прочитала это как начало разговора и спросила «чем
  // могу помочь?». Оркестратор кладёт leadingClinic в ХВОСТ промпта: в
  // messages их вернуть нельзя (роль assistant первой запрещена провайдером).
  const leadingClinic = [];
  while (messages.length && messages[0].role === 'assistant') {
    leadingClinic.push(messages.shift().content);
  }
  return { messages, watermark, session, leadingClinic };
}

// Отвечали ли этому пациенту хоть раз за ВСЮ историю диалога?
//
// ЗАЧЕМ: инцидент 2026-08-06 (79165370505) — первое в жизни обращение
// («Доброе утро! Можете записать меня на эпиляцию…»), а Мила ответила по делу,
// без приветствия и без представления. Приветствие было чисто промптовым
// правилом, и признака «это первое сообщение» в промпте не было вовсе: блок
// НАЧАЛО НОВОЙ ПЕРЕПИСКИ рендерится только при ИЗМЕРЕННОМ разрыве, а на первом
// обращении мерить не с чем (см. detectSession: ветка «в окне только клиент»).
//
// Считается по всей истории, а НЕ по окну LIMIT 20 транскрипта: окно и так
// целиком состоит из сообщений клиента ровно в тех случаях, которые надо
// различить, а ведущие assistant-реплики loadTranscript вдобавок срезает
// (Messages API требует user первым) — по messages вопрос не решается.
//
// authored_by='system' (автоуведомления YClients «Вы записаны на прием…»,
// рассылки) за ответ НЕ считается: разговора не было, и пациент, впервые
// написавший в чат после такой отбивки, приветствие заслуживает. Всё
// остальное — 'agent' (наши реплики), 'operator' (живой администратор из
// приложения) и NULL (до выката журнала авторства либо classify упал) —
// считается ответом: ошибка в эту сторону стоит пропущенного приветствия,
// ошибка в другую — приветствия поверх живого разговора.
async function hasEverAnswered(salonId, dialogKey) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'outgoing'
        AND authored_by IS DISTINCT FROM 'system'
      LIMIT 1`,
    [salonId, dialogKey]);
  return !!row;
}

// Писала ли САМА Мила в этот диалог хоть раз за всю историю?
//
// ЗАЧЕМ ОТДЕЛЬНО от hasEverAnswered: инцидент 2026-08-10 (79166524647 и
// 79295059889). Обеим пациенткам раньше отвечал живой администратор из
// приложения, Мила им не писала ни разу — и не представилась. hasEverAnswered
// в обоих диалогах честно вернул true («разговор был»), поэтому блок промпта
// «ПЕРВОЕ ОБРАЩЕНИЕ», где единственно и живёт требование представиться, не
// рендерился; а блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» вдобавок запрещает
// представляться «второй раз» — на ложной посылке, первого раза не было.
//
// Два признака отвечают на два РАЗНЫХ вопроса, и схлопывать их нельзя:
// hasEverAnswered — «здоровались ли с пациентом вообще» (повторное
// «здравствуйте» посреди живого разговора неуместно), hasAgentEverWritten —
// «представлялась ли Мила» (продублировать представление невозможно по
// построению, если она ещё ни разу не писала).
//
// Строго authored_by='agent': 'operator' — живой человек, 'system' —
// автоуведомление, NULL — до выката журнала авторства (04.08) либо упавший
// classify. Ни то, ни другое, ни третье представлением Милы не было.
async function hasAgentEverWritten(salonId, dialogKey) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'outgoing'
        AND authored_by = 'agent'
      LIMIT 1`,
    [salonId, dialogKey]);
  return !!row;
}

// ПОСЛЕДНЕЕ исходящее диалога: { author, text } | null (null — исходящих нет).
// author: 'agent' | 'operator' | 'system' | null (null = authored_by не проставлен).
//
// ЗАЧЕМ: детерминированные ветки оркестратора (оценка визита «5», короткое «+»
// на акцию — спека 2026-08-10-agent-prompt-to-code-offload) включаются ТОЛЬКО
// когда последнее слово клиники — автоуведомление (authored_by='system'):
// пациент отвечает на отбивку, а не на вопрос Милы. Её вопрос сделал бы
// последним исходящим 'agent', и ветка не сработает — ход уйдёт в LLM.
// Одного автора МАЛО: под 'system' идут ВСЕ автоуведомления YClients («Вы
// записаны на прием…», «Напоминаем о записи…») и касания «Заботы»/напоминаний,
// поэтому наружу отдаётся и ТЕКСТ — вызывающий сверяет, что это был именно
// опрос (visit-rating.isRatingSurvey).
//
// ГОТЧА: читается СЫРАЯ БД, мимо pending-replies. Эхо Chatpush запаздывает на
// минуты (tdlib/MAX), а WhatsApp его не шлёт вовсе — только что отправленная
// реплика Милы может здесь ещё не лежать, и последним исходящим окажется
// предыдущее автоуведомление. Известный класс инцидента 2026-07-31; ошибка
// возможна только в сторону ЛИШНЕГО срабатывания ветки, которая и так требует
// текста опроса рядом с голой цифрой.
async function lastOutgoing(salonId, dialogKey) {
  const row = await db.oneOrNone(
    `SELECT authored_by, text FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'outgoing'
      ORDER BY ${MSG_TS_SQL} DESC, id DESC
      LIMIT 1`,
    [salonId, dialogKey]);
  return row ? { author: row.authored_by || null, text: row.text || null } : null;
}

// Только автор последнего исходящего — контракт держится отдельно от lastOutgoing:
// веткам, которым текст не нужен, незачем тащить его через сигнатуру.
async function lastOutgoingAuthor(salonId, dialogKey) {
  const row = await lastOutgoing(salonId, dialogKey);
  return (row && row.author) || null;
}

// Пришло ли входящее новее watermark (во время прогона агента)?
async function hasIncomingAfter(salonId, dialogKey, watermark) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'incoming' AND msg_ts > $3
      LIMIT 1`,
    [salonId, dialogKey, watermark || 0]);
  return !!row;
}

module.exports = {
  loadTranscript, hasIncomingAfter, hasEverAnswered, hasAgentEverWritten,
  lastOutgoing, lastOutgoingAuthor,
  OPERATOR_MARK, AUTHORSHIP_SINCE_TS, stripOperatorMark,
};
