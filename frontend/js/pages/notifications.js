'use strict';
// ── УВЕДОМЛЕНИЯ ПО ЗАПИСЯМ YCLIENTS (вкладка «Автоуведомления» страницы «Рассылки») ──
// Правила по типам + настройки салона (режим off/shadow/live, каскад мессенджеров, тихие часы,
// ответы пациентам) + журнал job'ов + оценки + сверка с Chatpush.
// Бэкенд — backend/routes/notification-rules.js (/api/notification-rules). Заменяет v1-файл
// broadcast-rules.js: он остаётся на диске, но из index.html снят (bcSwitchTab переехал сюда).
//
// Зависимости (все страничные скрипты делят ОДНУ глобальную область):
//   core: api(method, path, body), esc(), escAttr(), escJs(), notify(msg, 'ok'|'err');
//   conditions-editor.js: condInit/condSet/condGet/condAdd/condSetLogic/condHasEmpty (ns 'ntf' — так же
//   названы id разметки: #ntfConds, #ntfLogicWrap, #ntfLogic-and, #ntfLogic-or).
//
// ГОТЧА ГЛОБАЛЬНОЙ ОБЛАСТИ: верхнеуровневый const/let с именем, уже объявленным другим скриптом (хоть
// функцией), — SyntaxError, гасящий ВЕСЬ файл (так страница чата теряла список диалогов). Поэтому все
// имена здесь начинаются с nt/NT_; `_nt` занят core/utils.js (таймер notify). Тест notifications.test.js
// грузит все скрипты index.html подряд в один vm-контекст, как браузер.
//
// Чистые помощники (без DOM) — первый раздел, под node --test. Всё, что трогает document, — ниже.

// ═══ 1. Справочники подписей ═══════════════════════════════════════════════

const NT_TYPE_ORDER = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'];

// sample — образец текста для placeholder нового правила (без названий и адресов конкретной клиники).
const NT_TYPES = {
  record_created: {
    lbl: 'Запись создана', hint: 'Сразу после создания записи — только для будущих визитов',
    sample: 'Вы записаны на прием {date} {time} в «{salon}».',
  },
  record_rescheduled: {
    lbl: 'Запись перенесена', hint: 'Когда изменилось время визита — только для будущих визитов',
    sample: 'Ваша запись в «{salon}» перенесена.\nНовое время записи {date} в {time}',
  },
  record_cancelled: {
    lbl: 'Запись отменена',
    hint: 'Когда администратор ставит «клиент не придёт» до начала визита. Удаление записи уведомления не шлёт — как YClients',
    sample: '❌ Ваша запись в «{salon}» {date} в {time} отменена🙁\nМы очень надеемся, что Вы все же сможете посетить нас в будущем☺️',
  },
  visit_reminder: {
    lbl: 'Напоминание о визите',
    hint: 'За N часов до визита (по умолчанию 24), просит подтвердить; по уже подтверждённым визитам не шлётся',
    sample: 'Здравствуйте!\nНапоминаем о записи в «{salon}»\nВаша запись {date} в {time}\nПожалуйста, подтвердите визит',
  },
  visit_review: {
    lbl: 'Опрос после визита', hint: 'Через N минут после окончания визита, не чаще раза в 30 дней; ответ цифрой 2–5',
    sample: 'Спасибо что посетили «{salon}»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5, где\n2 - Вы совершенно недовольны визитом\n3 - больше минусов, чем плюсов\n4 - были мелкие недочеты, но в целом всё Ок\n5 - все отлично',
  },
  visit_after: {
    lbl: 'Рекомендации после процедуры', hint: 'Через N минут после окончания визита, по услугам, с картинкой',
    sample: 'Рекомендации после процедуры «{services}»',
  },
  first_visit: {
    lbl: 'Первый визит', hint: 'Новому клиенту — при создании первой записи: приглашение в программу лояльности',
    sample: 'Присоединяйтесь к программе лояльности «{salon}» и получайте приветственные бонусы уже на первый визит!',
  },
};

// Мессенджеры каскада — ровно CASCADE_CHANNELS бэкенда (services/notifications/cascade.js; сверяет тест).
const NT_CH = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };

// Исходы шагов каскада (cascade_log[].res). Каждый код, который пишет worker.js, обязан быть здесь (сверяет тест).
const NT_STEP = {
  no_recipient: 'нет адресата', rejected: 'отказ', ambiguous: 'сбой', sent: 'отправлено',
  undeliverable: 'не доставлено', undeliverable_unknown: 'исход неизвестен',
};

const NT_ST = {
  pending: { lbl: 'В очереди', color: '#9ca3af' }, sent: { lbl: 'Отправлено', color: '#10b981' },
  shadow: { lbl: 'Тень', color: '#6366f1' }, skipped: { lbl: 'Пропущено', color: '#f59e0b' },
  cancelled: { lbl: 'Отменено', color: '#9ca3af' }, failed: { lbl: 'Ошибка', color: '#ef4444' },
};

const NT_MODES = {
  off: {
    icon: '⚪', name: 'выключен', line: 'выключен',
    desc: 'Выключен: правила не работают, ничего не создаётся и не отправляется. Тексты и условия можно готовить заранее.',
  },
  shadow: {
    icon: '🟡', name: 'тень', line: 'теневой — строки пишутся в журнал, отправки нет',
    desc: 'Тень: события обрабатываются, тексты ложатся в журнал со статусом «Тень», клиентам ничего не уходит. Режим для сверки с Chatpush (вкладка «Сверка с Chatpush»).',
  },
  live: {
    icon: '🟢', name: 'боевой', line: 'боевой — уведомления уходят клиентам',
    desc: 'Боевой: уведомления уходят клиентам, ответы «Подтверждаю» и оценки обрабатываем мы. Перед включением отключите уведомления Chatpush в YClients (Интеграции → Уведомления), иначе клиенты получат дубли.',
  },
};

const NT_COND_LBL = { staff: 'Специалист', category: 'Категория', service: 'Услуга' };

// Подстановки шаблона (render.js). {rating_links} намеренно нет: бэкенд его не заполняет (всегда пусто),
// ссылки на отзывы пишутся прямо в текст ответа на оценку 5 (⚙️ Настройки).
const NT_VARS = [
  ['{first_name}', 'имя клиента (если опознано; иначе пусто)'], ['{name}', 'имя из карточки клиента'],
  ['{date}', 'дата визита ДД.ММ.ГГГГ'], ['{time}', 'время начала'], ['{end_time}', 'время окончания'],
  ['{services}', 'услуги записи'], ['{staff}', 'мастер'], ['{salon}', 'название клиники'],
  ['{record_link}', 'ссылка на запись в YClients'],
];

const NT_JOBS_PAGE = 100;               // размер страницы журнала — LIMIT 100 у GET /jobs
const NT_FILE_MAX = 5 * 1024 * 1024;    // лимит multer у POST /:id/attachment

const NT_LIVE_CONFIRM = 'Включить боевой режим? Уведомления начнут уходить клиентам. Убедитесь, что Chatpush отключён в YClients (Интеграции → Уведомления), иначе клиенты получат дубли.';
const NT_EMPTY_CASCADE_CONFIRM = 'В каскаде не выбран ни один мессенджер — уведомления не будут уходить. Сохранить?';

// ═══ 2. Чистые помощники ═══════════════════════════════════════════════════

// Значение для атрибута HTML (esc — & < >, escAttr — кавычки) и для строкового аргумента инлайн-обработчика.
// Строка в атрибуте-обработчике (onclick и т.п.) проходит ДВА разбора: сперва HTML раскодирует сущности, потом JS читает
// литерал. Поэтому после escJs обязателен esc (иначе «&#39;);…» декодируется в кавычку и код исполняется), а потом escAttr.
const ntAttr = (s) => escAttr(esc(s));
const ntJsArg = (s) => escAttr(esc(escJs(s)));

// Ссылка на файл вложения — только наш каталог загрузок: значение приходит из БД, и «javascript:…» или чужой
// адрес в href/src не должны попадать в разметку. '..' режем: он уводит из /uploads/ на другие пути сайта.
function ntUploadHref(url) {
  return typeof url === 'string' && url.startsWith('/uploads/') && !url.includes('..') ? url : '';
}

function ntTypeLabel(t) { return (NT_TYPES[t] || {}).lbl || t || '—'; }

function ntPlural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

/** 'ДД.ММ ЧЧ:ММ' по Москве; формат не зависит от локали окружения (Intl.formatToParts, а не toLocaleString). */
function ntFmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) p[x.type] = x.value;
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

// null/''/нечисло → запасное значение; 0 — законное число (опрос «сразу после визита»).
function ntNumOr(v, dflt) {
  return (v == null || v === '' || !Number.isFinite(Number(v))) ? dflt : Number(v);
}

// Часы до визита: не задано, не число или ≤ 0 → 24 (как events.reminderAt на бэкенде).
function ntHoursOr24(v) { const h = ntNumOr(v, 24); return h > 0 ? h : 24; }

/** Когда срабатывает правило — одной фразой для сводки в списке. */
function ntRuleTiming(r) {
  switch (r && r.trigger_type) {
    case 'visit_reminder': {
      return `за ${ntHoursOr24(r.hours_before)} ч до визита${r.ask_confirmation === false ? ', без запроса подтверждения' : ', просит подтвердить'}`;
    }
    case 'visit_review':
    case 'visit_after':
      return `через ${ntNumOr(r.delay_minutes, 5)} мин после визита`;
    case 'record_cancelled':
      return r.on_no_show === false ? 'не отправляется: отметка «клиент не придёт» выключена' : 'при отметке «клиент не придёт»';
    case 'first_visit':
      return 'при первой записи нового клиента';
    default:
      return 'сразу';
  }
}

function ntCondName(dicts, type, id) {
  const list = !dicts ? [] : type === 'staff' ? dicts.staff : type === 'category' ? dicts.categories : dicts.services;
  const hit = (list || []).find((x) => String(x.id) === String(id));
  return hit ? (hit.title || hit.name || String(id)) : String(id);
}

/** Сводка условий. Словарь ещё не пришёл → число значений вместо названий (потом список перерисуется). */
function ntCondSummary(conditions, dicts) {
  const items = (conditions && Array.isArray(conditions.items) ? conditions.items : [])
    .filter((it) => it && Array.isArray(it.ids) && it.ids.length);
  if (!items.length) return 'любая запись';
  const glue = conditions.logic === 'or' ? ' ИЛИ ' : ' И ';
  return items.map((it) => {
    const lbl = NT_COND_LBL[it.type] || it.type;
    if (!dicts) return `${lbl}: ${it.ids.length} шт.`;
    const names = it.ids.slice(0, 3).map((id) => ntCondName(dicts, it.type, id));
    return `${lbl}: ${names.join(', ')}${it.ids.length > 3 ? ` +${it.ids.length - 3}` : ''}`;
  }).join(glue);
}

function ntRuleSummary(r, dicts) {
  return `${ntRuleTiming(r)} · ${ntCondSummary(r && r.conditions, dicts)}`;
}

function ntCascadeLine(s) {
  const order = ((s && s.default_channels) || []).map((c) => NT_CH[c] || c).join(' → ');
  if (!order) return 'не задан — отправок не будет';
  return (s.prefer_last_channel ? 'мессенджер последней переписки, затем ' : '') + order;
}

function ntModeInfo(mode) { return NT_MODES[mode] || NT_MODES.off; }

function ntModeLine(s) {
  const m = ntModeInfo(s && s.mode);
  return `Режим: ${m.icon} ${m.line} · Каскад: ${ntCascadeLine(s)}`;
}

function ntStatus(st) { return NT_ST[st] || { lbl: st || '—', color: '#9ca3af' }; }

/** Шаги каскада job'а → [{ch, res, err, text}]; мусор в cascade_log не роняет журнал. */
function ntCascadeSteps(log) {
  return (Array.isArray(log) ? log : []).filter((x) => x && typeof x === 'object').map((x) => ({
    ch: x.ch, res: x.res, err: x.err || '',
    text: `${NT_CH[x.ch] || x.ch || '?'}: ${NT_STEP[x.res] || x.res || '?'}`,
  }));
}

function ntCascadePath(log) { return ntCascadeSteps(log).map((s) => s.text).join(' → '); }

/** Когда показывать строку журнала: у запланированной — плановое время, у остальных — отправка, иначе плановое. */
function ntJobWhen(j) {
  if (j.status === 'pending') return { ts: j.scheduled_at, plan: true };
  return { ts: j.sent_at || j.scheduled_at || j.created_at, plan: false };
}

/** Ответ POST /jobs/:id/cancel: {ok:false} — строка уже не pending (ушла, отменена воркером или другим админом). */
function ntCancelOutcome(d) {
  return d && d.ok
    ? { text: 'Отправка отменена', type: 'ok' }
    : { text: 'Строка уже не в очереди (ушла или отменена)', type: 'err' };
}

/** Ответ POST /:id/toggle: при выключении сервер возвращает cancelledJobs — сколько запланированных отправок погашено. */
function ntToggleMessage(d) {
  if (d && d.rule && d.rule.is_enabled) return 'Правило включено';
  const n = d && d.cancelledJobs;
  return 'Правило выключено' + (typeof n === 'number' && Number.isFinite(n) ? `. Погашено в очереди: ${n}` : '');
}

function ntReplyLabel(type) {
  return type === 'visit_reminder' ? '✅ подтвердил' : type === 'visit_review' ? '✅ ответил оценкой' : '✅ ответил';
}

/** Строка запроса журнала: пустые фильтры не передаём, page=0 — тоже. */
function ntJobsQuery(f) {
  const q = new URLSearchParams();
  if (f && f.type) q.set('type', f.type);
  if (f && f.status) q.set('status', f.status);
  if (f && f.date) q.set('date', f.date);
  if (f && f.page > 0) q.set('page', String(f.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Разница «мы (план) − Chatpush» для сверки. */
function ntParityDelta(item) {
  return (Number(item && item.ours && item.ours.planned) || 0) - (Number(item && item.chatpush) || 0);
}
function ntParityDeltaText(d) { return d > 0 ? `+${d}` : String(d); }

function ntRatingsLine(st) {
  if (!st || !st.n) return 'За 30 дней оценок нет';
  return `За 30 дней: ${st.n} ${ntPlural(st.n, 'оценка', 'оценки', 'оценок')} · средняя ${st.avg == null ? '—' : st.avg}`
    + ` · высоких (4–5): ${st.high} · низких (2–3): ${st.low}`;
}

// Те же регулярки, что у детекторов бэкенда, которые решают, подхватит ли модуль ответ пациента:
// services/agent/visit-confirmation.js (isReminder) и visit-rating.js (isRatingSurvey). Ответ «Подтверждаю»/цифра
// обрабатывается, только если ПОСЛЕДНЕЕ исходящее диалога опознано по тексту. Паритет с бэкендом сверяет тест.
function ntLooksLikeReminder(text) {
  const s = String(text || '').toLowerCase().replace(/ё/g, 'е');
  return /запис|прием|визит/.test(s) && /подтвердите|подтверждени[яе]|подтверждаете/.test(s) && !/не подтвержден|отменен/.test(s);
}
function ntLooksLikeSurvey(text) {
  const s = String(text || '');
  return /оцен/i.test(s) || /от\s*2\s*до\s*5/i.test(s);
}

/** Предупреждения к тексту правила (не блокируют сохранение). Пустой текст — не предупреждаем: его ловит валидация. */
function ntTextWarnings(type, text, askConfirmation) {
  const w = [];
  if (!String(text || '').trim()) return w;
  if (type === 'visit_reminder' && askConfirmation !== false && !ntLooksLikeReminder(text)) {
    w.push('В тексте нет просьбы подтвердить визит (слово «подтвердите» вместе со словом «запись», «приём» или «визит»): ответ «Подтверждаю» не будет распознан и уйдёт как обычное сообщение клиента — его обработает Мила.');
  }
  if (type === 'visit_review' && !ntLooksLikeSurvey(text)) {
    w.push('В тексте нет слов «оцените» или «от 2 до 5»: ответ цифрой не будет принят как оценка визита и уйдёт как обычное сообщение клиента — его обработает Мила.');
  }
  return w;
}

function ntIntInRange(v, min, max) {
  if (v == null || String(v).trim() === '') return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}

/** Валидация формы правила → текст ошибки | null. Те же границы, что у parseRuleBody на бэкенде. */
function ntFormError(f) {
  if (!String(f.title || '').trim()) return 'Введите название правила';
  if (!NT_TYPES[f.type]) return 'Выберите тип уведомления';
  if (!String(f.text || '').trim()) return 'Введите текст сообщения';
  if (f.type === 'visit_reminder' && !ntIntInRange(f.hoursBefore, 1, 72)) return 'Часы до визита: целое число от 1 до 72';
  if ((f.type === 'visit_review' || f.type === 'visit_after') && !ntIntInRange(f.delayMinutes, 0, 1440)) {
    return 'Минуты после визита: целое число от 0 до 1440';
  }
  return null;
}

/**
 * Тело POST/PUT правила. isEnabled — только когда передан (булево): при СОЗДАНИИ шлём true (новое правило
 * включено сразу), при ПРАВКЕ не шлём вовсе — редактор состояние не меняет, это делает тумблер в списке, а
 * бэкенд без поля оставляет прежнее (устаревшая копия правила в открытой вкладке не должна ни включить, ни
 * выключить правило, а выключение к тому же гасит очередь). Поля типа — только своего типа.
 */
function ntBuildRuleBody(f, conditions, isEnabled) {
  const body = {
    title: String(f.title || '').trim(), triggerType: f.type, messageTemplate: String(f.text || '').trim(),
    conditions: conditions || { logic: 'and', items: [] },
  };
  if (typeof isEnabled === 'boolean') body.isEnabled = isEnabled;
  if (f.type === 'visit_reminder') {
    body.hoursBefore = Number(f.hoursBefore);
    body.askConfirmation = f.askConfirmation !== false;
  }
  if (f.type === 'visit_review' || f.type === 'visit_after') body.delayMinutes = Number(f.delayMinutes);
  if (f.type === 'record_cancelled') body.onNoShow = f.onNoShow !== false;
  return body;
}

/** Файл вложения: размер и тип проверяем сразу (сигнатуру всё равно проверит сервер). */
function ntFileError(file) {
  if (!file) return null;
  if (file.size > NT_FILE_MAX) return 'Файл больше 5 МБ';
  if (file.type && !/^image\/(jpeg|png|webp)$/.test(file.type)) return 'Формат не поддерживается: нужен JPEG, PNG или WEBP';
  return null;
}

/** Тихие часы: оба поля или ни одного (иначе бэкенд молча игнорирует окно); равные границы — окно нулевой длины. */
function ntQuietError(from, to) {
  if (!!from !== !!to) return 'Тихие часы: заполните оба поля («с» и «до») или очистите оба';
  if (from && from === to) return 'Тихие часы: начало и конец совпадают — окно нулевой длины (чтобы отключить, очистите оба поля)';
  return null;
}

/** Тело PUT /settings из значений формы + порядок каскада. */
function ntBuildSettingsBody(f, cascade) {
  return {
    mode: f.mode, default_channels: (cascade || []).slice(), prefer_last_channel: !!f.preferLast,
    quiet_from: f.quietFrom || null, quiet_to: f.quietTo || null,
    confirm_reply_text: f.confirm, rating_high_text: f.high, rating_mid_text: f.mid, rating_low_text: f.low,
    rating_escalate_low: !!f.escalate,
  };
}

/** Пустой ответ пациенту бэкенд сохранит как есть, а отбивка уйдёт пустой — запрещаем здесь. */
function ntSettingsError(body) {
  const q = ntQuietError(body.quiet_from, body.quiet_to);
  if (q) return q;
  const texts = [['confirm_reply_text', 'подтверждения визита'], ['rating_high_text', 'оценки 5'],
    ['rating_mid_text', 'оценки 4'], ['rating_low_text', 'оценки 2–3']];
  for (const [k, lbl] of texts) if (!String(body[k] || '').trim()) return `Текст ответа на ${lbl} не может быть пустым`;
  return null;
}

/** Вопросы confirm() перед сохранением настроек (по порядку). Боевой режим — только при переходе В него. */
function ntSettingsQuestions(prev, body) {
  const q = [];
  if (body.mode === 'live' && !(prev && prev.mode === 'live')) q.push(NT_LIVE_CONFIRM);
  if (body.mode !== 'off' && !(body.default_channels || []).length) q.push(NT_EMPTY_CASCADE_CONFIRM);
  return q;
}

function ntNewRule(type) {
  return {
    trigger_type: NT_TYPES[type] ? type : 'record_created', title: '', message_template: '',
    conditions: { logic: 'and', items: [] }, hours_before: 24, delay_minutes: 5,
    on_no_show: true, ask_confirmation: true, is_enabled: true, attachment_url: null, attachment_name: null,
  };
}

// ═══ 3. Состояние страницы ═════════════════════════════════════════════════

let _ntRules = [];
let _ntSettings = null;
let _ntDicts = null;                  // { staff, categories, services } — справочник условий
let _ntDictsP = null;
let _ntEditId = null;
let _ntCascade = [];                  // порядок каскада в открытой модалке настроек
let _ntLoaded = false;
let _ntJobsPage = 0;
let _ntTestRuleId = null;
// Порядковые номера запросов: ответ, пришедший позже более свежего, не должен перетереть экран.
let _ntLoadSeq = 0, _ntJobsSeq = 0, _ntRatingsSeq = 0, _ntParitySeq = 0;

// ═══ 4. Вкладки и загрузка ═════════════════════════════════════════════════

function bcSwitchTab(tab) {
  document.getElementById('bcTab-once').style.display  = tab === 'once'  ? '' : 'none';
  document.getElementById('bcTab-rules').style.display = tab === 'rules' ? '' : 'none';
  document.getElementById('bcTabBtn-once').classList.toggle('active', tab === 'once');
  document.getElementById('bcTabBtn-rules').classList.toggle('active', tab === 'rules');
  if (tab === 'rules' && !_ntLoaded) ntLoad();
}

function ntSub(name) {
  for (const n of ['rules', 'jobs', 'ratings', 'parity']) {
    document.getElementById('ntSub-' + n).style.display = n === name ? '' : 'none';
    document.getElementById('ntSubBtn-' + n).classList.toggle('active', n === name);
  }
  if (name === 'jobs') { ntFillJobTypes(); ntLoadJobs(); }
  if (name === 'ratings') ntLoadRatings();
  if (name === 'parity') ntLoadParity();
}

async function ntLoad() {
  _ntLoaded = true;
  const seq = ++_ntLoadSeq;       // сохранение, тумблер и удаление зовут ntLoad подряд — старый ответ не должен перетереть новый
  const box = document.getElementById('ntSub-rules');
  if (!_ntRules.length) { box.className = 'empty'; box.innerHTML = 'Загрузка…'; }
  try {
    // Справочник условий (живые вызовы YClients) не ждём: правила и настройки — локальная БД.
    const [r, s] = await Promise.all([api('GET', '/api/notification-rules'), api('GET', '/api/notification-rules/settings')]);
    if (seq !== _ntLoadSeq) return;
    _ntRules = (r && r.rules) || [];
    _ntSettings = s;
    ntRenderMode();
    ntRenderRules();
    // Названия условий в сводках: справочник уже есть — они уже отрисованы; нет — дорисуем по его приходу (один раз).
    // Редактор при открытии запросит справочник сам.
    if (!_ntDicts) ntEnsureDicts().then(ntRenderRules).catch(() => {});
  } catch (e) {
    if (seq !== _ntLoadSeq) return;
    _ntLoaded = false;       // следующее открытие вкладки попробует снова
    box.className = 'empty';
    box.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message)}</span> <button class="btn btn-sec btn-sm" onclick="ntLoad()">Повторить</button>`;
  }
}

function ntEnsureDicts() {
  if (_ntDicts) return Promise.resolve(_ntDicts);
  if (!_ntDictsP) {
    _ntDictsP = api('GET', '/api/notification-rules/dictionaries')
      .then((d) => { _ntDicts = d; return d; })
      .catch((e) => { _ntDictsP = null; throw e; });
  }
  return _ntDictsP;
}

function ntRenderMode() {
  const el = document.getElementById('ntModeLine');
  if (el && _ntSettings) el.textContent = ntModeLine(_ntSettings);
}

// ═══ 5. Правила: список ════════════════════════════════════════════════════

function ntRenderRules() {
  const box = document.getElementById('ntSub-rules');
  if (!box) return;
  const byType = {};
  for (const r of _ntRules) (byType[r.trigger_type] = byType[r.trigger_type] || []).push(r);
  const unknown = Object.keys(byType).filter((t) => !NT_TYPES[t]);      // тип, которого этот экран не знает, — не теряем
  const banner = _ntSettings && _ntSettings.mode === 'off'
    ? '<div class="nt-banner">⚪ Модуль выключен — правила пока ничего не делают. Тексты и условия можно готовить заранее; для сверки с Chatpush включите режим «Тень» в ⚙️ Настройках.</div>'
    : '';
  box.className = '';
  box.innerHTML = banner + [...NT_TYPE_ORDER, ...unknown].map((t) => ntTypeCard(t, byType[t] || [])).join('');
}

function ntTypeCard(t, rules) {
  const meta = NT_TYPES[t];
  const add = meta ? `<button class="btn btn-sec btn-sm" onclick="ntOpenEditor(null,'${ntJsArg(t)}')">+ Правило</button>` : '';
  return `<div class="bc-row nt-type" data-type="${ntAttr(t)}">
    <div class="nt-type-head">
      <div><b>${esc(ntTypeLabel(t))}</b><div class="care-meta" style="margin-top:2px">${esc(meta ? meta.hint : 'Неизвестный тип')}</div></div>
      ${add}
    </div>
    ${rules.length ? rules.map(ntRuleRow).join('') : '<div class="care-meta nt-norules">Правил нет</div>'}
  </div>`;
}

function ntRuleRow(r) {
  const on = !!r.is_enabled;
  const id = Number(r.id);
  const counts = [['sent_count', '✅', 'Отправлено клиентам'], ['shadow_count', '🟡', 'В тени: записано в журнал без отправки'],
    ['pending_count', '⏳', 'Ждут отправки'], ['failed_count', '❌', 'Ошибок отправки']]
    .filter(([k]) => Number(r[k]) > 0)
    .map(([k, ico, tip]) => `<span class="care-stat" title="${ntAttr(tip)}">${ico} <b>${Number(r[k])}</b></span>`).join('');
  return `<div class="nt-rule" data-id="${id}">
    <label class="tgl" title="${on ? 'Выключить правило' : 'Включить правило'}"><input type="checkbox" ${on ? 'checked' : ''}
      onchange="ntToggle(${id})"><span class="ts"></span></label>
    <div class="nt-rule-main" onclick="ntOpenEditor(${id})" title="Открыть правило">
      <div class="care-card-title"><b>${esc(r.title)}</b>${r.attachment_url ? '<span title="К сообщению приложена картинка">📎</span>' : ''}${on ? '' : '<span class="care-badge care-st-stopped">выключено</span>'}</div>
      <div class="care-meta">${esc(ntRuleSummary(r, _ntDicts))}</div>
    </div>
    <div class="care-stats nt-stats">${counts || '<span class="care-meta">отправок не было</span>'}</div>
    <button class="btn btn-sec btn-sm" onclick="ntOpenEditor(${id})">✏️ Изменить</button>
  </div>`;
}

async function ntToggle(id) {
  const cur = _ntRules.find((r) => r.id === id);
  // Выключение гасит запланированные отправки правила — необратимо: спрашиваем, когда они есть.
  if (cur && cur.is_enabled && Number(cur.pending_count) > 0
      && !confirm(`Выключить правило? Запланированные по нему отправки (${Number(cur.pending_count)}) будут отменены.`)) {
    ntRenderRules();     // тумблер уже переключился визуально — вернуть
    return;
  }
  try {
    const d = await api('POST', `/api/notification-rules/${id}/toggle`);
    notify(ntToggleMessage(d));
  } catch (e) {
    notify(e.message || 'Не удалось переключить', 'err');
  }
  await ntLoad();        // свежие счётчики (очередь могла погаснуть); при ошибке — вернёт тумблер к состоянию на сервере
}

// ═══ 6. Правила: редактор ══════════════════════════════════════════════════

async function ntOpenEditor(id, type) {
  try { await ntEnsureDicts(); }
  catch (e) { notify('Ошибка справочников: ' + e.message, 'err'); return; }
  const rule = id ? _ntRules.find((x) => x.id === id) : null;
  if (id && !rule) { notify('Правило не найдено — обновите страницу', 'err'); return; }
  _ntEditId = rule ? rule.id : null;
  const r = rule || ntNewRule(type);
  const sel = document.getElementById('ntType');
  sel.innerHTML = NT_TYPE_ORDER.map((t) => `<option value="${ntAttr(t)}">${esc(ntTypeLabel(t))}</option>`).join('');
  sel.value = r.trigger_type;
  // Тип существующего правила не меняем: его запланированные job'ы остались бы с прежним типом и текстом.
  sel.disabled = !!rule;
  sel.title = rule ? 'Тип нельзя изменить после создания — создайте новое правило' : '';
  document.getElementById('ntEditorTitle').textContent = rule ? 'Правило: ' + rule.title : 'Новое правило';
  document.getElementById('ntVars').innerHTML = NT_VARS
    .map(([tok, tip]) => `<code onclick="ntInsertVar('${ntJsArg(tok)}')" title="${ntAttr(tip)}">${esc(tok)}</code>`).join(' ');
  document.getElementById('ntTitle').value = r.title || '';
  document.getElementById('ntText').value = r.message_template || '';
  ntRenderTypeFields(r);
  condInit('ntf', _ntDicts);
  condSet('ntf', r.conditions);
  document.getElementById('ntTestBtn').style.display = rule ? '' : 'none';
  document.getElementById('ntDeleteBtn').style.display = rule ? '' : 'none';
  document.getElementById('ntSaveBtn').disabled = false;
  ntTextChanged();
  ntShowOv('ntEditorOv');
}

// Оверлей модалки не удаляется из DOM, а только прячется — сама модалка помнит прокрутку прошлого открытия:
// форма нового правила открывалась бы прокрученной вниз, без заголовка и первых полей.
function ntShowOv(id) {
  const ov = document.getElementById(id);
  const m = ov.querySelector('.modal');
  if (m) m.scrollTop = 0;
  ov.classList.add('open');
}

function ntCloseEditor() { document.getElementById('ntEditorOv').classList.remove('open'); }

/** Значения формы как есть (undefined — поля нет для этого типа). */
function ntReadForm() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const c = (id) => { const el = document.getElementById(id); return el ? el.checked : undefined; };
  return {
    title: v('ntTitle'), type: v('ntType'), text: v('ntText'), hoursBefore: v('ntHours'), delayMinutes: v('ntDelay'),
    askConfirmation: c('ntAsk'), onNoShow: c('ntNoShow'),
  };
}

/** Форма → объект, похожий на строку правила (чтобы перерисовать поля типа, не потеряв введённое). */
function ntFormRule(f, cur) {
  return {
    trigger_type: f.type, hours_before: f.hoursBefore, delay_minutes: f.delayMinutes,
    ask_confirmation: f.askConfirmation, on_no_show: f.onNoShow,
    attachment_url: cur ? cur.attachment_url : null, attachment_name: cur ? cur.attachment_name : null,
  };
}

function ntOnTypeChange() {
  const cur = _ntEditId ? _ntRules.find((x) => x.id === _ntEditId) : null;
  ntRenderTypeFields(ntFormRule(ntReadForm(), cur));
  ntTextChanged();
}

function ntRenderTypeFields(r) {
  const t = r.trigger_type;
  const meta = NT_TYPES[t] || { hint: '', sample: '' };
  document.getElementById('ntTypeHint').textContent = meta.hint;
  document.getElementById('ntText').placeholder = meta.sample;
  let html = '';
  if (t === 'visit_reminder') {
    html += `<div class="fg"><label class="fl">За сколько часов до визита</label>
        <input type="number" id="ntHours" min="1" max="72" step="1" value="${esc(String(ntHoursOr24(r.hours_before)))}"></div>
      <label class="nt-check"><input type="checkbox" id="ntAsk" ${r.ask_confirmation !== false ? 'checked' : ''} onchange="ntTextChanged()">
        <span>Просить подтверждение: ответ «Подтверждаю» или «+» ставит статус «Подтвердил» в YClients</span></label>`;
  }
  if (t === 'visit_review' || t === 'visit_after') {
    html += `<div class="fg"><label class="fl">Через сколько минут после окончания визита</label>
        <input type="number" id="ntDelay" min="0" max="1440" step="1" value="${esc(String(ntNumOr(r.delay_minutes, 5)))}"></div>`;
  }
  if (t === 'visit_after') {
    const has = !!r.attachment_url;
    html += `<div class="fg"><label class="fl">Картинка к сообщению (JPEG, PNG или WEBP, до 5 МБ)</label>
      ${has ? `<div class="nt-att">${ntUploadHref(r.attachment_url) ? `<img src="${ntAttr(r.attachment_url)}" alt="Картинка правила">` : ''}
          <div><div class="care-meta" style="margin:0 0 6px">${esc(r.attachment_name || 'файл')}</div>
          <button class="btn btn-sec btn-sm" type="button" onclick="ntDeleteAttachment()">Убрать картинку</button></div></div>` : ''}
      <input type="file" id="ntFile" accept="image/jpeg,image/png,image/webp" onchange="ntOnFile(this)">
      <div class="bc-section-hint" style="margin:4px 0 0">${has ? 'Выбранный файл заменит текущую картинку при сохранении. ' : ''}Картинка уходит вместе с текстом (текст — подписью); без картинки отправится только текст.</div></div>`;
  }
  if (t === 'record_cancelled') {
    html += `<label class="nt-check"><input type="checkbox" id="ntNoShow" ${r.on_no_show !== false ? 'checked' : ''}>
        <span>Слать, когда администратор ставит «клиент не придёт» до начала визита. Удаление записи уведомления не шлёт — как YClients</span></label>`;
  }
  document.getElementById('ntTypeFields').innerHTML = html;
}

function ntOnFile(input) {
  const f = input.files && input.files[0];
  const err = ntFileError(f);
  if (err) { notify(err, 'err'); input.value = ''; }
}

function ntTextChanged() {
  const ta = document.getElementById('ntText');
  document.getElementById('ntCharCount').textContent = String(ta.value.length);
  const f = ntReadForm();
  document.getElementById('ntTextWarn').innerHTML = ntTextWarnings(f.type, f.text, f.askConfirmation)
    .map((w) => `<div class="nt-warn">⚠️ ${esc(w)}</div>`).join('');
}

function ntInsertVar(tok) {
  const ta = document.getElementById('ntText');
  const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, s) + tok + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + tok.length;
  ta.focus();
  ntTextChanged();
}

// Загрузка картинки — multipart: api() умеет только JSON, поэтому свой fetch (как knowledge-base.js).
// TOKEN — глобальный из core/api.js.
async function ntUploadAttachment(ruleId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const headers = {};
  const tok = (typeof TOKEN !== 'undefined' && TOKEN) || localStorage.getItem('lp_tk');
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(`/api/notification-rules/${ruleId}/attachment`, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (e) { /* HTML вместо JSON (502/404) */ }
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

async function ntSave() {
  const f = ntReadForm();
  const err = ntFormError(f);
  if (err) { notify(err, 'err'); return; }
  if (condHasEmpty('ntf')) { notify('В одном из условий ничего не выбрано — выберите значения или уберите условие', 'err'); return; }
  const fileEl = document.getElementById('ntFile');
  const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
  const fileErr = ntFileError(file);
  if (fileErr) { notify(fileErr, 'err'); return; }
  const warns = ntTextWarnings(f.type, f.text, f.askConfirmation);
  if (warns.length && !confirm(warns.join('\n\n') + '\n\nСохранить всё равно?')) return;
  const body = ntBuildRuleBody(f, condGet('ntf'), _ntEditId ? undefined : true);
  const btn = document.getElementById('ntSaveBtn');
  btn.disabled = true;
  try {
    const res = _ntEditId ? await api('PUT', `/api/notification-rules/${_ntEditId}`, body)
      : await api('POST', '/api/notification-rules', body);
    const saved = res && res.rule;
    if (file && saved) {
      try { await ntUploadAttachment(saved.id, file); }
      catch (e) {
        // Правило уже сохранено — не теряем его: остаёмся в редакторе, чтобы повторить загрузку картинки.
        await ntLoad();
        await ntOpenEditor(saved.id);
        notify('Правило сохранено, но картинку загрузить не удалось: ' + e.message, 'err');
        return;
      }
    }
    notify('Правило сохранено');
    ntCloseEditor();
    await ntLoad();
  } catch (e) {
    notify(e.message || 'Не удалось сохранить', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function ntDeleteAttachment() {
  if (!_ntEditId) return;
  if (!confirm('Убрать картинку из правила? Уже запланированные отправки по нему уйдут без картинки.')) return;
  try {
    await api('DELETE', `/api/notification-rules/${_ntEditId}/attachment`);
    const cur = _ntRules.find((x) => x.id === _ntEditId);
    if (cur) { cur.attachment_url = null; cur.attachment_name = null; }
    ntRenderTypeFields(ntFormRule(ntReadForm(), cur));
    ntRenderRules();
    notify('Картинка убрана');
  } catch (e) {
    notify(e.message || 'Не удалось убрать картинку', 'err');
  }
}

async function ntDelete() {
  if (!_ntEditId) return;
  if (!confirm('Удалить правило? Запланированные по нему отправки будут отменены, журнал останется.')) return;
  try {
    await api('DELETE', `/api/notification-rules/${_ntEditId}`);
    ntCloseEditor();
    notify('Правило удалено');
    await ntLoad();
  } catch (e) {
    notify(e.message || 'Не удалось удалить', 'err');
  }
}

// ═══ 7. Тестовая отправка ══════════════════════════════════════════════════

function ntOpenTest() {
  if (!_ntEditId) return;
  _ntTestRuleId = _ntEditId;
  document.getElementById('ntTestPhone').value = localStorage.getItem('ntTestPhone') || '';
  const box = document.getElementById('ntTestResult');
  box.className = 'empty';
  box.style.color = '';
  box.textContent = 'Укажите номер и нажмите «Отправить тест»';
  document.getElementById('ntTestSendBtn').disabled = false;
  ntShowOv('ntTestOv');
}

function ntCloseTest() { document.getElementById('ntTestOv').classList.remove('open'); }

async function ntRunTest() {
  const phone = document.getElementById('ntTestPhone').value.trim();
  const box = document.getElementById('ntTestResult');
  if (!phone) { notify('Укажите номер телефона', 'err'); return; }
  localStorage.setItem('ntTestPhone', phone);
  const btn = document.getElementById('ntTestSendBtn');
  btn.disabled = true;
  box.className = 'empty';
  box.style.color = '';
  box.textContent = 'Отправляю…';
  try {
    const r = await api('POST', `/api/notification-rules/${_ntTestRuleId}/test`, { phone });
    box.style.color = '#10b981';
    box.textContent = `✅ Поставлено в очередь (режим «${ntModeInfo(r.mode).name}»): ${r.note}`;
  } catch (e) {
    // 409 в выключенном режиме: строка НЕ создаётся, текст ошибки объясняет, что включить.
    box.style.color = 'var(--danger)';
    box.textContent = e.message || 'Не удалось отправить тест';
  } finally {
    btn.disabled = false;
  }
}

// ═══ 8. Настройки салона ═══════════════════════════════════════════════════

async function ntOpenSettings() {
  if (!_ntSettings) {
    try { _ntSettings = await api('GET', '/api/notification-rules/settings'); }
    catch (e) { notify('Не удалось загрузить настройки: ' + e.message, 'err'); return; }
  }
  const s = _ntSettings;
  const set = (id, v) => { document.getElementById(id).value = v == null ? '' : v; };
  _ntCascade = [...(s.default_channels || [])];
  ntRenderCascade();
  document.getElementById('ntsPreferLast').checked = s.prefer_last_channel !== false;
  set('ntsMode', s.mode);
  set('ntsQuietFrom', s.quiet_from);
  set('ntsQuietTo', s.quiet_to);
  set('ntsConfirm', s.confirm_reply_text);
  set('ntsHigh', s.rating_high_text);
  set('ntsMid', s.rating_mid_text);
  set('ntsLow', s.rating_low_text);
  document.getElementById('ntsEscalate').checked = !!s.rating_escalate_low;
  document.getElementById('ntsSaveBtn').disabled = false;
  ntRenderModeHint();
  ntShowOv('ntSettingsOv');
}

function ntCloseSettings() { document.getElementById('ntSettingsOv').classList.remove('open'); }

function ntRenderModeHint() {
  const mode = document.getElementById('ntsMode').value;
  const el = document.getElementById('ntsModeHint');
  el.textContent = ntModeInfo(mode).desc;
  el.classList.toggle('nt-warn', mode === 'live');
}

// Каскад: включённые мессенджеры с номером шага (стрелки меняют порядок, ✕ выключает) и выключенные («+ …»).
function ntRenderCascade() {
  const on = _ntCascade, off = Object.keys(NT_CH).filter((c) => !on.includes(c));
  document.getElementById('ntsChannels').innerHTML =
    on.map((c, i) => `<span class="bc-chip on nt-ch" data-ch="${ntAttr(c)}">${i + 1}. ${esc(NT_CH[c] || c)}
      <button type="button" class="nt-ch-btn" title="Раньше" onclick="ntMoveCh(${i},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="nt-ch-btn" title="Позже" onclick="ntMoveCh(${i},1)" ${i === on.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="nt-ch-btn" title="Выключить" onclick="ntToggleCh('${ntJsArg(c)}')">✕</button></span>`).join('')
    + off.map((c) => `<span class="bc-chip nt-ch-off" data-ch="${ntAttr(c)}" onclick="ntToggleCh('${ntJsArg(c)}')">+ ${esc(NT_CH[c])}</span>`).join('');
}

function ntToggleCh(c) {
  const i = _ntCascade.indexOf(c);
  if (i >= 0) _ntCascade.splice(i, 1); else _ntCascade.push(c);
  ntRenderCascade();
}

function ntMoveCh(i, d) {
  const j = i + d;
  if (j < 0 || j >= _ntCascade.length) return;
  [_ntCascade[i], _ntCascade[j]] = [_ntCascade[j], _ntCascade[i]];
  ntRenderCascade();
}

async function ntSaveSettings() {
  const v = (id) => document.getElementById(id).value;
  const body = ntBuildSettingsBody({
    mode: v('ntsMode'), preferLast: document.getElementById('ntsPreferLast').checked,
    quietFrom: v('ntsQuietFrom'), quietTo: v('ntsQuietTo'),
    confirm: v('ntsConfirm'), high: v('ntsHigh'), mid: v('ntsMid'), low: v('ntsLow'),
    escalate: document.getElementById('ntsEscalate').checked,
  }, _ntCascade);
  const err = ntSettingsError(body);
  if (err) { notify(err, 'err'); return; }
  for (const q of ntSettingsQuestions(_ntSettings, body)) if (!confirm(q)) return;
  const btn = document.getElementById('ntsSaveBtn');
  btn.disabled = true;
  try {
    _ntSettings = await api('PUT', '/api/notification-rules/settings', body);
    notify('Настройки сохранены');
    ntCloseSettings();
    ntRenderMode();
    ntRenderRules();       // плашка «модуль выключен» зависит от режима
  } catch (e) {
    notify(e.message || 'Не удалось сохранить настройки', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ═══ 9. Журнал ═════════════════════════════════════════════════════════════

function ntFillJobTypes() {
  const sel = document.getElementById('ntJobType');
  if (!sel || sel.options.length > 1) return;
  sel.innerHTML = '<option value="">Все типы</option>'
    + NT_TYPE_ORDER.map((t) => `<option value="${ntAttr(t)}">${esc(ntTypeLabel(t))}</option>`).join('');
}

function ntJobsFilterChanged() { _ntJobsPage = 0; ntLoadJobs(); }

function ntJobsReset() {
  for (const id of ['ntJobType', 'ntJobStatus', 'ntJobDate']) document.getElementById(id).value = '';
  ntJobsFilterChanged();
}

function ntJobsPage(delta) {
  _ntJobsPage = Math.max(0, _ntJobsPage + delta);
  ntLoadJobs();
}

async function ntLoadJobs() {
  const seq = ++_ntJobsSeq;
  const list = document.getElementById('ntJobsList');
  const pager = document.getElementById('ntJobsPager');
  list.innerHTML = '<div class="empty">Загрузка…</div>';
  pager.innerHTML = '';
  try {
    const d = await api('GET', '/api/notification-rules/jobs' + ntJobsQuery({
      type: document.getElementById('ntJobType').value, status: document.getElementById('ntJobStatus').value,
      date: document.getElementById('ntJobDate').value, page: _ntJobsPage,
    }));
    if (seq !== _ntJobsSeq) return;
    const items = (d && d.items) || [];
    list.innerHTML = `<div class="card care-tbl-card" style="padding:0"><div class="tw mtbl-wrap"><table class="mtbl">
      <thead><tr><th>Когда</th><th>Клиент</th><th>Уведомление</th><th>Статус</th><th>Текст</th><th></th></tr></thead>
      <tbody>${items.length ? items.map(ntJobRow).join('') : '<tr><td colspan="6" class="empty">Записей нет</td></tr>'}</tbody></table></div></div>`;
    // Размер страницы — LIMIT 100 у GET /jobs: меньше сотни строк значит последняя страница.
    pager.innerHTML = (_ntJobsPage > 0 || items.length >= NT_JOBS_PAGE) ? `<div class="nt-pager">
      <button class="btn btn-sec btn-sm" onclick="ntJobsPage(-1)" ${_ntJobsPage > 0 ? '' : 'disabled'}>← Назад</button>
      <span>Страница ${_ntJobsPage + 1}</span>
      <button class="btn btn-sec btn-sm" onclick="ntJobsPage(1)" ${items.length >= NT_JOBS_PAGE ? '' : 'disabled'}>Дальше →</button></div>` : '';
  } catch (e) {
    if (seq !== _ntJobsSeq) return;
    list.innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

function ntJobRow(j) {
  const st = ntStatus(j.status);
  const when = ntJobWhen(j);
  const who = j.client_name || j.phone || '—';
  const steps = ntCascadeSteps(j.cascade_log);
  const path = steps.length
    ? `<div class="nt-path">${steps.map((s) => `<span title="${ntAttr(s.err)}">${esc(s.text)}</span>`).join(' → ')}</div>` : '';
  const reply = j.confirmed_at ? `<div class="nt-path nt-ok">${esc(ntReplyLabel(j.trigger_type))} ${esc(ntFmt(j.confirmed_at))}</div>` : '';
  const reason = j.decision_reason || j.error || '';
  const text = j.rendered_text || '';
  const isTest = String(j.yclients_record_id) === '0';     // BIGINT приходит строкой; у тестовых отправок id записи 0
  const attHref = ntUploadHref(j.attachment_url);
  const att = attHref ? ` <a href="${ntAttr(attHref)}" target="_blank" rel="noopener" title="Открыть картинку">📎</a>`
    : j.attachment_url ? ' <span title="К сообщению приложена картинка">📎</span>' : '';       // чужой/странный адрес — без ссылки
  return `<tr data-id="${Number(j.id)}" data-status="${ntAttr(j.status)}">
    <td data-label="Когда"><span>${esc(ntFmt(when.ts))}${when.plan ? ' <span class="nt-plan">(план)</span>' : ''}</span></td>
    <td class="mtbl-title"><b>${esc(who)}</b>${j.client_name && j.phone ? `<div class="care-meta" style="margin-top:2px">${esc(j.phone)}</div>` : ''}</td>
    <td data-label="Уведомление">${esc(ntTypeLabel(j.trigger_type))}${isTest ? ' <span class="bc-chip" title="Тестовая отправка администратором">тест</span>' : ''}
      <div class="care-meta" style="margin-top:2px">${esc(j.rule_title || '')}</div>${j.visit_datetime ? `<div class="care-meta">визит ${esc(ntFmt(j.visit_datetime))}</div>` : ''}</td>
    <td data-label="Статус"><span class="care-badge" style="background:${st.color}22;color:${st.color}">${esc(st.lbl)}</span>${j.channel_used ? ` · ${esc(NT_CH[j.channel_used] || j.channel_used)}` : ''}
      ${path}${reply}${reason ? `<div class="nt-path">${esc(reason)}</div>` : ''}</td>
    <td class="mtbl-full mtbl-hide-empty nt-text" data-label="Текст" title="${ntAttr(text)}">${text ? esc(text.slice(0, 220)) + (text.length > 220 ? '…' : '') + att : ''}</td>
    <td class="mtbl-act mtbl-hide-empty">${j.status === 'pending' ? `<button class="btn btn-sec btn-sm" onclick="ntCancelJob(${Number(j.id)})">Отменить</button>` : ''}</td>
  </tr>`;
}

async function ntCancelJob(id) {
  if (!confirm('Отменить запланированную отправку?')) return;
  try {
    const d = await api('POST', `/api/notification-rules/jobs/${id}/cancel`);
    const o = ntCancelOutcome(d);        // {ok:false} — строки уже нет в очереди: «отменено» говорить нельзя
    notify(o.text, o.type);
    await ntLoadJobs();                  // в обоих случаях журнал показывает фактическое состояние
  } catch (e) {
    notify(e.message || 'Не удалось отменить', 'err');
  }
}

// ═══ 10. Оценки и сверка ═══════════════════════════════════════════════════

async function ntLoadRatings() {
  const seq = ++_ntRatingsSeq;
  const box = document.getElementById('ntRatingsBody');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const d = await api('GET', '/api/notification-rules/ratings');
    if (seq !== _ntRatingsSeq) return;
    const items = (d && d.items) || [];
    box.innerHTML = `<div class="card" style="padding:12px 14px;margin-bottom:10px;font-size:13px">${esc(ntRatingsLine(d && d.stats))}</div>
      <div class="card care-tbl-card" style="padding:0"><div class="tw mtbl-wrap"><table class="mtbl">
      <thead><tr><th>Дата</th><th>Клиент</th><th>Оценка</th><th>Комментарий</th></tr></thead>
      <tbody>${items.length ? items.map((v) => `<tr>
        <td data-label="Дата">${esc(ntFmt(v.created_at))}</td>
        <td class="mtbl-title"><b>${esc(v.client_name || v.phone || '—')}</b>${v.client_name && v.phone ? `<div class="care-meta" style="margin-top:2px">${esc(v.phone)}</div>` : ''}</td>
        <td data-label="Оценка"><b style="color:${Number(v.rating) >= 4 ? '#10b981' : '#ef4444'}">${esc(String(v.rating))}</b></td>
        <td class="mtbl-full mtbl-hide-empty" data-label="Комментарий">${v.comment ? esc(v.comment) : ''}</td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">Оценок пока нет</td></tr>'}</tbody></table></div></div>`;
  } catch (e) {
    if (seq !== _ntRatingsSeq) return;
    box.innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

async function ntLoadParity() {
  const seq = ++_ntParitySeq;
  const box = document.getElementById('ntParityBody');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const d = await api('GET', '/api/notification-rules/parity?days=' + encodeURIComponent(document.getElementById('ntParityDays').value));
    if (seq !== _ntParitySeq) return;
    const items = (d && d.items) || [];
    box.innerHTML = `<div class="care-meta" style="margin:0 0 10px">За ${Number(d && d.days) || ''} дн.: наши job'ы (отправлено + тень) против служебных сообщений Chatpush того же типа.
      Разница в единицы — норма (чёрный список, нет телефона, разный момент «пришёл»).</div>
      <div class="card care-tbl-card" style="padding:0"><div class="tw mtbl-wrap"><table class="mtbl">
      <thead><tr><th>Тип</th><th>Мы (план)</th><th>Пропущено</th><th>Отменено</th><th>Chatpush</th><th>Разница</th></tr></thead>
      <tbody>${items.map((i) => `<tr>
        <td class="mtbl-title"><b>${esc(ntTypeLabel(i.triggerType))}</b></td>
        <td data-label="Мы (план)">${Number(i.ours && i.ours.planned) || 0}</td>
        <td data-label="Пропущено">${Number(i.ours && i.ours.skipped) || 0}</td>
        <td data-label="Отменено">${Number(i.ours && i.ours.cancelled) || 0}</td>
        <td data-label="Chatpush">${Number(i.chatpush) || 0}</td>
        <td data-label="Разница"><b>${esc(ntParityDeltaText(ntParityDelta(i)))}</b></td></tr>`).join('')}</tbody></table></div></div>`;
  } catch (e) {
    if (seq !== _ntParitySeq) return;
    box.innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}
