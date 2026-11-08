'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
const { db } = require('./db');
const { buildCascade, recipientFor, CASCADE_CHANNELS } = require('./services/notifications/cascade');
const { lastConversation } = require('./services/notifications/rules');

describe('buildCascade', () => {
  test('порядок из настроек, без дублей и неизвестных каналов', () => {
    expect(buildCascade(['tdlib', 'whatsapp', 'tdlib', 'sms', 'max'])).toEqual(['tdlib', 'whatsapp', 'max']);
  });
  test('мессенджер последней переписки встаёт первым', () => {
    expect(buildCascade(['tdlib', 'whatsapp', 'max'], { preferLast: true, lastChannel: 'max' })).toEqual(['max', 'tdlib', 'whatsapp']);
  });
  test('флаг выключен — последняя переписка не влияет', () => {
    expect(buildCascade(['tdlib', 'whatsapp'], { preferLast: false, lastChannel: 'whatsapp' })).toEqual(['tdlib', 'whatsapp']);
  });
  test('мессенджер последней переписки выключен в настройках — не добавляется', () => {
    expect(buildCascade(['tdlib', 'whatsapp'], { preferLast: true, lastChannel: 'max' })).toEqual(['tdlib', 'whatsapp']);
  });
  test('пустые/битые настройки → пустой каскад', () => {
    expect(buildCascade(null)).toEqual([]);
    expect(buildCascade('tdlib')).toEqual([]);
  });
  test('поддерживаемые каналы — ровно три мессенджера шлюза', () => {
    expect(CASCADE_CHANNELS).toEqual(['tdlib', 'whatsapp', 'max']);
  });
});

describe('recipientFor', () => {
  test('WhatsApp — только по номеру', () => {
    expect(recipientFor('whatsapp', '79200255591', {})).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(recipientFor('whatsapp', null, { whatsapp: 'x' })).toBeNull();
  });
  test('Telegram — id собеседника главнее номера (скрытый номер)', () => {
    expect(recipientFor('tdlib', '79200255591', { tdlib: '385578542' })).toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542' });
    expect(recipientFor('tdlib', '79200255591', {})).toEqual({ dispatchRouting: ['tdlib'], phone: '79200255591' });
  });
  test('MAX — номер и id собеседника вместе', () => {
    expect(recipientFor('max', '79200255591', { max: '62232990' })).toEqual({ dispatchRouting: ['max'], phone: '79200255591', max_user_id: '62232990' });
    expect(recipientFor('max', '79200255591', {})).toEqual({ dispatchRouting: ['max'], phone: '79200255591' });
  });
  test('номер нормализуется к 7XXXXXXXXXX, мусор — нет адресата', () => {
    expect(recipientFor('whatsapp', '+7 (920) 025-55-91', {})).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(recipientFor('whatsapp', '12345', {})).toBeNull();
    expect(recipientFor('tdlib', '', {})).toBeNull();
  });
  test('неизвестный канал → null', () => {
    expect(recipientFor('sms', '79200255591', {})).toBeNull();
  });
});

// id чата из переписки годится в адресаты, только если это ЧИСЛО. Отрицательный id шлюз
// считает группой — карточка записи пациента ушла бы в группу; 'g:…' — ключ диалога админки;
// 'e2e-chat' и прочее нечисловое — мусор. Негодный id = «id неизвестен».
describe('recipientFor: id чата — только число', () => {
  const BAD_IDS = ['-1003759304044', '-5', 'g:-1003759304044', 'g:385578542', 'e2e-chat', '385578542x',
    '385 578542', '3.85', '+385578542', '', '   ', '0', '007', '1234567890123456789'];

  test.each(BAD_IDS)('Telegram: id %j неизвестен → откат на номер', (bad) => {
    expect(recipientFor('tdlib', '79200255591', { tdlib: bad })).toEqual({ dispatchRouting: ['tdlib'], phone: '79200255591' });
  });
  test.each(BAD_IDS)('MAX: id %j неизвестен → только номер, без max_user_id', (bad) => {
    expect(recipientFor('max', '79200255591', { max: bad })).toEqual({ dispatchRouting: ['max'], phone: '79200255591' });
  });
  test('номера нет и годного id нет → адресата нет (в группу не пишем)', () => {
    expect(recipientFor('tdlib', null, { tdlib: '-1003759304044' })).toBeNull();
    expect(recipientFor('tdlib', '', { tdlib: 'g:5' })).toBeNull();
    expect(recipientFor('max', null, { max: '-77' })).toBeNull();
    expect(recipientFor('max', '', { max: 'e2e-chat' })).toBeNull();
  });
  test('пробелы вокруг числа срезаются, id уходит обрезанным', () => {
    expect(recipientFor('tdlib', null, { tdlib: ' 385578542 ' })).toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542' });
    expect(recipientFor('max', '79200255591', { max: '\t62232990\n' })).toEqual({ dispatchRouting: ['max'], phone: '79200255591', max_user_id: '62232990' });
  });
  test('число (не строка) принимается как id; отрицательное — нет', () => {
    expect(recipientFor('tdlib', null, { tdlib: 385578542 })).toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542' });
    expect(recipientFor('tdlib', '79200255591', { tdlib: -100500 })).toEqual({ dispatchRouting: ['tdlib'], phone: '79200255591' });
  });
  test('id чужого канала не подставляется', () => {
    expect(recipientFor('whatsapp', '79200255591', { tdlib: '385578542', max: '62232990' })).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(recipientFor('max', '79200255591', { tdlib: '385578542' })).toEqual({ dispatchRouting: ['max'], phone: '79200255591' });
  });
});

// ── lastConversation (rules.js): запросы к chatpush_messages, БД замокана ──
// Валидность самого SQL и план (индекс idx_chatpush_messages_dialog) проверены живым
// EXPLAIN на дев-БД — моки её не проверяют. Оба запроса идут через db.any: первый
// (DISTINCT ON) отдаёт id личных чатов, второй — окно последних входящих.
describe('lastConversation', () => {
  const FORMS = ['79200255591', '+79200255591', '89200255591', '9200255591'];
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
  const orderBy = (sql) => (norm(sql).match(/ORDER BY .*?(?= LIMIT |$)/) || [''])[0];
  // Раздаёт строки по тексту запроса: DISTINCT ON → чаты, остальное → окно входящих.
  const feed = ({ chats = [], incoming = [] } = {}) => db.any.mockImplementation(async (sql) => (/DISTINCT ON/.test(sql) ? chats : incoming));
  const chatsSql = () => db.any.mock.calls.find(([sql]) => /DISTINCT ON/.test(sql))[0];
  const incomingSql = () => db.any.mock.calls.find(([sql]) => !/DISTINCT ON/.test(sql))[0];

  beforeEach(() => {
    jest.clearAllMocks();
    feed();
  });

  test('мусорный номер → пусто и ни одного запроса к БД', async () => {
    for (const bad of [null, undefined, '', '12345', 'abc', '+998 90 123 45 67']) {
      expect(await lastConversation(1, bad)).toEqual({ lastChannel: null, chats: {} });
    }
    expect(db.any).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('оба запроса ищут по ВСЕМ формам номера и скоупятся по салону', async () => {
    await lastConversation(7, '+7 (920) 025-55-91');
    expect(db.any).toHaveBeenCalledTimes(2);
    for (const [sql, params] of db.any.mock.calls) {
      expect(sql).toMatch(/salon_id\s*=\s*\$1/);
      expect(sql).toMatch(/phone\s*=\s*ANY\(\$2\)/);
      expect(params).toEqual([7, FORMS]);
    }
  });

  test('номер в любой записи даёт те же формы (8…, 10 цифр)', async () => {
    await lastConversation(1, '89200255591');
    await lastConversation(1, '9200255591');
    expect(db.any.mock.calls[0][1]).toEqual([1, FORMS]);
    expect(db.any.mock.calls[2][1]).toEqual([1, FORMS]);
  });

  test('chats — id личных чатов Telegram/MAX по каналам', async () => {
    feed({ chats: [{ channel: 'max', chat_id: '62232990' }, { channel: 'tdlib', chat_id: '385578542' }] });
    const r = await lastConversation(1, '79200255591');
    expect(r.chats).toEqual({ tdlib: '385578542', max: '62232990' });
  });

  test('SQL чатов уже отсекает группы (до DISTINCT ON), только tdlib/max, только непустой chat_id', async () => {
    await lastConversation(1, '79200255591');
    const sql = chatsSql();
    expect(sql).toMatch(/DISTINCT ON \(channel\)/);
    expect(sql).toMatch(/channel IN \('tdlib','max'\)/);
    expect(sql).toMatch(/chat_id NOT LIKE '-%'/);
    expect(sql).toMatch(/chat_id NOT LIKE 'g:%'/);
    expect(sql).toMatch(/COALESCE\(chat_id,''\) <> ''/);
  });

  test('группы не попадают в chats и после SQL: общий признак group-chat.isGroupChatId — последнее слово', async () => {
    feed({ chats: [
      { channel: 'tdlib', chat_id: '-1003759304044' },   // супергруппа Telegram
      { channel: 'max', chat_id: 'g:-5' },               // ключ диалога админки
    ] });
    expect((await lastConversation(1, '79200255591')).chats).toEqual({});
    feed({ chats: [{ channel: 'tdlib', chat_id: '120363025@g.us' }, { channel: 'max', chat_id: '77@broadcast' }] });
    expect((await lastConversation(1, '79200255591')).chats).toEqual({});
  });

  // msg_ts в секундах: два сообщения одной секунды (входящее и наш ответ, пара быстрых
  // реплик) без тай-брейка отдавали бы случайную строку — и чат, и канал «прыгали» бы.
  // Мок не исполняет SQL, поэтому порядок проверяется по тексту: мутация ORDER BY
  // (убрать id, развернуть msg_ts, потерять channel — а без него DISTINCT ON не исполнится
  // вовсе) делает тест красным.
  test('порядок запроса чатов: канал (под DISTINCT ON), свежее по msg_ts, при равенстве — больший id', async () => {
    await lastConversation(1, '79200255591');
    expect(orderBy(chatsSql())).toBe('ORDER BY channel, msg_ts DESC NULLS LAST, id DESC');
  });

  test('порядок запроса входящих: свежее по msg_ts, при равенстве — больший id', async () => {
    await lastConversation(1, '79200255591');
    expect(orderBy(incomingSql())).toBe('ORDER BY msg_ts DESC NULLS LAST, id DESC');
  });

  // ── lastChannel: канал последней ЛИЧНОЙ переписки ──
  test('lastChannel — канал последнего ВХОДЯЩЕГО, telegram_bot приводится к telegram', async () => {
    feed({ incoming: [{ channel: 'max', chat_id: '62232990' }] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('max');
    feed({ incoming: [{ channel: 'telegram_bot', chat_id: '12345' }] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('telegram');
    feed({ incoming: [] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBeNull();
    expect(incomingSql()).toMatch(/direction\s*=\s*'incoming'/);
  });

  test('SQL входящих — те же фильтры личной переписки, что у чатов; пустой chat_id считается личным', async () => {
    await lastConversation(1, '79200255591');
    const sql = incomingSql();
    // NULL-безопасно: «chat_id NOT LIKE …» на NULL даёт NULL и выбросило бы строки без chat_id,
    // а DIALOG_KEY_SQL считает их личными (ключ — номер).
    expect(sql).toMatch(/COALESCE\(chat_id,''\) NOT LIKE '-%'/);
    expect(sql).toMatch(/COALESCE\(chat_id,''\) NOT LIKE 'g:%'/);
    // Первую ЛИЧНУЮ строку выбирает JS из окна: LIMIT 1 оставил бы его без выбора, и свежая
    // WhatsApp-группа (SQL её не видит) глушила бы сигнал последней переписки.
    expect(Number((norm(sql).match(/ LIMIT (\d+)$/) || [])[1])).toBeGreaterThanOrEqual(10);
  });

  test('групповое входящее не задаёт lastChannel: общий признак пропускает WhatsApp-группы и рассылки', async () => {
    feed({ incoming: [
      { channel: 'whatsapp', chat_id: '120363025@g.us' },     // группа WhatsApp — свежее всех
      { channel: 'whatsapp', chat_id: '77@broadcast' },       // рассылка/статус
      { channel: 'max', chat_id: '62232990' },                // первая ЛИЧНАЯ
      { channel: 'tdlib', chat_id: '385578542' },
    ] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('max');
  });

  test('в окне одни группы → lastChannel не определён (порядок по настройкам салона)', async () => {
    feed({ incoming: [{ channel: 'whatsapp', chat_id: '1@g.us' }, { channel: 'tdlib', chat_id: '-100' }, { channel: 'max', chat_id: 'g:-5' }] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBeNull();
  });

  test('входящее без chat_id (NULL/пусто) — личное: канал учитывается', async () => {
    feed({ incoming: [{ channel: 'whatsapp', chat_id: null }] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('whatsapp');
    feed({ incoming: [{ channel: 'max', chat_id: '' }] });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('max');
  });
});
