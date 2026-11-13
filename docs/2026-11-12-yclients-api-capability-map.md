# Карта возможностей YClients API для LoyalPro (12.11.2026)

## 0. Источники и как читать отчёт

| Источник | Статус | Что взято |
|---|---|---|
| https://developers.yclients.com/ru/ | Это Redoc-страница, WebFetch видит только заголовок. Полная OpenAPI-спека (248 путей, 308 операций) лежит внутри HTML (`__redoc_state`) и разобрана локально. | ВСЕ пути, параметры, тела запросов, описания |
| https://yclientsru.docs.apiary.io/ | Старая документация. Недоступна: страница отдаёт только оболочку «YCLIENTS REST API · Apiary», API Apiary отвечает 403. | Не использовалась. Различий старой и новой версий **установить не удалось** |
| https://developers.yclients.com/ru/webhooks | **404**. Отдельной страницы вебхуков на developers.yclients.com нет. | — |
| https://developer.alteg.io/en/developers/openapi/webhooks (+ `/webhook_record`, `/webhook_goods_operation`, `/webhook_finances_operation`) | Документация Altegio (международное имя того же продукта). Нашлась поиском. | Вся информация о вебхуках ниже. Для YClients RU считаем применимой, но это вывод, а не явное утверждение документации. |

Общее для API (раздел info спеки `developers.yclients.com/ru/`):
- База `https://api.yclients.ru`. Лимит: **200 запросов/мин, 5/сек на один IP**.
- Заголовки: `Accept: application/vnd.yclients.v2+json`, `Authorization: Bearer <partner_token>, User <user_token>` (user-токен — через `POST /api/v1/auth`). Секция «Авторизация».
- Ответ v2 всегда `{success, data, meta}`. Даты ISO 8601, длительности в **секундах**.
- Нотация: `*` у поля = обязательное по схеме.
- Права пользователя (user-токен) ограничивают доступ: в `GET /api/v1/user/permissions/{company_id}` есть признаки вроде `records_goods_create_last_days_count`, `finances_*_last_days_count`, `storages_*` (значение -1 = без ограничения по давности). Т.е. запись финансов/склада ограничена правами и глубиной по дням.

### Вебхуки (общее, источник developer.alteg.io)
- Настройка: `GET/POST /hooks_settings/{location_id}` (в спеке YClients на developers.yclients.com этих путей **нет**; у нас вебхуки настраиваются в кабинете разработчика). Флаги по ресурсам 0/1, список `urls`.
- Доставка: POST JSON, через ~5 с после события, таймаут 10 с (соединение 5 с). Нужен ответ 2xx. `X-Hook-Id` (UUID) одинаков при повторах. Доставка at-least-once, порядок не гарантирован. Повторы (до 2: через 5 с, затем 30 с) — при ошибке соединения, 429, 5xx; НЕ повторяются таймаут после отправки и прочие 4xx. Журнала доставки/повтора у партнёра нет. Повтор несёт ТЕКУЩЕЕ состояние ресурса.
- Конверт: `company_id, resource, resource_id, status (create|update|delete), data`.
- Ресурсы: `company`/`salon`, `staff`, `service`, категория услуг, `client`, `record` (data как `GET /record/{company_id}/{record_id}`), карта лояльности (упрощённый payload), `schedule` (только `update`, `data` пустой), `good`, `goods_operations_sale|receipt|consumable|stolen|move`, `finances_operation`.
- Вебхука на сертификаты, абонементы, документы склада целиком, зарплату, отчёты в документации **не найдено**. Косвенно сертификаты/абонементы видны через `goods_operations_*` (`data.loyalty_certificate_id`, `data.loyalty_abonement_id`) и `finances_operation`.
- Маркетплейсные вебхуки (`POST /marketplace_webhook`, события `uninstall`, `freeze`) — про жизненный цикл приложения.

---

## 1. Журнал записи и работа с записями

### 1.1 Таблица «функция → эндпоинт»

| Функция интерфейса | Метод, путь | Читать / писать, нюансы |
|---|---|---|
| Список записей (журнал, фильтры) | `GET /api/v1/records/{company_id}` | Query: `page, count, staff_id, client_id, created_user_id, start_date, end_date` (дата сеанса), `c_start_date, c_end_date` (дата создания), `changed_after, changed_before`, `include_consumables`, `include_finance_transactions`, `with_deleted=1`. Только чтение. |
| Записи партнёра | `GET /api/v1/records/partner/` | чтение |
| Карточка записи | `GET /api/v1/record/{company_id}/{record_id}` (+ `include_consumables`, `include_finance_transactions`) | Поля: `id, staff_id, services[] (id,title,cost,cost_to_pay,manual_cost,cost_per_unit,discount,first_cost,amount), goods_transactions[], staff, client, date, datetime, create_date, comment, online, attendance, visit_attendance, confirmed, seance_length, length, sms_before, sms_now, sms_now_text, email_now, notified, master_request, api_id, from_url, visit_id, created_user_id, deleted, paid_full, prepaid, prepaid_confirmed, is_update_blocked, payment_status, last_change_date, technical_break_duration, custom_color, record_labels, activity_id, custom_fields, documents[], sms_remain_hours, email_remain_hours, bookform_id, record_from, is_mobile, short_link, review_link, consumables, finance_transactions` |
| Создать запись | `POST /api/v1/records/{company_id}` | Тело: `staff_id, services[{id, first_cost, discount, cost}], client{phone,name,surname,patronymic,email}, save_if_busy, datetime, seance_length, send_sms, comment, sms_remain_hours, email_remain_hours, attendance, api_id, custom_color, record_labels[], client_agreements{is_newsletter_allowed,is_personal_data_processing_allowed}, technical_break_duration (кратно 300, макс. 3600), custom_fields{code: value}`. Для группового события обязателен `activity_id`, а `staff_id/services/datetime/seance_length` становятся необязательными. `save_if_busy` — сохранять ли запись на занятое/нерабочее время или вернуть ошибку. Клиент ищется/создаётся по телефону (в нашем проекте известно: перезаписывает `name` карточки). |
| Изменить / перенести запись | `PUT /api/v1/record/{company_id}/{record_id}` | Тело как у создания; перенос = новые `datetime`/`staff_id`. Для группового события обязателен `activity_id`. (Наш опыт: нужен полный набор полей.) |
| Удалить запись | `DELETE /api/v1/record/{company_id}/{record_id}` | — |
| Статусы attendance | поле `attendance` в POST/PUT/GET | Из описаний: `2` подтвердил, `1` пришёл (услуги оказаны), `0` ожидание, `-1` не пришёл (фраза «-1 - клиент не пришёл, 0 - ...» в описании фильтра). Для визита: `PUT /api/v1/visits/{visit_id}/{record_id}` |
| Визит | `GET /api/v1/visits/{visit_id}`; `GET /api/v1/visit/details/{salon_id}/{record_id}/{visit_id}`; `PUT /api/v1/visits/{visit_id}/{record_id}`; `GET /api/v1/attendance/receipt_print/{visit_id}` (чек PDF) | PUT тело: `attendance*, comment*, new_transactions[{id,amount,account_id}], deleted_transaction_ids[], goods_transactions[...], services[{id,title,cost,cost_per_unit,discount,first_cost,record_id}], fast_payment (1 нал, 2 безнал, 129/130 с печатью чека)`. В `visit/details` — блок `kkm_transaction_details_container`, типы документов (1 продажа товара, 2 услуги, 3 приход, 4 списание, 5 движение, 6 инвентаризация, 7 визит, 8 списание расходников, 9 пополнение депозита). |
| Групповые события | `POST/GET/PUT/DELETE /api/v1/activity/{company_id}[/{activity_id}]`, `GET .../filters/`, `.../search_dates_range/`, `.../search_dates/`, `.../search/`, `GET .../services`, `.../duplication_strategy` (GET/POST/POST /{id}), `POST .../{activity_id}/duplicate/`; **v2**: `POST/GET/PUT/DELETE /api/v2/companies/{salonId}/activities[/{activityId}]`, `POST .../activities/{activityId}/records[/{recordId}]` | Создание: `date*, service_id*, staff_id*, capacity*, force*` (игнорировать занятость), `resource_instance_ids, length, color, label_ids, comment, stream_link, technical_break_duration, instructions`. Запись клиента: `POST /api/v1/activity/{company_id}/{activity_id}/book` (`phone*, fullname*`, appointments[{activityId, clients_count, ...}]) или `POST /api/v1/records/...` с `activity_id`. |
| Расписание сотрудников (график) | `GET /api/v1/company/{company_id}/staff/schedule` (`start_date,end_date,staff_ids,include[]=busy_intervals/off_day_types`); `PUT` того же пути | PUT: `schedules_to_set[{staff_id, dates[], slots[{from,to}]}]`, `schedules_to_delete[{staff_id,dates[]}]`; ответ — результирующие графики. Статусы 401/403/404/422. Устаревшие: `GET /api/v1/schedule/{company_id}/{staff_id}/{start_date}/{end_date}`, `PUT /api/v1/schedule/{company_id}/{staff_id}`. |
| Расписания повторяющихся событий/клиентские графики | `/api/v1/company/{company_id}/schedules` (POST), `/schedules/search/{entity_type}/{entity_id}`, `/schedules/{id}` (PATCH/DELETE), `.../days` (POST/PATCH/DELETE), `.../days/{day_id}/events`, `.../client_schedules` (POST/PATCH/DELETE) | серии записей |
| Сетка журнала | `GET /api/v1/timetable/seances/{company_id}/{staff_id}/{date}` (поля `time`, `free`); `GET /api/v1/timetable/dates/{company_id}/{date}` (+`staff_id`) | чтение; даты YYYY-MM-DD |
| Свободное время онлайн-записи | `GET /api/v1/book_times/{company_id}/{staff_id}/{date}` (`service_ids[]`) → `time, seance_length, datetime`; `GET /api/v1/book_dates/{company_id}` (`service_ids[], staff_id, date, date_from, date_to` → `working_days, working_dates, booking_days, booking_dates`); `GET /api/v1/book_staff/{company_id}` (`service_ids[], datetime`); `GET /api/v1/book_staff_seances/{company_id}/{staff_id}/`; `GET /api/v1/book_services/{company_id}` (`staff_id, datetime, service_ids[]`) | чтение |
| Онлайн-запись (создание) | `POST /api/v1/book_check/{company_id}` (проверка; успех — пустой ответ **201**, занято — **422**, код ошибки **433**); `POST /api/v1/book_record/{company_id}`; `PUT /api/v1/book_record/{company_id}/{record_id}` (перенос); `GET /api/v1/book_record/{company_id}/{record_id}/{record_hash}`; `POST /api/v1/book_code/{company_id}` (SMS-код подтверждения телефона); `GET /api/v1/bookform/{id}`, `/api/v1/i18n/{langCode}` | `book_record`: `phone*, fullname*, email*, appointments*[{id*, services[], staff_id, datetime, custom_fields}], code (если у компании включено подтверждение телефона), notify_by_sms, notify_by_email, comment, api_id, is_newsletter_allowed, is_personal_data_processing_allowed, custom_fields`. `email` помечен обязательным. staff_id=0 — «любой мастер». |
| Записи пользователя онлайн-записи | `GET/DELETE /api/v1/user/records/{record_id}/{record_hash}`; `/api/v1/booking/auth`, `/api/v1/user/auth`, `/api/v1/booking/user[/data|/password|/phone_confirmation]` | клиентская часть |
| Ресурсы / оборудование | `GET /api/v1/resources/{company_id}` → `id, title, instances[{id,title,resource_id}]` | **Только чтение.** Привязка к записи — только через `resource_instance_ids` группового события. Для обычной записи привязки ресурса в схеме **не найдено**. |
| Комментарии к записи | поле `comment` записи | отдельного эндпоинта комментариев к записи нет. `GET/POST /api/v1/comments/{company_id}[/{staff_id}]` — это ОТЗЫВЫ (оценка 1–5), не комментарии записи. Комментарии к клиенту: `/api/v1/company/{company_id}/clients/{client_id}/comments` (GET/POST/DELETE). |
| SMS/email при записи | поля `send_sms`, `sms_remain_hours`, `email_remain_hours` (создание/изменение); `sms_before, sms_now, sms_now_text, email_now, notified` (чтение) | Шаблоны SMS и настройки уведомлений через API не редактируются. Рассылки: `POST /api/v1/sms/clients/by_id/{company_id}`, `.../by_filter/...`, email аналогично; `POST /api/v1/` (отправка СМС через операторов), `POST /api/v1/delivery/status`. |
| Метки/цвет | `record_labels[]`, `custom_color`; `GET/POST/PUT/DELETE /api/v1/labels/{company_id}[...]` | запись и чтение |
| Лист ожидания | `GET/POST /api/v2/companies/{company_id}/waiting_list`, `PUT/DELETE .../{waiting_list_entry_id}` | статусы `active|expired|finished` |
| Настройки журнала/онлайн-записи | `GET/PATCH /api/v1/company/{company_id}/settings/timetable`, `.../settings/online`, `GET .../settings/timeslots`, `/booking_forms/` (CRUD) | |
| Отзывы/чаевые | `GET/POST /api/v1/master_record_review/{recordToken}`, `/api/v1/tips/{company_id}/settings...` | |

### 1.2 Вебхуки
`record` (create/update/delete; data = карточка записи, как GET; для клиента дополнительно `national_id` только в вебхуке), `client`, `schedule` (только update, пустой data), `staff`, `service`.

### 1.3 Только чтение / не доступно
- Только чтение: ресурсы (`/resources`), сетка журнала (`timetable/*`), свободные окна (`book_*`), `visit/details`, чек PDF, `records/partner`.
- В документации не найдено: привязка оборудования/ресурса к обычной записи; запрет/блокировка времени («занято» отдельной сущностью без клиента); журнал истории изменений записи; изменение шаблонов SMS; создание/изменение типов нерабочих дней (читается как `off_day_type`).
- Ошибки: описаны точечно (433 «время занято» у `book_check`); общего каталога кодов ошибок в спеке нет.

---

## 2. Финансы

| Функция | Эндпоинт | Нюансы |
|---|---|---|
| Кассы/счета | `GET /api/v1/accounts/{company_id}` (`id,title,type (1 безнал, 0 нал),comment`) | **Только чтение**. Создание касс — не найдено |
| Финансовые операции (журнал) | `GET /api/v1/transactions/{company_id}` (query: `page,count,account_id,supplier_id,client_id,user_id,master_id,type,real_money,deleted,start_date,end_date,balance_is,document_id`); `GET /api/v1/timetable/transactions/{company_id}` (`record_id` или `visit_id`) | чтение |
| CRUD финоперации | `POST /api/v1/finance_transactions/{company_id}`; `GET/PUT/DELETE .../{transaction_id}` | тело: `expense_id` (статья), `amount, account_id, client_id, supplier_id, master_id, comment, date` (обязательных полей в схеме не помечено). Права: по `finances_*_last_days_count` пользователя |
| Статьи доходов/расходов | поле `expense_id` в операциях; в ответах `expense{id,title}` | **Отдельного эндпоинта списка/создания статей в документации не найдено** (справочник придётся собирать из операций/вебхуков) |
| Контрагенты (поставщики) | поле `supplier_id` | **эндпоинта поставщиков не найдено** |
| Оплата визита/продажи (sale) | `GET /api/v1/company/{company_id}/sale/{document_id}`; `POST .../sale/{document_id}/payment`; `DELETE .../payment/payment_transaction/{id}`; `DELETE .../payment/loyalty_transaction/{id}` | Тело POST — один из вариантов `payment.method.slug`: `account` (+`account_id`, `amount`), `deposit` (+`deposit_id`), `loyalty_certificate` (+`loyalty_certificate_id`, `amount`, `number`), `loyalty_abonement` (+`loyalty_abonement_id`, `number`; только для визита), `loyalty_card` (+`loyalty_card_id`, `amount`), `loyalty_program` (+`loyalty_program_id`, `loyalty_card_id`), `referral_loyalty_program` (+`referrer_phone`; только для визита). Если у пользователя нет права «Оплата сертификатом и абонементом без кода» — обязателен `number` (код). Ответ — «Операция продажи» (`state.items[]`, `loyalty_transactions[]`, `payment_transactions[]`). |
| Оплата через визит (старый путь) | `PUT /api/v1/visits/{visit_id}/{record_id}` (`new_transactions`, `deleted_transaction_ids`, `fast_payment`) | см. п. 1 |
| Бонусы в оплате | `POST /api/v1/visit/loyalty/apply_card_withdrawal/{company_id}/{card_id}` (`record_id*, visit_id*, amount*`; «не превысит остаток на оплату», 0 — транзакции не будет), `.../cancel_card_withdrawal/...`; `apply_discount_program` / `cancel_discount_program` `/{company_id}/{card_id}/{program_id}`; `apply_referral_program/{company_id}/{group_id}`; `GET /api/v1/visit/loyalty/transactions/{visit_id}` | |
| Бонусные карты | `GET /api/v1/loyalty/card_types/salon/{company_id}`, `.../client/{company_id}/{phone}`; `GET /api/v1/loyalty/cards/{phone}/{group_id}/{company_id}`; `GET /api/v1/loyalty/client_cards/{client_id}`; `POST /api/v1/loyalty/cards/{company_id}` (`loyalty_card_number, loyalty_card_type_id, phone`); `DELETE .../{card_id}`; `POST /api/v1/company/{company_id}/loyalty/cards/{card_id}/manual_transaction` и chain-версия (`amount*` со знаком, `title`) | ручное начисление/списание — основа наших кэшбэков |
| Программы лояльности/скидки | `GET /api/v1/company/{company_id}/loyalty/programs/search`; chain: `POST/GET/PUT/DELETE /api/v1/chain/{chain_id}/loyalty/programs[/{id}]`; `GET /api/v1/chain/{chain_id}/loyalty/transactions` | скидки услуги — также `services[].discount` записи |
| Личные счета (депозиты) | `POST /api/v1/deposits_operations/{salon_id}` (`client_id*, deposit_id*, amount*, account_id*, master_id`); `GET /api/v1/deposits/company/{company_id}/client/{client_id}`; `.../deposits/chain/{chain_id}[...]`, `.../deposit_history/{deposit_id}` | пополнение создаёт документ + транзакцию + финоперацию |
| Зарплата | `GET /api/v1/company/{company_id}/salary/period/staff/{staff_id}/` (+`/daily/`); `.../salary/calculation/staff/{staff_id}/` (+`/daily/`, `salary_schemes_count/`); `.../salary/payroll/staff/{staff_id}/calculation/[{calculation_id}]`; «собственные» варианты `.../salary/staff/{staff_id}/calculation|salary_schemes|period` | **Только чтение**, для владельца. Схемы расчёта задавать через API — не найдено |
| ККМ / фискализация | `GET /api/v1/kkm_transactions/{company_id}` (`page, editable_length, type, status, start_date, end_date`); `POST .../print_document_bill`; интеграции кассы `POST .../integration/kkm/callback/`, `GET .../integration/kkm/references/tax_system/{countryId}` | типы ККМ: 0 продажа, 1 возврат, 2/12 коррекция, 4/5 смена, 6/7 внесение/изъятие |
| Отчёты | `GET /api/v1/reports/z_report/{company_id}` (`start_date`, `master_id`); аналитика: `GET /api/v1/company/{company_id}/analytics/overall/` (`date_from*, date_to*, staff_id, position_id, user_id`), `.../overall/charts/income_daily|records_daily|fullness_daily|record_source|record_status`, `.../analytics/loyalty_programs/visits|income|staff` | чтение |

Вебхуки: `finances_operation` (create/update/delete; `data`: `id, document_id, record_id, visit_id, sold_item_id, sold_item_type, date, last_change_date, amount, comment, expense{id,title}, master, supplier, account, client, record`, опционально `payment_system_transaction_ids`), `goods_operations_sale`.

Только чтение: кассы, зарплата, Z-отчёт, аналитика, ККМ-список. Не найдено: создание/редактирование касс и статей, схем оплаты труда, отчёта «движение денег» как готовой выгрузки (собирается из `transactions`), возвратов как отдельной сущности.

---

## 3. Складской учёт

| Функция | Эндпоинт | Нюансы |
|---|---|---|
| Склады | `GET /api/v1/storages/{company_id}` (`id,title,for_services,for_sale,comment`) | только чтение, CRUD складов не найден |
| Товары | `POST /api/v1/goods/{company_id}`; `GET /api/v1/goods/{company_id}/{good_id}` (query `term,page,count,category_id,changed_after,changed_before`; page/count/category игнорируются при `good_id`); `PUT`, `DELETE` по `{good_id}`; поиск `GET /api/v1/goods/search/{company_id}?term&count`; состав категории `GET /api/v1/goods/category_node/{company_id}/{category_id}` | Создание: `title*, category_id*, sale_unit_id*, service_unit_id*`, также `print_title, article, barcode, cost` (цена продажи), `actual_cost` (себестоимость), `unit_equals`, `critical_amount, desired_amount, netto, brutto, comment, tax_variant, vat_id`. При смене единиц у товара с операциями в PUT нужен `correction_rules[{type, base_unit}]`. Чтение: `actual_amounts[{storage_id, amount}]` (остатки по складам), `unit_actual_cost`, `loyalty_abonement_type_id`, `loyalty_certificate_type_id`, `is_goods_mark_enabled`, `last_change_date`. Количества приходят строками (наш опыт). |
| Категории товаров | `GET /api/v1/goods_categories/{company_id}/{parent_category_id}` (0 — верхний уровень), `.../multiple/{company_id}`, `GET /api/v1/company/{company_id}/goods_categories/{parent_category_id}`; `POST /api/v1/goods_categories/{company_id}` (`title*, parent_category_id, article, comment`); `PUT/DELETE .../{category_id}` | полный CRUD |
| Единицы измерения | только ID `sale_unit_id`/`service_unit_id` в товаре; в ответах `unit{id,title,short_title}` | **эндпоинта справочника единиц не найдено** |
| Документы склада | `POST /api/v1/storage_operations/documents/{company_id}` (`type_id*` 1 продажа/3 приход/4 списание, `storage_id*`, `create_date*`, `comment`); `GET/PUT/DELETE .../{document_id}`; `GET .../documents/goods_transactions/{document_id}`; `GET .../documents/finance_transactions/{document_id}` | в схеме создания документа допустимы типы 1, 3, 4 |
| Складская операция одним запросом | `POST /api/v1/storage_operations/operation/{company_id}` | `type_id*` (1,3,4,**5 перемещение**), `create_date*`, `storage_id*`, `master_id`, `comment`, `goods_transactions*[]` — документ + транзакции атомарно |
| Товарные транзакции | `GET /api/v1/storages/transactions/{company_id}` (`page,count,start_date,end_date,document_id,changed_after,changed_before`); `POST /api/v1/storage_operations/goods_transactions/{company_id}`; `GET/PUT/DELETE .../{transaction_id}` | Транзакция: `document_id*, good_id*, amount*, cost_per_unit*, discount*` (%), `cost*`, `operation_unit_type*` (1 ед. продажи / 2 ед. списания), `good_special_number` (код сертификата/абонемента), `master_id, client_id, supplier_id, comment`. Наш опыт: `changed_after` голой датой игнорируется — нужен формат с временем; удалённые в API не отдаются, только вебхуком. |
| Остатки | `actual_amounts` в карточке товара | отдельного отчёта «остатки на дату» **не найдено** |
| Инвентаризация | тип документа 6 упомянут в справочнике типов документов (`visit/details`, ККМ), но в схемах создания (`type_id`) его нет | **создание инвентаризации через API в документации не найдено** |
| Поставщики | `supplier_id` в транзакциях; `supplier{id,title}` в вебхуке | **CRUD/список поставщиков не найдено** |
| Себестоимость | `actual_cost`, `unit_actual_cost` у товара; `cost_per_unit` у транзакции прихода | расчёт средней/FIFO — на стороне YClients, параметры не документированы |
| Техкарты и расходники | `GET /api/v1/technological_cards/{company_id}/` (`search,page,count`); `GET .../default_for_staff_and_service/{company_id}/{staffId}/{serviceId}/`; `GET .../record_consumables/{company_id}/{record_id}/`; `PUT .../record_consumables/consumables/{company_id}/{record_id}/{service_id}/` (`consumables[{goods_transaction_id, record_id, service_id, storage_id, good_id, price, amount}]`); `DELETE .../record_consumables/technological_cards/{company_id}/{record_id}/{service_id}` (`delete_consumables`) | Создание/редактирование самой техкарты (состав норм) — **не найдено**, только чтение техкарт и правка расходников конкретной записи |
| Привязка услуга→сотрудник | `POST/PUT/DELETE /api/v1/company/{company_id}/services/{service_id}/staff[/{master_id}]` | косвенно влияет на техкарту «для связи сотрудник-услуга» |

Вебхуки: `goods_operations_sale|receipt|consumable|stolen|move` (status create/update/delete; `data`: `id, document_id, type_id (1 продажа, 2 списание), type, operation_unit_type, amount, create_date, cost_per_unit, cost, discount, comment, record_id, last_change_date, loyalty_abonement_id, loyalty_certificate_id`, вложенные `good, unit, storage, client, master, service, supplier`), `good`.

Только чтение: склады, техкарты, остатки, транзакции (поиск), единицы.
Не найдено: CRUD складов, поставщиков, единиц; инвентаризация; создание техкарт; отчёты по остаткам на дату.

---

## 4. Сертификаты

| Функция | Эндпоинт | Нюансы |
|---|---|---|
| Типы сертификатов (чтение) | `GET /api/v1/company/{company_id}/loyalty/certificate_types/search` (`title, page, page_size` ≤ 100); `.../certificate_types/fetch` (по списку id) | Поля типа: `id, title, balance` (номинал), `is_multi` (многократное списание), `company_group_id, item_type_id` (0 без ограничений, 1 услуги без товаров, 2 товары без услуг, 3 некоторые услуги без товаров, 4 некоторые услуги и любые товары), `expiration_type_id, expiration_date, expiration_timeout, expiration_timeout_unit_id, is_allow_empty_code` |
| Создание/изменение типа сертификата | — | **в документации не найдено** (для абонементов такие методы есть, для сертификатов нет) |
| Продажа | сертификат — это ТОВАР (`goods.loyalty_certificate_type_id`); продажа = товарная транзакция типа «продажа» (документ типа 1) с `good_special_number` = код; в записи/визите — `goods_transactions[].good_special_number`, `loyalty_certificate_id` | `POST /api/v1/storage_operations/operation/{company_id}` или `.../goods_transactions/...`; код: `GET /api/v1/loyalty/generate_code/{company_id}/{good_Id}`; `loyalty_allow_empty_code`/`is_allow_empty_code` — продажа без кода. Отдельного «sell certificate» эндпоинта нет. |
| Баланс, срок, статус | `GET /api/v1/loyalty/certificates/` (`company_id*`, `phone*`) → `id, number, balance, default_balance, type_id, status_id, created_date, expiration_date, type{...}, status{...}`; `GET /api/v1/user/loyalty/certificates/` (авторизованный клиент онлайн-записи) | Поиск **по номеру (коду)** отдельным методом — **не найдено**; только по телефону клиента. Нет и фильтра «все сертификаты филиала». |
| Списание при оплате | `POST /api/v1/company/{company_id}/sale/{document_id}/payment`, `method.slug = loyalty_certificate`, `loyalty_certificate_id`, `amount`, `number` (код, если нет права «без кода»); отмена — `DELETE .../payment/loyalty_transaction/{id}` | Типы транзакций лояльности в ответе sale: `type_id 8` «Списание с сертификата» |
| Ручная корректировка баланса сертификата | — | **не найдено** (manual_transaction есть только для карт) |

Вебхуки: отдельного нет; следы — `goods_operations_sale.data.loyalty_certificate_id`, `finances_operation`.
Только чтение: типы, остаток/срок/статус по телефону.
Не найдено: создание типов, изменение срока/остатка, блокировка, поиск по коду, отчёт по всем выданным.

---

## 5. Абонементы

| Функция | Эндпоинт | Нюансы |
|---|---|---|
| Типы (чтение) | `GET /api/v1/company/{company_id}/loyalty/abonement_types/search` (`title,page,page_size≤100`), `.../fetch` | поля: `id,title,allow_freeze,freeze_limit,is_allow_empty_code,is_united_balance,united_balance_services_count,period,period_unit_id` и др. |
| Типы (запись) | `POST /api/v1/chain/{chain_id}/loyalty/abonement_types`; `PUT`, `DELETE`, `POST` (восстановить), `PATCH` (архивация), `POST .../{id}/clone` | **на уровне сети** (chain), не филиала. Создание: `title*, salon_group_id*, cost*, is_united_balance*, united_balance_services_count*, service_categories*`, также `salon_ids[], period, period_unit_id (1 день/2 неделя/3 месяц/4 год), allow_freeze, freeze_limit, freeze_limit_unit_id, service_price_correction, expiration_type_id (1 при продаже, 2 при первом использовании, 3 с конкретной даты…), is_allow_empty_code (именной/общий), balance_edit_type_id, is_online_sale_enabled, online_sale_title/description, autoactivation_time*, is_archived, services[], availability[{week_days, intervals}]` |
| Продажа | как у сертификата — абонемент это товар (`loyalty_abonement_type_id`), продажа через товарную транзакцию с `good_special_number`; `loyalty_abonement_id` приходит в `goods_transactions` записи и в вебхуке `goods_operations_sale`; код — `generate_code` | Отдельного «sell abonement» нет |
| Активация | определяется типом (`expiration_type_id`, `autoactivation_time`/`autoactivation_time_unit_id`) | ручной активации методом **не найдено** |
| Заморозка | `POST /api/v1/chain/{chain_id}/loyalty/abonements/{abonementId}/freeze` (`freeze_till*`), `.../unfreeze` | возможна, только если тип `allow_freeze`; лимит `freeze_limit` |
| Остаток посещений / срок | `GET /api/v1/loyalty/abonements/` (`company_id*, phone*`) → `id, number, balance_string, is_frozen, freeze_period, period, period_unit_id, expiration_date, status{id,title,extended_title}, balance_container{links}, type{...}`; корректировка: `POST .../abonements/{abonementId}/set_balance` (`united_balance_services_count*`, `services_balance_count*[{service_id,balance}]`) и `.../set_period` (`period*, period_unit_id*`) | |
| Поиск | `GET /api/v1/chain/{chain_id}/loyalty/abonements` (`created_after, created_before, abonements_ids, page, count`); для групповых событий `GET /api/v1/company/{company_id}/client/{client_id}/loyalty/abonements/search_for_activity/` и `.../{abonement_id}/check_for_activity/` (→ `possible_visits`, `possible_datetime`); клиентские `GET /api/v1/user/loyalty/abonements/` | Поиск **по номеру** отдельно — не найдено; chain-список принимает id |
| Списание визитом | `POST .../sale/{document_id}/payment`, `method.slug = loyalty_abonement`, `loyalty_abonement_id`, `number` (код); «работает только для визита»; в записи `payment_status` (автооплата абонементом: 0 не оплачен, 1 оплачен, 2…) | |

Вебхуки: отдельного нет (см. выше `loyalty_abonement_id` в `goods_operations_*`).
Не найдено: ручное списание/возврат посещения (кроме `set_balance`), история использований абонемента как метод.

---

## 6. Расхождения источников
- Apiary (`yclientsru.docs.apiary.io`) недоступна с сервера, сравнить версии нельзя; сравнение «старое/новое» заменено сравнением developers.yclients.com и developer.alteg.io. В Altegio-документе вебхуков есть `hooks_settings`, пометки о переименовании ресурсов (`locations` → `company`, `salon`), которых нет в нашей спеке YClients.
- В спеке YClients есть пары «устаревшее/новое»: `GET /api/v1/clients/{company_id}` → `POST /api/v1/company/{company_id}/clients/search`; `GET /api/v1/company_users/...` → `/company/{id}/users`; `/api/v1/staff/...` → `/company/{id}/staff/...`; `/api/v1/services/...` → `/company/{id}/services/...`; `/api/v1/schedule/...` → `/company/{id}/staff/schedule`.
- Групповые события существуют в v1 и v2 одновременно.

## 7. Выводы

**Полноценная двусторонняя интеграция реально возможна**
- Журнал записи (область 1): полный CRUD записей, перенос, статусы, групповые события, график сотрудников (чтение и запись), онлайн-окна, вебхуки `record`/`schedule`/`client`. Ограничения: ресурсы только чтение, привязка оборудования к обычной записи отсутствует; шаблоны SMS не управляются.
- Склад в части товаров и документов (область 3, частично): CRUD товаров и категорий, документы приход/продажа/списание/перемещение, товарные транзакции с `changed_after`, вебхуки `good`/`goods_operations_*`. Но только в пределах прав пользователя и без справочников единиц/поставщиков.
- Оплата визита и финоперации (область 2, частично): sale/payment с методами касса/депозит/сертификат/абонемент/карта/программа, CRUD `finance_transactions`, ручные операции по картам, вебхук `finances_operation`.

**Только чтение / зеркало**
- Кассы, склады, ресурсы, техкарты (составы норм), зарплата (все методы `salary/*`), Z-отчёт, аналитика, ККМ, остатки (через `actual_amounts`), типы сертификатов, сертификаты и абонементы клиента (баланс, срок, статус) — для сертификатов вообще нет методов записи состояния, кроме оплаты и продажи товаром.
- Для зеркалирования опора на вебхуки (`record`, `finances_operation`, `goods_operations_*`, `good`, `client`) плюс ночная сверка по `changed_after` (вебхуки at-least-once, без порядка, без журнала доставки).

**Придётся вести только в LoyalPro (без синхронизации в YClients)**
- Инвентаризация (создания в API нет), поставщики, справочник статей доходов/расходов, единицы измерения, создание/редактирование техкарт, схемы оплаты труда и расчёт зарплаты (YClients отдаёт только свои расчёты), создание типов сертификатов, ручная правка остатка/срока сертификата, привязка оборудования к обычной записи, шаблоны SMS.
- Абонементы: типы, продажа (через товар), заморозка, корректировка баланса/срока и оплата визитом — API есть, но все операции управления идут на уровне сети (`/chain/{chain_id}/...`), поэтому нужна проверка прав интеграционного пользователя; без неё абонементы тоже придётся вести локально.

**Открытые вопросы для проверки на живых данных**: набор `slug` у оплаты (в схеме перечислены `account, loyalty_card, loyalty_program, loyalty_abonement, loyalty_certificate, referral_loyalty_program, deposit`, обязательность `amount` в `loyalty_abonement`), фактический набор прав user-токена для `chain/*` и `finance_transactions`, поведение продажи сертификата/абонемента через `goods_transactions` (в документации описана только схема полей), порядок статусов `attendance` (`0`, `-1`) — подтверждён лишь косвенно.
