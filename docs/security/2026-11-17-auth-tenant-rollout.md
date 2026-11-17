# Выкладка исправлений A1–A5

Dev и production: исправления A1–A5 выложены. Production дополнительно включает проверенный private tunnel transport `ab874f4`.

## Выполнено на production — 17.11.2026

- 05:53:44.983599 UTC: `/srv/loyalpro/current` → `/srv/loyalpro/releases/auth-tenant-20261117`, source `ab874f4` из main. PM2 от loyalpro, фактический cwd проверен, Node22.22.1, backend loopback3001. Предыдущий release `security-completion-20261117` сохранён.
- Backup `/srv/loyalpro-backups/pre-auth-tenant-20261117`: dump loyalpro 13,374,997B, pg_restore --list 1303 entries; приватная env, nginx, ecosystem, PM2 dump и metadata. Секреты и shared data/logs/uploads сохранены; добавлен только GATEWAY_FILES_ORIGIN.
- Production PostgreSQL MCP: четыре агрегата home-care audit0 до/после; три составных FK установлены и VALIDATED одной транзакцией за31ms с lock/statement5/30s. Последующий read-only MCP подтвердил validated/deferrable=true для всех трёх. Рабочие строки не исправлялись и не удалялись.
- Точный чистый candidate до env: npm ci; 19 focused Jest suites /352 tests PASS; npm prune --omit=dev. Все2235 tracked backend/frontend files совпали по SHA256 с sourcecommit. Независимое ревью loopback transport одобрено; отдельный повтор20tests PASS.
- Защищённый source-service получил синтетический файл через фактический SSH tunnel production→dev. Файл и созданный пустой каталог удалены; production DB fixtures/пользователи не создавались. Эта проверка подтверждает транспорт, а проверка auth/tenant/role обеспечена candidate tests и предыдущими dev live checks, не заявляется как авторизованный production-user E2E.
- Nginx: публичный proxy gateway uploads заменён exact/^~404, `nginx -t` и reload успешны; private loopback3103 relay сохранён. HTTPS: index200, anonymous clients/attachment/SSE/mobile profile401; raw/encoded/dot-path и IPvhost404. Index/chat/journal-chat byte-match; strict CSP сохранён.
- Browser MCP на реальном production: login200, password input, attachment anonymous401, pageerrors0; ожидаемая network console запись401. Без реального входа/чтения пациентских данных.
- После переключения PM2 online, restart counter41 стабилен (накопительный счётчик, не число аварий этого release); новых ERROR/fatal/MaxListeners0. Один прежний dependency DeprecationWarning. Полный Jest, реальный OTP, real-user password reset, пациентские отправки/бонусы/записи и полный authenticated production UI E2E не запускались.
- Private helper artifacts: local `/tmp/loyalpro-auth-tenant-prod/`, remote `/tmp/auth-tenant-*`; runtime rollback к прежнему release сохраняет закрытый nginx gateway prefix и additive FK. Backup БД автоматически не восстанавливать. Dev остаётся на source0d3c6b8 с локальным source path; дополнительный production tunnel transport покрыт отдельными тестами.

## Выполнено на dev — 17.11.2026

- 05:37:51.353 UTC: release `/srv/loyalpro-dev/releases/auth-tenant-20261117`, source `0d3c6b8`; PM2 entry пересоздан с новым script/cwd и сохранён. Фактический `/proc/PID/cwd`, Node22.23.2, online/restarts0 и bind127.0.0.1:3001 проверены.
- Backup `/srv/loyalpro-dev/backups/pre-auth-tenant-20261117`: dump loyalpro_test 12,196,074 bytes, pg_restore --list 1313 entries; env, ecosystem, PM2 dump, два nginx vhost. Предыдущий release `/srv/loyalpro-dev/releases/security-completion-20261116` сохранён.
- PostgreSQL MCP: все четыре агрегата home-care audit = 0 до и после выкладки. Новые три FK применены и VALIDATED одной транзакцией с lock/statement 5/30s, 34ms. Данные не очищались/не перепривязывались.
- Nginx: `/etc/nginx/sites-available/dev-zumrudin.conf` и `loyalpro-main.conf` (резервный IP vhost) закрывают gateway raw URL; `nginx -t` и reload успешны. Production gateway-files relay на loopback3103 не изменён. Backend/Frontend используют прежние dev env/data/logs/uploads, секреты не ротировались.
- На чистом candidate до копирования env: npm ci, 18 focused Jest suites / 343 tests PASS, затем production dependency prune. Все 986 проверенных backend/frontend source files совпали с commit. HTTPS index и обе изменённые JS byte-match, CSP сохранён.
- HTTP: index200; anonymous clients/attachment/SSE/mobile profile401; raw, percent-encoded и dot-path gateway uploads404; IP-vhost raw404.
- 16 live checks через actual backend с двумя синтетическими салонами: свой POST/read, specialist same-tenant read, foreign read/POST/PUT denial и отсутствие изменения строки, must_change_password me200/protected403, revoked session401; свой файл200, чужой404, specialist403, raw/encoded404. Бот/FCM и внешние сообщения не использовались; у synthetic client нет FCM token.
- Browser MCP: фактические deployed chat/journal scripts и действующий synthetic staff token открыли настоящий синтетический dev attachment через Bearer→Blob; opener=null, без токена отказ, page errors0. HTML fixture для двух компонентов перехвачен в браузере; это не проверка всех экранов приложения.
- Cleanup: synthetic users/salons/messages удалены, агрегаты PostgreSQL MCP residue0; файл и созданные пустые каталоги удалены. Новые runtime ERROR/fatal/MaxListeners0. Полный Jest, живой OTP, реальные пациентские сообщения/записи и CLI сброс реального пользователя не запускались.
- Артефакты проверки (private0700): `/tmp/loyalpro-auth-tenant-dev/`; live fixture script и browser hook содержат только синтетические сценарии, временный файл с сессией удалён.

Production topology проверена: gateway files расположены на dev, private nginx alias `/var/lib/loyalpro-prod-gateway/public-files/` доступен production через reverse SSH tunnel `127.0.0.1:3103`. Для этого добавлен `GATEWAY_FILES_ORIGIN=http://127.0.0.1:3103`: только этот origin, без redirects, flat ASCII filename/account path, deadline60s; запрос после session/role/message/account/salon проверки. Внешние headers/ошибки upstream не передаются; safe MIME/no-store задаёт приложение. Без переменной остаётся локальный realpath-путь dev. Публичный nginx proxy `/uploads/gateway/` при rollout заменяется на404, private relay сохраняется. Синтетический файл через фактический tunnel получен и удалён; реальные вложения не читались.

## До переключения

1. Backup приложения, nginx, приватной конфигурации и БД; проверить читаемость дампа. Зафиксировать фактический release/cwd процесса и rollback target.
2. Выполнить `backend/scripts/home-care-tenant-audit.sql` через read-only PostgreSQL MCP. Вывод содержит только четыре счётчика. Нарушения не исправлять автоматически; новую защиту можно установить NOT VALID. До подтверждения нулевых счётчиков не объявлять старые связи исправленными.
3. Применить экспорт `HOME_CARE_TENANT_INTEGRITY_DDL` из `backend/migrations.js` одной транзакцией с `SET LOCAL lock_timeout='5s'` и `SET LOCAL statement_timeout='30s'`. При timeout откатить и подобрать окно; не повышать лимиты вслепую. Индексы на records/users могут блокировать запись на время построения. Если таблицы велики — отдельно подготовить concurrent indexes вне транзакции до установки FK.
4. Ограничения NOT VALID запрещают новые чужие связи. Существующие простые FK остаются и обеспечивают SET NULL; составные DEFERRABLE INITIALLY IMMEDIATE NO ACTION проверяют итог операции. Старые строки не удаляются и не перепривязываются. После разрешённой отдельной очистки и нулевого аудита валидировать fk_hcp_salon_client, fk_hcp_salon_record, fk_hcp_salon_specialist по одной с timeout.

## Приложение и nginx

Выпускать backend и новый JS чата вместе: history/SSE возвращают `/api/chat/attachments/<message-id>`, интерфейс получает файл Bearer-запросом. Сохранённые ссылки в БД и файлы не перемещаются; авторизованный маршрут проверяет владельца сообщения и аккаунта, а также файловый путь.

Во всех виртуальных хостах, которые могут выдавать этот frontend/uploads, до разрешения трафика на новый выпуск добавить:

```nginx
location = /uploads/gateway { return 404; }
location ^~ /uploads/gateway/ { return 404; }
```

Nginx сопоставляет нормализованный URI. Проверить также aliases, другие домены, прямой static root/CDN и доступ по IP. Если ранее файлы кэшировал CDN — закрыть origin и инвалидировать соответствующий префикс. Не разрешать fallback к старому публичному URL при 401/403/404. `/api/chat/attachments/` должен проксироваться в приложение, без shared cache. Эти правила сохранять при rollback.

Сначала проверить `nginx -t`, затем выполнить разрешённую выкладку/reload. На dev проверить существующее вложение только с согласованными тестовыми данными: свой салон/роль получает файл; без сессии, отозванная сессия, чужой салон и specialist — отказ; сырой путь и его percent-encoded варианты — 404. Проверить окно скачивания, основной чат и чат журнала, сообщения history и SSE. Не отправлять реальные сообщения ради smoke test.

## Пароли

У пользователей с must_change_password API возвращает 403 PASSWORD_CHANGE_REQUIRED, кроме me/change-password/logout. Проверить штатную смену и доступ после неё.

Recovery CLI больше не принимает email/пароль непосредственно в аргументах. Использовать приватные файлы 0600:

```sh
node backend/reset-password.js EMAIL_FILE PASSWORD_FILE --confirm-database=loyalpro_test
```

Запускать из корректного окружения приложения (при обычной .env загрузке — cwd backend и `node reset-password.js …`). Для production заменить подтверждение на `loyalpro`. Пароль не печатается; hash update и отзыв всех сессий выполняются атомарно. Никакой сброс пользователя не является частью smoke проверки без отдельного разрешения.

## Rollback и ограничения

Сохранить добавленные FK/индексы; старое приложение сможет писать корректные связи. Полный rollback к уязвимому приложению вернёт дефекты обязательной смены/CLI и часть home-care проверок — предпочтителен исправляющий выпуск. Если всё же откатывается UI/backend, публичный gateway-префикс оставлять закрытым: временная недоступность просмотра безопаснее повторного открытия приватных файлов. Backup данных не восстанавливать автоматически.

Отдельно остаются: аудит/исправление старых неверных связей при ненулевых счётчиках, CDN purge при наличии CDN, проверка внешних ссылок Chatpush (на стороне провайдера), live OTP и полный внешний pentest. Они не подменяются локальными unit/DB тестами.
