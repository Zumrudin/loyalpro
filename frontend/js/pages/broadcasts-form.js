// ── РАССЫЛКА ЧЕРЕЗ МЕССЕНДЖЕРЫ: чистые помощники формы ───────────────────────────────────────
// Без DOM и сети — тестируются в vm (broadcasts-form.test.js). Глобальные имена только bc*/BC_*:
// файл делит одну область с остальными страницами.

const BC_CHANNELS = [
  { key: 'tdlib',    label: 'Telegram', delay: 60 },
  { key: 'whatsapp', label: 'WhatsApp', delay: 180 },
  { key: 'max',      label: 'MAX',      delay: 60 },
];

// read — функция «id элемента → значение» (в браузере поверх getElementById, в тесте — словарь).
// Чекбокс отдаёт boolean, поля — строку. Пустой лимит = null («без лимита»), пустая пауза — дефолт канала.
function bcCollectChannelSettings(read) {
  const out = {};
  for (const ch of BC_CHANNELS) {
    const delayRaw = String(read(`bcCh-${ch.key}-delay`) ?? '').trim();
    const limitRaw = String(read(`bcCh-${ch.key}-limit`) ?? '').trim();
    out[ch.key] = {
      enabled: !!read(`bcCh-${ch.key}-on`),
      // Не число оставляем NaN-строкой нельзя: валидация должна увидеть ошибку, поэтому кладём как есть.
      delay_sec: delayRaw === '' ? ch.delay : Number(delayRaw),
      limit: limitRaw === '' ? null : Number(limitRaw),
    };
  }
  return out;
}

function bcFmtDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

// Время окончания по Москве (сервер считает окно 09–21 по Москве, а браузер может быть в другом поясе).
function bcFmtClock(ms) {
  const p = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  return p;
}

// Прогноз → строка. Итог (всего/пропущено) показываем первым: перед запуском должно быть видно,
// сколько человек реально получит сообщение (риск §10 спеки).
function bcFormatForecast(r) {
  if (!r) return '';
  const parts = [];
  const total = Number(r.total) || 0;
  const skipped = Number(r.skipped) || 0;
  let head = `Всего ${total}`;
  if (skipped > 0) {
    const sb = r.skippedBy || {};
    const why = [];
    if (sb.blacklist) why.push(`чёрный список ${sb.blacklist}`);
    if (sb.no_recipient) why.push(`нет адресата ${sb.no_recipient}`);
    head += ` · пропущено ${skipped}${why.length ? ` (${why.join(', ')})` : ''}`;
  }
  parts.push(head);
  const by = r.byChannel || {};
  for (const ch of BC_CHANNELS) if (by[ch.key] > 0) parts.push(`${ch.label} ${by[ch.key]}`);
  if (by.none > 0) parts.push(`без мессенджера ${by.none}`);
  if (r.finishAt != null) {
    parts.push(`≈ ${bcFmtDuration(r.durationMin)}, закончится ${r.nextDay ? 'завтра' : 'сегодня'} в ${bcFmtClock(r.finishAt)}`);
  }
  return parts.join(' · ');
}

// v: { audienceSource, list, hasFilters?, messageTemplate, channelSettings, imageUploading? }.
// Зеркало серверного parseCreateBody (service.js), тексты по-русски. Возвращает массив ошибок.
function bcValidateMessengerForm(v) {
  const errs = [];
  const f = v || {};
  if (f.audienceSource === 'list') {
    if (!Array.isArray(f.list) || !f.list.length) errs.push('Загрузите список и нажмите «Разобрать»');
    else if (f.list.length > 10000) errs.push('В списке больше 10000 получателей');
  }
  const text = typeof f.messageTemplate === 'string' ? f.messageTemplate : '';
  if (!text.trim()) errs.push('Введите текст сообщения');
  else if (text.length > 4000) errs.push('Сообщение слишком длинное (макс 4000 символов)');
  const cs = f.channelSettings || {};
  let any = false;
  for (const ch of BC_CHANNELS) {
    const c = cs[ch.key];
    if (!c || !c.enabled) continue;
    any = true;
    if (!Number.isInteger(c.delay_sec) || c.delay_sec < 0 || c.delay_sec > 3600) {
      errs.push(`${ch.label}: пауза между сообщениями — целое число от 0 до 3600 секунд`);
    }
    if (c.limit != null && (!Number.isInteger(c.limit) || c.limit < 1 || c.limit > 10000)) {
      errs.push(`${ch.label}: лимит — целое число от 1 до 10000 или пусто`);
    }
  }
  if (!any) errs.push('Включите хотя бы один мессенджер');
  if (f.imageUploading) errs.push('Дождитесь окончания загрузки картинки');
  return errs;
}
