#!/usr/bin/env python3
"""Готовит выгрузку переписок с прода от 08.10.2026 (exports/chat_history_messages.csv)
к загрузке в chatpush_messages — после потери прод-БД на Beget (02.11.2026).

Выход — TSV для COPY в staging-таблицу (см. chat-history-import.sql).
Ключ диалога воспроизводит DIALOG_KEY_SQL (services/chat.js): 'g:<chat_id>' у групп,
иначе phone, иначе chat_id. Время — msg_ts в секундах (как у вебхука), из МСК.
external_message_id синтетический и стабильный: повторная загрузка не задваивает.
"""
import csv, sys, hashlib, datetime, re
from email.utils import parsedate_to_datetime
MSK = datetime.timezone(datetime.timedelta(hours=3))
AUTH = {'клиент': (None, 'incoming'), 'администратор': ('operator', 'outgoing'),
        'Мила (бот)': ('agent', 'outgoing'), 'авто-уведомление': ('system', 'outgoing')}
def ts(s):
    if re.match(r'^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$', s):
        return int(datetime.datetime.strptime(s, '%Y-%m-%d %H:%M:%S').replace(tzinfo=MSK).timestamp())
    m = re.match(r'^\w{3} (\w{3} \d\d \d{4} \d\d:\d\d:\d\d) GMT\+0300', s)  # «Sat Jul 18 2026 15:08:49 GMT+0300»
    return int(datetime.datetime.strptime(m.group(1), '%b %d %Y %H:%M:%S').replace(tzinfo=MSK).timestamp())
def esc(v):
    if v is None or v == '': return r'\N'
    return str(v).replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n').replace('\r', '\\r')
src, dst = sys.argv[1], sys.argv[2]
n = 0
with open(src, encoding='utf-8-sig') as f, open(dst, 'w', encoding='utf-8') as out:
    for r in csv.DictReader(f):
        key, phone = r['dialog_key'], r['phone'] or None
        if key.startswith('g:'):
            chat_id = key[2:]
        elif key == phone:
            chat_id = None
        else:
            chat_id, phone = key, None
        authored, direction = AUTH[r['author']]
        t = ts(r['datetime_msk'])
        ext = 'import-20261008:' + hashlib.sha1(f"{key}|{r['msg_index']}|{r['datetime_msk']}".encode()).hexdigest()[:24]
        is_group = key.startswith('g:')
        sender = None if (is_group or direction == 'outgoing') else (r['client_name'] or None)
        out.write('\t'.join(esc(x) for x in [r['channel'], direction, ext, r['msg_type'] or 'text', r['text'],
                                             r['file_url'], sender, phone, chat_id, t, authored, key]) + '\n')
        n += 1
print('rows', n)
