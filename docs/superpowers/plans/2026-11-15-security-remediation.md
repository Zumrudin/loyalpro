# LoyalPro — план устранения уязвимостей

> **Для новой сессии:** выполнять задачи по зависимостям, а не все подряд. Можно делегировать независимые пакеты, но координатор обязан проверить результат, запустить проверки и не передавать production-действия подагентам.
>
> **Статус:** выполняется; кодовые hotfix SEC-01…SEC-04, SEC-06…SEC-09, SEC-11/12 и основная часть SEC-10 реализованы с mocked/focused тестами и установлены на dev. SEC-05 additive DDL применён в `loyalpro_test` после чистого агрегатного аудита; FK остаются `NOT VALID`, production-схема не менялась. SEC-13 переведён в Report-Only, но inline scripts/handlers ещё не перенесены и enforce-CSP не ужесточён. Активный dev release: `/srv/loyalpro-dev/releases/security-20261115-201235`; откат приложения — `inline-goods-20261115-1852` с сохранением additive DDL. Production-операции, browser MCP и живые внешние вызовы не выполнялись.
>
> **Исходный аудит:** статический анализ кода и безопасные HTTP GET-проверки без реальной эксплуатации, OTP, webhook, регистрации, сообщений или изменения production-данных.

## 1. Цель и обязательные ограничения

Закрыть следующие подтверждённые кодом проблемы:

1. **Critical:** получение мобильной сессии пациента по чужому номеру через `/start <phone>` Telegram-бота.
2. **High:** межсалонный IDOR в фото-кейсах.
3. **High:** stored XSS в истории бонусных операций.
4. **High:** возврат интеграционных секретов через `GET /api/salon`.
5. **High:** сохранение доступа и прежней роли после деактивации, смены роли или пароля.
6. **High при незаданном секрете:** fail-open приём YClients/Chatpush webhook.
7. **Medium:** неоднозначный выбор клиента по телефону без салона, гонки OTP и открытое хранение OTP.
8. **Medium:** JWT в query-параметре всех `/api`.
9. **Medium:** открытая регистрация и отсутствие tenant-квот на общие AI-ресурсы.
10. **Medium/конфигурационно:** обход IP-лимитов через доверие к `X-Forwarded-For` и возможный прямой доступ к backend-порту.
11. **Integrity:** мобильный перенос записи меняет только локальную БД, не YClients.

Нерушимые правила исполнения:

- Прочитать `AGENTS.md`, `CLAUDE.md` и этот план перед началом. Сохранить чужие изменения в рабочем дереве; ничего не откатывать и не форматировать вне scope.
- Не читать и не выводить `.env`, значения секретов, токены, OTP, телефоны, тексты сообщений и patient data.
- Не использовать production для проверки атаки. Нужны два тестовых салона, тестовые пользователи/клиенты и отдельный тестовый Telegram-бот/чат.
- Не отправлять реальные сообщения, не создавать/переносить реальные записи, не начислять бонусы, не менять production-схему/конфигурацию и не перезапускать сервисы без отдельного явного подтверждения конкретной операции.
- Не добавлять зависимости без необходимости. Сначала использовать существующие `express-rate-limit`, `crypto`, `bcryptjs`, Jest и service layer YClients.
- Все tenant-owned чтения и записи ограничивать серверно полученным `salon_id`; числовой `salon_id` от клиента не считать доказательством принадлежности.
- Внешние вызовы YClients, Telegram, Chatpush и AI — только через существующий service layer, с явной идемпотентностью и без побочных эффектов в unit-тестах.
- Не делать commit, push, deploy или restart автоматически: только если пользователь отдельно попросит конкретное действие.

## 2. Порядок исполнения и делегирование

### Волна 0 — координатор

- SEC-00: зафиксировать baseline и подготовить изолированные фикстуры.
- Назначить одного **владельца миграций**. Только он последовательно редактирует `backend/migrations.js`; остальные агенты передают ему спецификации и тесты, но не правят этот файл параллельно.

### Волна 1 — независимые hotfix-пакеты

- **Agent A, mobile auth:** SEC-01 и кодовая часть SEC-02. Не трогает staff auth и `migrations.js`.
- **Agent B, staff auth:** SEC-03. Владеет `backend/middleware/auth.js`, `backend/routes/index.js`, `backend/routes/auth.js`, `backend/routes/users.js` на этой волне.
- **Agent C, web hotfix:** SEC-06 и SEC-07. Не включает глобальную CSP-переработку.
- **Agent D, tenant API:** SEC-04. Не редактирует `migrations.js`; передаёт требования в SEC-05.

Координатор сначала принимает и проверяет SEC-01, затем остальные пакеты. Параллельная работа не отменяет приоритет критического OTP-фикса.

### Волна 2 — структурные исправления

- Владелец миграций: SEC-05 и согласованные additive-изменения SEC-02.
- Тот же исполнитель, что делал staff auth, либо последовательно после него: SEC-09.
- Отдельный исполнитель: SEC-08; production-настройку webhook не менять.
- После стабилизации auth: SEC-10 и SEC-11.
- SEC-12 выполнять отдельно после mobile auth, чтобы не смешивать захват аккаунта и integrity переноса записи.
- SEC-13 выполнять последним отдельным изменением после устранения stored XSS.

### Волна 3 — общая приёмка

- SEC-14: интеграционные тесты двух салонов, browser E2E, review побочных эффектов, обновление документации и отдельный runbook выката.
- Координатор не объявляет задачу выполненной, если её тесты не запускались или остались красными.

## 3. Задачи

## SEC-00 — Baseline и безопасный стенд

**Приоритет:** P0, блокирует остальные задачи.
**Исполнитель:** координатор.
**Файлы:** только чтение; новые тестовые файлы появятся в следующих задачах.

- [x] Выполнить `git status --short`, записать для себя исходные изменения, не удалять и не переносить их в security-изменения.
- [x] Проверить актуальные версии исходных файлов: рабочее дерево уже содержит чужие journal-изменения, их не использовать как основание для refactor.
- [x] Запустить только релевантный baseline: `cd backend && npm test`; при изменении большого набора модулей дополнительно получить baseline `npx jest --runInBand` либо явно зафиксировать несвязанные исходные падения.

**Baseline 2026-11-15:** `npm test -- --runInBand` — 43/43 passed. Полный `npx jest --runInBand` — 6599 passed, 3 failed, 9 skipped; 12 failed suites, 1 skipped, 280 passed. Исходно красные: `agent-tool-memory`, `edocs-board-routes`, `agent-booking`, `services/agent/equipment`, `primary-clients`, `services/cert-request`, `services/cert-consent`, `services/medical-cert-pdf`, `services/medical-cert-layout`, `services/agent/service-filter`, `services/knowledge-base`, `services/medical-cert-defaults`. Эти несвязанные падения не исправляются в security-плане.
- [ ] Подготовить тестовую БД с двумя салонами A/B, owner/admin/specialist каждого салона и двумя клиентами с одинаковым нормализованным телефоном в разных салонах. Все значения — синтетические.
- [ ] Проверить версию PostgreSQL и механизм запуска `runMigrations` на тестовой БД: транзакционность, поддерживаемые constraint-конструкции, ожидаемые locks. Не проверять это destructive-запросами на production.
- [ ] Подготовить моки Telegram/YClients/AI/S3. Ни один unit/API test не должен обращаться к реальным провайдерам.

**Приёмка:** есть воспроизводимый тестовый контур, baseline и список исходных падений; production не использовался.

## SEC-01 — Немедленно закрыть захват мобильной сессии через Telegram

**Приоритет:** P0.
**Исполнитель:** Agent A.
**Файлы:** `backend/otp-bot-listener.js`, `backend/services/telegram.js`, `backend/services/telegram-otp.js`, `backend/routes/mobile-auth.js`, focused tests.

Исходная цепочка: `routes/mobile-auth.js:38-96` → `services/telegram.js:3-5` → `otp-bot-listener.js:59-95` → `routes/mobile-auth.js:105-180`.

- [x] Убрать номер из Telegram deep-link: `getBotLink()` больше не принимает и не кодирует телефон. Сохранить форму JSON-ответа mobile login, чтобы не требовать синхронного обновления приложения.
- [x] Полностью удалить доверие к `/start <phone>`; не оставлять это как legacy/admin/fallback-путь.
- [x] На `/start` отправлять клавиатуру Telegram `request_contact`. Обрабатывать только личный чат и `message.contact`.
- [x] Принимать контакт только при `contact.user_id === message.from.id`. Нормализовать `contact.phone_number` на сервере и только после этого связывать phone/chat/telegram user.
- [x] Не отправлять в новый чат OTP, выпущенный до проверки контакта. При первой привязке или смене Telegram user инвалидировать pending OTP и создать новый через общий сервис выпуска кода.
- [x] Вынести общий `issueOtp` в service layer, чтобы route и listener использовали одинаковые TTL, хранение, rate-limit правила и отсутствие секретов в логах.
- [x] Убрать телефоны, chat id и коды из логов; оставить только технические correlation id без ПДн.
- [x] При невозможности подтвердить контакт не создавать/не менять link и не выдавать JWT. Временная деградация должна отключать mobile login fail-closed, а не возвращать старый `/start <phone>`.
- [x] Обновить устаревшие комментарии в listener/services, описывающие прежнюю привязку по номеру.

**Тесты:**

- `/start` с произвольным номером не создаёт link, не вызывает отправку OTP и не создаёт mobile session.
- Контакт другого `user_id`, пересланный контакт и групповой чат отклоняются.
- Валидный собственный контакт создаёт verified link; в новый чат уходит только новый код, старый недействителен.
- Повторный `/start` не перепривязывает чужой Telegram user и не обнуляет лимиты.
- В mocked API-ответах и логах нет OTP/телефона.

**Приёмка:** знание номера не является фактором аутентификации; без доказанного Telegram-контакта невозможно получить код или сессию.

**Откат:** не включать старую привязку. При критической ошибке временно отключить новый mobile login на тестовом/согласованном контуре, сохраняя fail-closed поведение.

## SEC-02 — Tenant context, атомарность и защищённое хранение OTP

**Приоритет:** P0/P1, продолжение SEC-01.
**Исполнитель:** Agent A + владелец миграций.
**Файлы:** `backend/routes/mobile-auth.js`, `backend/otp-bot-listener.js`, `backend/middleware/mobile-auth.js`, `backend/services/telegram-otp.js`, `backend/config.js`, `backend/migrations.js`, `.env.example`, tests.

Принятое решение для текущего single-clinic mobile app: салон определяется серверной конфигурацией приложения/бота, например обязательным `MOBILE_SALON_ID`. Не использовать первый салон или произвольный `LIMIT 1`. Если продукту требуется один backend для нескольких mobile apps, разрешать публичный clinic key/host только через серверный mapping; отдельная глобальная identity-модель не входит в этот hotfix.

- [x] Передавать серверно разрешённый salon context во все `findClientByPhone`, выпуск OTP, Telegram link и verify.
- [x] Нормализовать телефон единым общим helper с строгой длиной/форматом. Короткие строки и частичные совпадения не должны находить произвольного клиента.
- [ ] При нескольких клиентах с одинаковым телефоном внутри одного салона не выбирать случайного: вернуть безопасную ошибку неоднозначности и создать задачу на ручное разрешение данных. (Код и mocked test готовы; ручная задача на разбор реальных дублей не создавалась, production-данные не читались.)
- [x] Возвращать одинаковый публичный ответ login для существующего и отсутствующего клиента; не раскрывать `delivered`, наличие клиента или привязку Telegram до проверки владения номером.
- [x] Добавить additive-колонки verified Telegram link (`telegram_user_id`, `verified_at` и необходимый tenant context). Старые непроверенные link не считать доверенными; не удалять исторические данные автоматически.
- [x] Добавить `otp_hash` и служебные поля, необходимые для безопасного consume. Хранить только HMAC/хеш кода с отдельным серверным ключом; не записывать сам код в БД/логи. Старую plaintext-колонку в первом релизе не удалять, но новый код её не читает и не заполняет.
- [x] Реализовать атомарный consume в транзакции/`UPDATE … RETURNING`: ограничение attempts выполняется в БД, параллельные запросы не сбрасывают и не обходят счётчик, успешный код может быть использован только один раз.
- [x] Сохранить TTL 5 минут и максимум 5 неверных попыток на код. Добавить лимиты по IP и по server-derived salon+phone, не полагаясь только на IP.
- [x] При смене verified Telegram user отозвать pending OTP и mobile sessions соответствующей привязки; не оставлять 30-дневный доступ прежнему владельцу связки.
- [x] В `mobileAuth` проверять session вместе с актуальной строкой клиента и её салоном, сопоставлять session/client/token identity. Не доверять дополнительным tenant-полям только из JWT.
- [x] Обновить `.env.example` плейсхолдерами без значений и документацию конфигурации. Отсутствие обязательного secret/config должно отключать mobile auth fail-closed с техническим серверным логом без ПДн.

**Тесты:**

- Одинаковый телефон в салонах A/B всегда даёт клиента только серверно выбранного салона; другой салон не доступен.
- Дубликат внутри салона не приводит к `LIMIT 1` входу.
- 10–20 параллельных неверных проверок не обходят пять попыток; параллельные верные проверки создают не более одной сессии.
- OTP не присутствует plaintext в новых записях/логах; истёкший, использованный и заменённый коды отклоняются.
- Старый непроверенный Telegram link не даёт доставить код.
- Ответы для существующего/несуществующего клиента не позволяют перечислять клиентов.

**Миграционная совместимость:** новые колонки nullable/additive; старые записи не backfill-ить как verified. После истечения старого OTP TTL и подтверждения отсутствия старых процессов отдельно обсудить удаление plaintext-колонки; в этом плане не удалять.

## SEC-03 — Немедленный отзыв staff-доступа и актуализация роли

**Приоритет:** P1.
**Исполнитель:** Agent B.
**Файлы:** `backend/routes/index.js`, `backend/middleware/auth.js`, `backend/routes/users.js`, `backend/routes/auth.js`, auth tests.

Исходные места: `routes/index.js:31-59`, `middleware/auth.js:7-24`, `routes/users.js:70-132`, `routes/auth.js:94-113`.

- [x] Централизовать загрузку staff-сессии: JWT signature/expiry → активная запись `sessions` → `JOIN users` с `is_active=TRUE`, соответствием `sessions.user_id`, `users.id` и серверным salon.
- [x] Формировать `req.user.userId/salonId/role` из текущей строки пользователя, а не из устаревших JWT claims. При несоответствии user/salon отклонять запрос; перенос пользователя между салонами должен отзывать старые sessions.
- [x] Применять одну реализацию в глобальном `/api` guard и `middleware/auth`; не оставлять второй путь, который проверяет только JWT.
- [x] При `is_active=false`, изменении роли или сбросе пароля в `PATCH /api/users/:id` выполнять update и `DELETE FROM sessions WHERE user_id=$…` в одной транзакции. Salon scope и запрет self-demotion/self-deactivate сохранить.
- [x] В `DELETE /api/users/:id` также деактивировать пользователя и отзывать sessions атомарно.
- [x] При смене собственного пароля отзывать все остальные sessions. Текущую session можно сохранить по server-derived `req.token`; явно задокументировать выбранное поведение. При сбросе пароля владельцем отзывать все sessions пользователя, включая текущие.
- [x] Logout удалять именно текущий токен из `req.token`, без неявного `slice(7)` пустого header.
- [ ] Не добавлять кэш текущей роли с TTL: он снова создаст окно доступа. Индекс `sessions(user_id)` уже предусмотрен; проверить план запроса на тестовых данных.
- [x] Обновить комментарии, утверждающие, что live session сама по себе гарантирует актуальный доступ.

**Тесты:**

- Деактивированный пользователь немедленно получает 401 даже с неистёкшим JWT.
- Понижение owner→admin/specialist немедленно закрывает прежние role-protected routes; повышение применяется по текущей БД.
- Сброс/смена пароля отзывает требуемые sessions; несвязанный пользователь остаётся залогинен.
- Пользователь салона A не может использовать session/user/salon mismatch для доступа к B.
- Logout, expired session, удалённый пользователь и отключённый salon fail-closed.

**Приёмка:** максимальное окно отзыва — текущий HTTP-запрос, а не семь дней.

**Откат:** можно откатить оптимизацию/рефакторинг, но нельзя убирать проверку `is_active` и актуальной роли ради восстановления работы.

## SEC-04 — Закрыть cross-tenant IDOR в фото-кейсах на уровне API

**Приоритет:** P1.
**Исполнитель:** Agent D.
**Файлы:** `backend/routes/patient-portfolio.js`, `backend/services/patient-portfolio.js`, новый `backend/patient-portfolio-tenant-isolation.test.js`.

Исходные места: `routes/patient-portfolio.js:71-78, 102-170, 192-227`; одиночные FK — `migrations.js:559-623`.

- [x] Добавить единый helper загрузки client/course/record/user по `id + salon_id`. Не доверять `client_id`, `course_id`, `record_id` из body.
- [x] `POST /courses`: клиент обязан существовать в текущем салоне. Чужой/несуществующий ID — одинаковый 404 без раскрытия существования записи.
- [x] `POST /visits`: клиент — текущего салона; record — текущего салона и соответствует указанному клиенту, если в record задан client; course — текущего салона и того же клиента; specialist — текущего салона.
- [x] Отсутствующий `record_id` не заменять молча сегодняшней датой. Возвращать 404/422; дату брать только из валидированного record или явного серверного сценария без record.
- [x] Идемпотентность record: существующий визит возвращать только при совпадении salon/client/record; при конфликте — 409, не перезаписывать и не раскрывать другую связь.
- [x] `PUT /visits/:id`: новый `course_id` повторно проверять по salon и client визита. Аналогично проверять все вложенные связи перед изменением.
- [x] `/visits/recent`: добавить `cl.salon_id=v.salon_id`, `crs.salon_id=v.salon_id`, `u.salon_id=v.salon_id`; не возвращать имя/телефон через глобальный id.
- [x] `/clients/:clientId/courses` и `/clients/:clientId/cases`: сначала подтвердить принадлежность клиента текущему салону; вложенные joins/subqueries также ограничить salon.
- [x] `loadPhotosByVisit` принимать salon id и фильтровать `case_photos.salon_id`; comments/photos/specialist joins ограничить тем же salon. `loadVisit` не должен загружать исторически нарушенную связь как валидную.
- [x] Для update/delete после tenant-aware load сохранить salon в `WHERE` как defence in depth, несмотря на глобально уникальный numeric id.
- [x] `assertCanMutate` оставить авторизацией автора/роли, но не использовать его вместо tenant-проверки.
- [x] Не удалять и не перепривязывать исторические записи в этой задаче. Невалидные legacy-связи скрывать/блокировать до отдельного разбора.

**Тесты:**

- Все POST/PUT с client/course/record/specialist салона B от пользователя A отклоняются; состояние A и B не меняется.
- В recent/cases/courses/photos/comments нет имени, телефона, title или S3 URL салона B.
- Повторный record id возвращает только валидную идемпотентную операцию; конфликт client не возвращает существующую чужую связь.
- Прямой numeric id, query/body/substitution и альтернативные route не обходят проверки.
- Валидный сценарий своего салона продолжает работать, включая nullable `course_id` и `record_id`.

**Приёмка:** tenant isolation обеспечивается кодом даже до включения новых DB constraints.

## SEC-05 — Additive DB-защита tenant-связей фото-кейсов

**Приоритет:** P1, после SEC-04.
**Исполнитель:** только владелец миграций.
**Файлы:** `backend/migrations.js`, focused migration tests, отдельный migration runbook внутри PR/описания изменения.

- [x] Составить read-only инвентаризацию существующих constraints/indexes и количества несогласованных строк на тестовой копии. В отчётах использовать только агрегаты/технические id без ПДн. (Dev `loyalpro_test`: новых indexes/FK до миграции 0, все 7 аудитов до/после = 0.)
- [x] Проверить связи course→client, visit→client/course/record/specialist, photo/comment→visit. Не делать автоматический backfill salon и не переносить записи в «похожий» салон.
- [x] Добавить необходимые `UNIQUE(salon_id, id)` на родительские таблицы и `UNIQUE(salon_id, client_id, id)` для course, если выбран составной course-FK. Проверить размер таблиц и locks на staging; большие unique indexes создавать concurrently вне общей транзакции отдельной согласованной операцией. (На dev применены `uq_clients_salon_id_id`, `uq_case_visits_salon_id_id`; course-FK использует client composite reference.)
- [x] Для client-связей с `ON DELETE CASCADE` добавить составные FK `(salon_id, client_id)` там, где это совместимо с текущей моделью удаления.
- [x] Для `course_id`, `record_id` и других nullable связей **не использовать** составной FK с обычным `ON DELETE SET NULL`: он может обнулить и `salon_id`. Сначала проверить поддержку `ON DELETE SET NULL (column_name)` на фактической версии PostgreSQL. Если её нет или поведение не подтверждено тестом — применить validation trigger для INSERT/UPDATE либо оставить DB constraint на следующий отдельный этап, сохранив обязательные кодовые проверки. Не заменять это на `NO ACTION`, ломающий текущие удаления.
- [x] Проверить, что course принадлежит не только салону, но и тому же client, что и visit. Одиночный FK `(salon_id, course_id)` этого не гарантирует.
- [x] Добавить составные ограничения/триггеры для photos/comments, не меняя существующий lifecycle S3 и не удаляя объекты.
- [x] Для старых данных рассмотреть `NOT VALID` + отдельную `VALIDATE CONSTRAINT`: новые записи должны проверяться сразу, старые ошибки не должны быть скрыты. Не объявлять constraint валидным, пока агрегатный аудит не чист.
- [x] Не проглатывать ошибки security-миграции через `.catch(() => {})`: процесс должен явно сообщить, что защита не установлена. Проверить совместимость с текущим запуском миграций и не блокировать весь сервис без согласованного runbook.
- [x] Задокументировать точные locks, ожидаемую длительность, порядок deploy, verification queries и recovery. Production-запуск — отдельное подтверждение. (На dev: `lock_timeout=5s`, `statement_timeout=30s`; MOBILE_AUTH/API_ACCESS_TICKETS/RESOURCE_LIMITS/CASE_TENANT_INTEGRITY — 1/19/19/20 мс. Production-длительность не измерена.)

**Migration runbook (применён на dev `loyalpro_test`; production DDL не запускался):**

1. До deploy на тестовой копии получить версию PostgreSQL, список одноимённых indexes/constraints и размеры `clients`, `case_courses`, `case_visits`, `case_photos`, `case_comments`. Текущий DDL создаёт `uq_clients_salon_id_id` и `uq_case_visits_salon_id_id` обычным `CREATE UNIQUE INDEX`: чтение продолжается, запись блокируется на время построения. На небольших dev-таблицах четыре security DDL-блока заняли 1/19/19/20 мс с `lock_timeout=5s`; production-длительность и locks не измерены. На больших таблицах сначала отдельно создать эти же индексы `CONCURRENTLY`, вне startup-миграции и её транзакции.
2. Добавление каждого FK `NOT VALID` кратковременно требует `ShareRowExclusive` на связанных таблицах; новые/изменённые строки проверяются сразу, старые массово не сканируются этим шагом. `DROP/CREATE` только новых named triggers требует краткого `AccessExclusive`. Ошибка `CASE_TENANT_INTEGRITY_DDL` не глотается: текущий startup catch пишет ошибку и поднимает сервер без рабочей БД, поэтому выкат без staging и maintenance/recovery plan запрещён.
3. Выполнить агрегатный аудит (выводятся только counts):
   ```sql
   SELECT
     (SELECT count(*) FROM case_courses c LEFT JOIN clients cl ON cl.id=c.client_id AND cl.salon_id=c.salon_id WHERE cl.id IS NULL) AS bad_course_client,
     (SELECT count(*) FROM case_visits v LEFT JOIN clients cl ON cl.id=v.client_id AND cl.salon_id=v.salon_id WHERE cl.id IS NULL) AS bad_visit_client,
     (SELECT count(*) FROM case_visits v LEFT JOIN case_courses c ON c.id=v.course_id AND c.salon_id=v.salon_id AND c.client_id=v.client_id WHERE v.course_id IS NOT NULL AND c.id IS NULL) AS bad_visit_course,
     (SELECT count(*) FROM case_visits v LEFT JOIN records r ON r.id=v.record_id AND r.salon_id=v.salon_id AND (r.client_id IS NULL OR r.client_id=v.client_id) WHERE v.record_id IS NOT NULL AND r.id IS NULL) AS bad_visit_record,
     (SELECT count(*) FROM case_visits v LEFT JOIN users u ON u.id=v.specialist_user_id AND u.salon_id=v.salon_id WHERE v.specialist_user_id IS NOT NULL AND u.id IS NULL) AS bad_visit_specialist,
     (SELECT count(*) FROM case_photos p LEFT JOIN case_visits v ON v.id=p.case_visit_id AND v.salon_id=p.salon_id WHERE v.id IS NULL) AS bad_photo_visit,
     (SELECT count(*) FROM case_comments cm LEFT JOIN case_visits v ON v.id=cm.case_visit_id AND v.salon_id=cm.salon_id WHERE v.id IS NULL) AS bad_comment_visit;
   ```
4. На staging с синтетическими салонами A/B проверить INSERT и UPDATE всех связей, повторный `runMigrations`, удаление client/course/record/specialist и сохранение `salon_id` при `SET NULL`. Проверить cascade photos/comments и отсутствие S3 side effects. На dev выполнены read-only inventory/audit и транзакционное применение DDL; повторный `runMigrations` прошёл при запуске PM2. Синтетические INSERT/UPDATE/delete/cascade сценарии A/B не выполнялись.
5. Только если все counts равны нулю и locks измерены, отдельно согласовать `ALTER TABLE … VALIDATE CONSTRAINT fk_case_courses_salon_client`, затем аналогично остальные три FK. `VALIDATE CONSTRAINT` сканирует legacy-строки и использует `ShareUpdateExclusive`, не смешивать с backfill. При ненулевых counts оставить `NOT VALID`, не переносить записи автоматически.
6. Recovery: остановить новый rollout до применения DDL либо оставить additive constraints и кодовые SEC-04 guards. Не удалять constraints/triggers и не менять старые single-column `ON DELETE SET NULL` FK без отдельного согласования. Откат к небезопасному API недопустим.

**Тесты:**

- Чистая тестовая БД и копия с legacy-строками проходят миграцию повторно без дублей.
- Constraint/trigger отклоняет чужой client/course/record при INSERT и UPDATE даже в обход API.
- Удаление course/record сохраняет прежнее поведение и никогда не обнуляет `salon_id` визита.
- Удаление client/salon не создаёт осиротевшие фото/комментарии и не вызывает неожиданный cascade визитов.
- Повторный deploy со старым и новым приложением не допускает межсалонных записей.

**Откат/recovery:** приложение SEC-04 продолжает защищать API при откате constraint-миграции. Удаление новых constraints — отдельная согласованная операция; никакого автоматического удаления/переноса данных или S3 objects.

## SEC-06 — Stored XSS в карточке клиента

**Приоритет:** P1, маленький hotfix отдельно от CSP.
**Исполнитель:** Agent C.
**Файлы:** `frontend/js/pages/clients.js`, focused UI test; при необходимости `backend/clients-api.test.js`.

Источник и sink: `routes/clients.js:56-86` → `frontend/js/pages/clients.js:135-141,158-189`.

- [x] Немедленно заменить raw `${t.description || '—'}` на существующее `esc(...)` либо DOM `textContent`.
- [x] Проверить остальные динамические значения в этом же HTML: title, card number/id, имя, email, URL/атрибуты. Экранировать по контексту; числовые значения строго приводить/валидировать.
- [x] Не применять HTML-sanitizer как замену корректного output encoding и не добавлять библиотеку без необходимости.
- [x] Сохранить параметризованные SQL-запросы; XSS исправляется на выводе, без фильтрации/удаления законного текста в БД.
- [x] Проверить reachable источники описания, включая ручную операцию и YClients title; не предполагать, что внешняя CRM возвращает безопасный HTML.

**Тесты:**

- Безопасная синтетическая строка с HTML/event handler отображается как текст; DOM-узел и JS-обработчик не создаются, внешних запросов нет.
- Обычные описания, Unicode, пустое значение и отрицательные/дробные суммы отображаются корректно.
- Browser MCP: открытие карточки тестового клиента под owner/admin не выполняет injected code и не ломает историю операций.

**Приёмка:** source→sink цепочка закрыта; немедленный fix не зависит от глобального удаления `unsafe-inline`.

## SEC-07 — Убрать секреты из `GET /api/salon`

**Приоритет:** P1.
**Исполнитель:** Agent C.
**Файлы:** `backend/routes/salon.js`, frontend settings consumers, API tests, при необходимости `backend/config.js`.

- [x] Заменить `SELECT *` в `routes/salon.js:24-26` на явный список безопасных полей и сформировать DTO только с разрешёнными свойствами.
- [x] В denylist для проверки включить partner/user tokens, login/password, web cookie, webhook secret и любые будущие поля, содержащие secret/token/password/cookie/private. По умолчанию новые DB-колонки не попадают в API.
- [x] `POST /yclients-auth` возвращать только успех и `configured`/`companyId`, не `userToken`. Изменить frontend, если он использует возвращаемый token.
- [x] Уточнить роли: чтение общих настроек отделить от управления credentials. По умолчанию запись YClients credentials/webhook secret оставить owner; admin допускать только при наличии явного продуктового требования и теста роли.
- [x] Проверить остальные reachable `SELECT * FROM salons` и сериализацию `salon` в ответы/логи, не ограничиваясь одним endpoint. Не выводить payload webhook с возможными секретами/ПДн.
- [x] Ошибки наружу возвращать как безопасный код; детали внешнего auth/API оставлять в защищённом серверном логе без credentials.
- [ ] Провести access review перед ротацией. Ротация YClients credentials/cookie/webhook secret и координация с провайдером — отдельная подтверждённая операция, не автоматический шаг.
- [ ] Шифрование секретов в БД оценить отдельно с версией ключа и совместимостью. Не добавлять самодельное шифрование; сначала проверить существующий secret-box/service layer.

**Тесты:**

- Точный snapshot DTO; тест падает при появлении неразрешённого поля.
- В теле ответа, frontend state и логах нет тестовых маркеров секретов.
- Неполномочная роль получает 403, чужой салон — ничего не получает и не меняет.
- Обновление credentials остаётся работоспособным через mocked YClients без возврата токена.

## SEC-08 — Перевести webhook на fail-closed

**Приоритет:** P1; фактическая эксплуатируемость зависит от конфигурации.
**Исполнитель:** отдельный backend-агент; production-действия только координатору после подтверждения.
**Файлы:** `backend/routes/webhook.js`, `backend/routes/chatpush-webhook.js`, `backend/config.js`, webhook tests, deploy docs.

Исходные места: `routes/webhook.js:28-66`, `routes/chatpush-webhook.js:60-80`.

- [ ] Получить только булеву инвентаризацию: для каких активных салонов секрет настроен/не настроен. Не выводить значения и не использовать production payload.
- [ ] До включения enforcement настроить секрет и URL у провайдера для каждого активного салона через согласованную операцию. Не делать это автоматическим deploy-шагом.
- [x] Изменить код: отсутствующий секрет — ошибка конфигурации 503/401, отсутствующий/неверный key — 401; никакого `legacy ok` для YClients/Chatpush. Gateway сохраняет fail-closed.
- [x] Никакие DB writes, AI, уведомления, финансовые и booking-обработчики не вызываются до успешной проверки секрета. Немедленный ACK сохранить только после auth.
- [x] Добавить rate limit по нормализованному IP + salon/company, не допуская обхода через spoofed company/IP.
- [ ] Проверить timing-safe сравнение и единый формат секрета. Если провайдер поддерживает только secret в URL, исключить query из access/application logs; не утверждать наличие HMAC, если YClients его не предоставляет. (Сравнение и application logging исправлены; nginx access log требует проверки владельцем.)
- [x] Проверить существующую дедупликацию повторной доставки и не менять финансовую логику в этой задаче.
- [ ] Добавить startup/config validation и наблюдаемый счётчик отказов без payload/ПДн. Не оставлять env-флаг, silently включающий небезопасный legacy в production.
- [x] Обновить комментарии `migrations.js`, `webhook.js`, `chatpush-webhook.js`, где NULL secret сейчас описан как принятый legacy mode.

**Тесты:**

- Missing secret, missing key, неверный key, пустой key и wrong salon не вызывают ни одного side effect.
- Валидный key проходит и ACK остаётся быстрым; mocks подтверждают однократную обработку retry.
- Rate limit не зависит от поддельного XFF; gateway behaviour не регрессирует.
- Тестовый отчёт подтверждает отсутствие секретов/ПДн в логах.

**Откат:** при ошибке интеграции восстанавливать корректный secret/URL и временно останавливать обработку по согласованному runbook; не возвращать приём неподписанных запросов.

## SEC-09 — Убрать JWT из URL, сохранить SSE и downloads

**Приоритет:** P2, после SEC-03.
**Исполнитель:** тот же auth-агент либо последовательный исполнитель.
**Файлы:** `backend/routes/index.js`, `backend/middleware/auth.js`, `backend/routes/chat.js`, download routes, `frontend/js/pages/chat.js` и download callers, `backend/migrations.js` владельцем миграций, tests.

- [x] Найти все использования `authOrQuery` и frontend `?token=`; составить исчерпывающий список до изменения middleware.
- [x] Убрать query JWT из глобального guard в первую очередь; обычные `/api` принимают только `Authorization: Bearer`.
- [x] Downloads перевести на `fetch` с Bearer → Blob/object URL; не открывать прямой URL с JWT.
- [x] Для EventSource добавить `POST /api/chat/stream-ticket` под текущим staff auth/ролью. Выдавать криптографически случайный одноразовый ticket на 60 секунд, scope=`chat:stream`, server-derived user/salon.
- [x] Хранить только hash ticket. Для корректной работы нескольких процессов использовать небольшую additive-таблицу `api_access_tickets` (`token_hash`, `user_id`, `salon_id`, `scope`, `expires_at`, `used_at`), а не process-local memory.
- [x] Атомарно потреблять ticket через `UPDATE … WHERE used_at IS NULL AND expires_at>NOW() RETURNING …`; повторно проверять активного пользователя/роль/salon. Открытое SSE-соединение не пересоздаётся из-за истечения ticket после handshake.
- [ ] Обновить frontend SSE на получение ticket перед `new EventSource`. Добавить `Cache-Control: no-store`, `Referrer-Policy: no-referrer` там, где применимо, и исключить ticket из логов. (Frontend/backend готовы; nginx `$request` с ticket ещё должен быть заменён на `$uri` или access log отключён владельцем.)
- [x] После обновления callers убрать общий `authOrQuery`; не оставлять generic query-token middleware для будущих routes.
- [ ] Если нужен короткий переход для закэшированного frontend, разрешить JWT query только на явно перечисленных legacy SSE/download routes с полной session+user проверкой, ограничить срок и затем удалить. Глобальный query JWT не возвращать.

**Тесты:**

- `?token=` на обычных routes получает 401 даже с валидным staff JWT.
- Ticket нельзя использовать дважды, после TTL, для другого scope/salon/user или после деактивации пользователя.
- Два backend-процесса не принимают один ticket независимо.
- Browser MCP: chat stream открывается, reconnect работает, downloads скачивают правильный файл; URL не содержит JWT.

## SEC-10 — Лимиты регистрации и общих AI-ресурсов

**Приоритет:** P2.
**Исполнитель:** backend-агент после auth-изменений.
**Файлы:** `backend/routes/auth.js`, `backend/routes/knowledge-base.js`, `backend/services/kb-assistant.js`, `backend/config.js`, tests.

- [ ] Сохранить self-service регистрацию, если она нужна продукту, но добавить rate limit по нормализованному IP и email, CAPTCHA/invite или email verification согласно существующей продуктовой модели. Не создавать owner для произвольного салона через client-supplied id.
- [x] Ограничить частоту создания салонов и повторные попытки с одинаковым email без раскрытия существования аккаунта.
- [x] На `/api/kb/ask` добавить per-user/per-tenant rate limit, одновременный request cap и очередь/429. Вопрос max 500 сохранить.
- [ ] Добавить учёт фактических LLM calls и дневной/месячный tenant budget. При исчерпании не вызывать ни primary, ни paid fallback provider.
- [ ] Добавить серверный глобальный circuit breaker для общих платных ключей. Не разрешать fallback-цепочке умножать quota после исчерпания бюджета.
- [x] Ограничить размер `prompt.system`, `prompt.user` и embedding `text` на relay endpoints; сохранить обязательный `X-Relay-Secret`, добавить лимиты и не логировать prompt/ПДн.
- [x] При нескольких backend-процессах использовать общий атомарный store счётчиков (существующая БД), а не независимые memory-лимиты. Не добавлять Redis без существующей инфраструктуры.
- [x] Настройки сделать конфигурируемыми с консервативными default; не подбирать тарифные значения скрытно, зафиксировать их в handoff.

**Остаток SEC-10:** регистрация получила общие PostgreSQL IP/email counters, но CAPTCHA/invite/email verification не выбраны и не реализованы. `runLlm` атомарно резервирует salon day/month + global day budget до top-level вызова и держит per-salon concurrency lease; после исчерпания provider chain не запускается. Однако fallback внутри уже разрешённого вызова не списывает отдельные фактические LLM calls. Это ограничение модели учёта, а не завершённый per-attempt accounting. Двухпроцессные live concurrency tests не запускались.

**Тесты:**

- 429 на register/ask/relay при превышении лимита; LLM и регистрация не вызываются.
- Салон A не расходует quota салона B; один tenant не блокирует всех без глобального safety threshold.
- Два процесса делят бюджет, параллельные запросы не превышают concurrency/месячный лимит.
- Fallback не вызывается после budget exhaustion; ошибки не раскрывают ключи/провайдерские ответы.

## SEC-11 — IP-лимиты и доверенный proxy

**Приоритет:** P2, часть зависит от инфраструктуры.
**Исполнитель:** backend + координатор для сетевых проверок.
**Файлы:** `backend/server.js`, `backend/routes/public-cert-request.js`, rate-limit helpers, tests, deploy runbook.

- [x] Удалить ручной разбор первого raw XFF в `public-cert-request.js:19-21`; использовать нормализованный `req.ip` после правильной proxy-настройки.
- [x] Доверять только фактическому reverse proxy/loopback или известному proxy CIDR, а не произвольному подключению. `trust proxy 1` оставить только если топология гарантированно одна и backend недоступен напрямую.
- [ ] На nginx перезаписывать XFF, а не принимать клиентскую цепочку как истину. Запретить внешний доступ к backend-порту firewall/security group либо bind только на нужный internal/loopback interface; не перезапускать сервисы без подтверждения.
- [x] Проверить, что все rate limiters используют одинаковый IP helper и корректно обрабатывают IPv6; не строить собственный naive IP key.
- [x] Для критичных OTP/register/webhook лимитов использовать общий store при нескольких workers, иначе зафиксировать ограничение single-process и не представлять memory store как распределённую защиту. (OTP phone/register/AI counters — PostgreSQL; express-rate-limit для OTP IP, webhook и CSP report остаётся per-process и не является распределённым лимитом.)
- [x] CORS untrusted origin должен получать управляемый отказ, а не HTML 500; не превращать эту задачу в CORS bypass fix — доступ к API всё равно определяется auth.

**Тесты:**

- Поддельный XFF не меняет ключ лимита при прямом подключении; через доверенный nginx реальный клиентский IP определяется корректно.
- IPv4/IPv6, несколько proxies и отсутствие XFF не дают обхода/глобальной блокировки всех пользователей.
- Внешнее сетевое сканирование не требуется: проверка bind/firewall выполняется владельцем инфраструктуры и документируется без раскрытия секретов.

## SEC-12 — Исправить integrity мобильного переноса записи

**Приоритет:** P2, отдельно после mobile auth.
**Исполнитель:** mobile backend-агент.
**Файлы:** `backend/routes/mobile-client.js`, существующий YClients booking service, tests.

- [x] Не изменять локальную дату напрямую как подтверждение переноса. Найти существующий service-layer reschedule/available-slots сценарий и использовать его.
- [x] Проверить ownership booking по client и серверному salon, разрешённые статусы, будущее время, корректную time zone и доступность слота.
- [x] Сделать идемпотентный внешний вызов с correlation/idempotency key; повтор HTTP-запроса не создаёт второй перенос.
- [x] Обновлять локальную запись только после подтверждения YClients; предусмотреть webhook/reconcile ordering, чтобы старое событие не вернуло прежнюю дату.
- [x] Внешняя ошибка не меняет локальную БД и не возвращает ложный success. Детали YClients не утекают наружу.
- [x] Не выполнять реальный перенос: проверка только mocks и отдельный staging-сценарий после явного разрешения.

**Тесты:** success/failure/timeout/retry, чужой client/salon, прошедшее время, недоступный слот, уже отменённая запись, webhook гонка и московская дата.

## SEC-13 — Усилить CSP после устранения XSS

**Приоритет:** P2/P3, отдельный этап.
**Исполнитель:** frontend-агент + координатор.
**Файлы:** `backend/server.js`, `frontend/index.html`, JS с inline handlers, при необходимости встраиваемая `frontend/cert-request.html`.

- [ ] Составить инвентарь inline scripts, `onclick` и других handlers. Перевести их на внешние JS/`addEventListener` узкими изменениями без redesign.
- [x] Сначала включить строгий `script-src` в Report-Only, собрать только технические нарушения без page content/ПДн, ограничить объём reports.
- [ ] Убрать `'unsafe-inline'` из `script-src` после устранения нарушений. Сохранить необходимые S3/YClients image origins и `frame-ancestors` публичной формы.
- [x] Не ослаблять output encoding после включения CSP: CSP — второй рубеж, не исправление XSS.

**Фактический статус 15.11.2026:** статический inventory нашёл inline script и сотни inline handlers в `frontend/index.html`, плюс inline script в `frontend/cert-request.html`; JS pages создают ещё handlers динамически. Report-Only header содержит `script-src 'self' cdn.jsdelivr.net; report-uri /api/csp-report`. Public endpoint принимает не более 4 КБ и 60 reports/мин на процесс, отвечает без тела и логирует только allowlisted directive и inline/eval/other. Тело, page URL и script sample не сохраняются. Enforce-CSP не изменён; browser-сбор нарушений и перенос handlers не выполнялись.
- [ ] Если статический HTML требует nonce, предпочесть внешние scripts; не внедрять сложный templating только ради nonce.

**Тесты:** browser MCP для карточки клиента, chat, settings, downloads, SSE, cert-request iframe и основных staff routes; CSP violations не содержат ПДн; SEC-06 regression остаётся зелёным.

## SEC-14 — Сквозная приёмка и передача изменений

**Приоритет:** обязательный финальный gate.
**Исполнитель:** координатор + независимый reviewer по необходимости.

- [ ] Провести code review tenant isolation, authorization, race conditions, повторных внешних эффектов, secrets/logs и rollback.
- [x] Запустить focused Jest-сьюты всех изменённых модулей. Имена новых suites должны соответствовать задачам выше; не добавлять файлы результатов/отчётов в репозиторий.
- [x] Выполнить `cd backend && npm test`, затем `npx jest --runInBand` для полного regression либо явно перечислить невыполненные suites и причину. (Команды выполнены; полный набор сохраняет исходные красные проверки, перечисленные ниже.)
- [ ] Если изменялся `mobile/`, выполнить `cd mobile && npm run lint`. (`mobile/` не изменялся.)
- [ ] Для staff UI выполнить browser MCP-проверку, не bash-запуск Playwright: XSS, settings без секретов, SSE/downloads, CSP. Использовать только синтетические API/тестовый стенд.
- [ ] В изолированном E2E доказать: чужой Telegram phone не даёт session; tenant B не виден через photo cases; deactivated staff немедленно теряет доступ; unsigned webhook не имеет side effects; ticket одноразовый. (Есть mocked regression-тесты, изолированный двухсалонный E2E не выполнялся.)
- [x] Проверить `git diff --check`, `git status --short`, отсутствие логов, screenshots, reports, `.env` и других созданных артефактов в diff. Не удалять чужие файлы.
- [x] Обновить `CLAUDE.md`, если изменились auth/query-token/mobile/webhook правила, и устаревшие комментарии к коду. `AGENTS.md` менять только если изменилось документированное там поведение.
- [x] Подготовить handoff: изменённые файлы, запущенные команды и результаты, невыполненные проверки, миграции/locks/rollback, необходимые человеку production-операции.

**Фактическая регрессия 15.11.2026:**

- Focused security/API Jest: 35 suites, 398 tests passed; после адаптации старых role-suite mocks к обязательной session-проверке дополнительно 4 suites, 37 tests passed (`staff-auth-security` входит в оба прогона).
- `cd backend && npm test`: 43/43 passed. `node --test backend/services/knowledge-base.test.js`: 5/5 passed. Syntax-check всех изменённых JS и `git diff --check` прошли.
- Полный `cd backend && npx jest --runInBand`: 308 suites passed, 12 failed, 1 skipped; 6863 tests passed, 3 failed, 9 skipped. Сбои совпадают с исходным SEC-00 baseline: `edocs-board-routes`, `agent-booking`, `agent-tool-memory`; восемь `node:test` suites несовместимы с Jest, а `primary-clients` является отдельным DB-dependent script. Они не исправлялись как несвязанные с security diff; полный набор не считается зелёным.
- Dev deploy 15.11.2026: активен `/srv/loyalpro-dev/releases/security-20261115-201235`; на точном релизе 38 suites / 425 tests PASS. В `loyalpro_test` транзакционно применены MOBILE_AUTH_DDL, API_ACCESS_TICKETS_DDL, RESOURCE_LIMITS_DDL, CASE_TENANT_INTEGRITY_DDL (1/19/19/20 мс, lock/statement timeout 5/30 с). Все 7 аудитов до/после = 0; 2 indexes, 4 NOT VALID FK, 2 triggers, 5 security tables подтверждены. PM2 `loyalpro` online, HTTPS/static byte match и 401 без auth PASS, Report-Only CSP present, новых error markers в логах нет. Откат приложения — `inline-goods-20261115-1852` + `ecosystem.before-security.json`, additive DDL сохранить.
- Production deploy 16.11.2026: `/srv/loyalpro/current` → `/srv/loyalpro/releases/security-0f8affa`, архив создан строго из commit `0f8affadeab93e12602f9d550c094a974542b83d`; production БД подтверждена как `loyalpro`. Перед DDL создан custom-format backup `/srv/loyalpro-backups/pre-security-0f8affa/loyalpro.dump` (13 101 674 bytes), `pg_restore --list` успешно прочитал 1029 catalog entries; restore не запускался. Те же четыре DDL применены в одной транзакции с lock/statement timeout 5/30 с за 18/3/4/16 мс. Подтверждены 2 composite indexes, 4 NOT VALID FK, 2 triggers, 5 security tables; все 7 tenant-аудитов до/после = 0. Backfill/drop/VALIDATE не выполнялись.
- Production webhook inventory: один активный салон с YClients; секрет сгенерирован криптографически стойким генератором, записан в tenant-scoped строку и передан пользователю в отдельном файле mode 600 без вывода в чат; пользователь подтвердил обновление provider URL. Chatpush/gateway webhook secrets присутствуют. Значения секретов и live payload не выводились; валидная live delivery после выката не проверялась.
- Первый production switch откачен из-за `MODULE_NOT_FOUND: winston`: archive содержал неполный tracked `backend/node_modules`, поэтому ссылка на старый каталог оказалась вложенной и не использовалась для resolution. Старый релиз восстановлен и отвечал HTTP 200. В новом release выполнен штатный `npm ci --omit=dev --no-audit --no-fund` (548 packages), исходный неполный каталог сохранён как `backend/node_modules.from-git`; повторный switch успешен. Код и lockfile не менялись.
- Production smoke после повторного switch: PM2 `loyalpro` online; HTTPS `/` = 200; `/`, `/js/pages/chat.js`, `/js/pages/clients.js`, `/js/pages/segments.js` побайтно совпали с release; неавторизованные `GET /api/clients` и `POST /api/chat/stream-ticket` = 401; enforce и Report-Only CSP присутствуют, Report-Only без `unsafe-inline`; новых `ERROR|PostgreSQL error|WITHOUT DB|Error:` в PM2 logs после второго switch нет. Откат приложения — `main-e64de81-visits-resched-hcprice`, additive DDL сохранить.
- Не выполнялись browser MCP, синтетический двухсалонный staging E2E с INSERT/UPDATE/delete/cascade, `VALIDATE CONSTRAINT`, настройка nginx/proxy и запрет query secrets в access logs, реальные OTP/messages/booking/AI-вызовы и валидные live webhook deliveries. `MOBILE_SALON_ID` и `MOBILE_OTP_HASH_KEY` на production отсутствуют, поэтому новый mobile login fail-closed до явной настройки. Общий DoD и production gate остаются открытыми.

## 4. Общий порядок выката после зелёных тестов

Это **не разрешение на deploy**. Каждый production-шаг требует отдельного подтверждения.

1. Зафиксировать backup/recovery и текущие версии приложений; убедиться, что в release не попали journal-изменения других задач.
2. Выкатить кодовые отказоустойчивые проверки SEC-01/02/03/04/06/07 до или вместе с additive migrations согласно совместимости. Старый `/start <phone>` не включать ни на один переходный период.
3. Выполнить additive migrations на staging, измерить locks, затем согласованно на production. Не запускать destructive backfill/drop columns.
4. Проверить метрики ошибок без чтения patient content: отказы OTP, отзывы sessions, 401/403/409 tenant guards, DB constraint violations.
5. Для webhook сначала завершить настройку секретов/URL у всех активных интеграций, затем включить fail-closed код. Не принимать unsigned traffic ради восстановления доставки.
6. Выпустить SSE/download tickets совместимым с frontend порядком; после истечения browser cache удалить ограниченный legacy query JWT, если он временно сохранялся.
7. Включить AI/registration quotas с наблюдаемыми лимитами; подготовить runbook увеличения quota без отключения защиты.
8. Только после отдельного access review решить ротацию секретов и разбор legacy cross-tenant записей. Не выполнять их молча.

### Безопасный rollback

- Откатывать на предыдущую **исправленную** версию или отключать поражённую функцию fail-closed; не возвращать известный уязвимый код.
- Additive DB-изменения оставить, если обратная совместимость подтверждена. Любые drop constraint/column/data — отдельные согласованные операции.
- CSP можно временно вернуть в менее строгий enforce при критической поломке UI, сохранив output encoding; stored XSS не откатывать.
- Webhook legacy и Telegram `/start <phone>` не являются допустимыми rollback-вариантами.

## 5. Definition of Done всего плана

- Нет пути от произвольного `/start <phone>` к Telegram link, OTP или mobile session.
- OTP привязан к серверному salon context, не хранится plaintext, не обходится гонками и не позволяет перечислять клиентов.
- Staff user/role/salon/is_active проверяются по текущей БД; все требуемые события отзывают sessions.
- Два тестовых салона подтверждают запрет IDOR во всех photo-case reads/writes и на уровне БД для новых записей.
- Stored XSS отображается как текст; `GET /api/salon` содержит только whitelist; секреты не возвращаются и не логируются.
- Webhook без корректной конфигурации/секрета не создаёт никаких эффектов.
- Обычные REST не принимают JWT в URL; SSE/downloads работают через узкие безопасные механизмы.
- AI/registration/IP limits нельзя обходить сменой tenant или spoofed IP в поддерживаемой инфраструктуре.
- Мобильный перенос записи согласован с YClients и не сообщает ложный успех.
- Все релевантные тесты и browser checks запущены на итоговом diff; незапущенные проверки явно перечислены.
- Production-операции, если не подтверждались, оставлены человеку в handoff и не выдаются за выполненные.

## 6. Промпт для запуска в новой сессии

```text
Исполни docs/superpowers/plans/2026-11-15-security-remediation.md.
Сначала прочитай AGENTS.md, CLAUDE.md, сам план и проверь git status. Не трогай существующие journal-изменения.
Начни с SEC-00 и критического SEC-01. Независимые задачи делегируй по волнам из раздела 2, назначь одного владельца backend/migrations.js.
Работай только с кодом и изолированными тестами. Не используй production-данные, реальные сообщения/OTP/webhook/booking/AI-эффекты, deploy/restart/migrations на production без моего отдельного подтверждения конкретной операции.
После каждой задачи обновляй чекбоксы только по фактически выполненным шагам, запускай focused tests и сообщай результат. Не отмечай план завершённым при красных или незапущенных проверках.
```
