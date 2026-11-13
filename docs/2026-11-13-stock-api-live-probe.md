# Пробы чтения API склада YClients (13.11.2026)

Скрипт `backend/scripts/stock-api-probe.js` — только GET, салон 1 (дев-БД, боевой YClients). Полные тела — `/tmp/stock-api-probe/*.json` (не в git). PII в отчёте нет.

| шаг | статус | ключевой вывод |
|---|---|---|
| 1 `/storages/{cid}` | ok | 2 склада: 1334902 «Расходники», 1334903 «Космоцевтика» |
| 2 `/goods/{cid}/{id}` ×3 | ok | `actual_amounts` — массив `{storage_id, amount}` по складам; см. (а) |
| 3 `/goods/{cid}?count=100&page=1` | ok | 31 поле, все ожидаемые на месте; см. (б) |
| 4 `/goods_categories/{cid}/{id}` | ok | 31 узел, глубина 3, 32 запроса; см. (в) |
| 5 `record_consumables` (запись 2144720275 клиента 79200255591) | ok | у записи пусто: `consumables: []`, `technological_cards: []` |
| 5b то же, запись со списаниями (2144276315) | ok | непустая форма; см. (г) |
| 6 `/storages/transactions` `changed_after` | ok | 100 строк, поля есть; см. ниже |

## Ответы

**(а) Единицы `actual_amounts`: в единицах ПРОДАЖИ (`unit_short_title`), дробные — вероятно, но не доказано полностью.**
- «Диспорт 300ед» (`unit_equals=300`, `unit_short_title=фл`, `service_unit_short_title=ед`): склад «Расходники» = **40**. 40 флаконов правдоподобно, 12 000 ед — нет. Наших зеркальных транзакций у него 2 (поступление 30, `operation_unit_type=1`), приход за пределами окна зеркала не виден.
- «LIP мыло» (`unit_equals=500`, `шт`/`мл`): остаток **−8,118** — дробное число, как и должно быть при пересчёте списаний в мл на штуки. Наши списания: −340,31 (`operation_unit_type=2`, т.е. в единицах списания) при зеркале с 02.08, по-прежнему не сверить напрямую.
- «Бальзам для губ» (`unit_equals=1`): остаток −202, наши списания −23 — единицы совпадают по определению, расхождение из-за неполной истории зеркала (первая транзакция 01.08.2026).
- Точная сверка суммы зеркала с остатком невозможна: история зеркала начинается с августа. Чтобы доказать, нужна нулевая точка (инвентаризация) или товар, заведённый после 01.08. **Не проверено строго** — считать «единицы продажи» рабочей гипотезой. Остаток может быть отрицательным.

**(б) Поля `/goods`** (первый элемент): `title, value, label, article, category, category_id, salon_id, good_id, cost, unit_id, unit_short_title, service_unit_id, service_unit_short_title, actual_cost, unit_actual_cost, unit_actual_cost_format, unit_equals, barcode, is_chain, comment, loyalty_abonement_type_id, loyalty_certificate_type_id, loyalty_certificate_type, loyalty_allow_empty_code, loyalty_serial_number_limited, actual_amounts, critical_amount, desired_amount, last_change_date, is_goods_mark_enabled, loyalty_expiration_type_id`. Из ожидаемых (`cost, barcode, unit_id, service_unit_id, critical_amount, desired_amount, comment, loyalty_abonement_type_id, loyalty_certificate_type_id, last_change_date, actual_amounts`) **отсутствующих нет**.

**(в) Дерево категорий:** 31 узел, максимальная глубина 3, корневых 7 (корень запрашивается как `/goods_categories/{cid}/0`; ответ — плоский список с `parent_category_id`, `is_chain`). Корни: «Абонементы Сеть Peri Clinic» (chain), «Сертификаты Сеть Peri Clinic» (chain), «Канцелярия», «Косметика», «Расходники». Пути:
- Косметика > ALLIES / Forlled / Genosys / GIGI / HELEO4 / HELIOCARE / JAN MARINI / Luscious Lips / Masktini / Medic Control Peel / MELINE / MESALTERA / Peri Clinic / Phyto - C / Rejudicare / Reviderm / Skin Formula / TIZO / Коллаген / Шампуни
- Расходники > Аптека / Основные товары / Препараты
- Расходники > Препараты > STYLAGE / РЕВИ / Филлеры

**(г) `record_consumables`:** ответ — МАССИВ по услугам записи (не объект): `[{service_id, record_id, technological_cards, consumables}]`. `consumables[]`: `{goods_transaction_id, record_id, service_id, storage_id, good_id, price, amount, good:{id,title,unit,is_chain}}`. `technological_cards[]`: `{id, title, technological_card_items:[{id, technological_card_id, storage_id, good_id, amount, price, good}]}`. Если списаний/техкарт нет — оба массива пустые (запись 2144720275).

## Шаг 6 `/storages/transactions`
Строка: `id, document_id, type_id, type, operation_unit_type, amount, create_date, cost_per_unit, cost, discount, comment, record_id, last_change_date, loyalty_abonement_id, loyalty_certificate_id, good, unit, storage, client, master, service, supplier`.
- `comment` — строка (в выборке 100 строк непустых 0).
- `client` — объект `{id, name, phone}` (непустой в 92 из 100; содержит PII) либо пустой массив.
- `master` — объект `{id, title}` (непустой в 1 из 100) либо `[]`; `supplier` — всегда `[]` в выборке.
- `unit` — `{id, title, short_title}`, `storage`/`good` — `{id, title}`, `type` — строка («Списание расходников»).
- Пустые связанные объекты приходят как `[]`, а не `null`.

## Упавшие шаги
Нет, все шаги ok. Первый прогон скрипта упал только на финальном `db.pool.end()` (в `db.js` нет `pool.end` в такой форме) — убрано. Ни одного POST/PUT/DELETE.
