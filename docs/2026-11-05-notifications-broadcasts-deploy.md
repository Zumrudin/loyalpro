# Выкладка уведомлений и рассылок — 05.11.2026

По запросу владельца изучены и выложены автоуведомления и разовые рассылки через мессенджеры.

## Состав

- Исходная ветка: `feat/notifications-own-module`, включая `feat/broadcast-messengers`.
- Релизная ветка: `release/notifications-broadcasts-20261105`.
- Код продакшена: `13300e5`, база `origin/main` (`422d7ef`).
- Автоуведомления перенесены до `5086b05`; рассылки — изменения `0c65364..624c786`.
- Экономика, документы и незакоммиченные изменения исходной рабочей папки не включены.
- Изменены сервисы notifications и broadcast-messengers, связанные маршруты, хуки, миграции,
  запуск воркера, send-pacing, frontend уведомлений/рассылок и зависимости (exceljs).
- Дополнительно запрещено использовать картинку рассылки другого салона в create/test;
  регрессия проверяет отказ до обращения к аудитории и отправки.
- Код предыдущего прод-релиза сверялся с `12116dd`: локальных правок в отслеживаемых
  backend/frontend файлах (кроме исключённых зависимостей/конфигурации/загрузок) не обнаружено.

## Проверки

- Backend (из backend/): `JWT_SECRET=<synthetic-test-value> npx --no-install jest
  'backend/(notifications|messaging|care|reminders|webhook|chatpush|agent-booking-modify|broadcast-messengers|telegram-api-base)'
  --runInBand`: 50 наборов, 1521 тест, все прошли; TZ через jest.global-setup — Europe/Moscow.
- `node --test frontend/js/pages/*.test.js`: 126/126.
- `git diff --cached --check`: успешно.
- Первый запуск тестов из изолированной копии был прерван: широкий шаблон совпал
  с именем worktree и отсутствовала тестовая JWT-переменная. Итоговый запуск указан выше.
- В Jest были MaxListenersExceededWarning и задержка завершения из-за открытых ресурсов;
  итоговый процесс завершился самостоятельно.
- Production: 4 новые таблицы; 6 полей notification_rules; 3 критичных индекса
  notification_jobs; 2 индекса broadcast_recipients; 9 полей broadcasts и 11 полей
  broadcast_recipients. telegram_chat_id допускает NULL.
- Read-only HTTP с существующей owner-сессией: settings/rules/jobs/ratings/broadcasts — 200;
  settings.mode=off. Без авторизации settings/broadcasts — 401. Новые JS-файлы доступны.
- Синтетический JWT без серверной сессии закономерно получил 401; проверка повторена
  с действующей сессией, без создания новых сессий и вывода токена.
- Сайт https://zumrudin.ru/ — 200. PM2 loyalpro online; оба новых воркера запущены;
  error-лог нового релиза пуст на момент проверки.
- Браузерный E2E не запускался: требуемый репозиторием Playwright MCP недоступен.
- Живые отправки, операции с записями YClients, импорт шаблонов и backfill не запускались.

## Релиз и откат

Прод: `/srv/loyalpro/current` → `/srv/loyalpro/releases/notifications-13300e5`.
Установлены зависимости через `npm ci --omit=dev --no-audit --no-fund`.
Конфигурация скопирована из прежнего релиза без вывода секретов; uploads остаются общими.
PM2 перезапущен через `/srv/loyalpro/ecosystem.config.js`.

Свежий дамп перед переключением: `/srv/loyalpro-backups/pre-notifications-13300e5/loyalpro.dump`.
Проверено чтение оглавления `pg_restore --list`; пробное восстановление не выполнялось.
Предыдущий релиз: `/srv/loyalpro/releases/main-12116dd`.

Откат кода: атомарно вернуть ссылку current на предыдущий релиз и перезапустить loyalpro
тем же ecosystem-файлом. Добавленные таблицы/колонки оставить. Старый бот-воркер не умеет
различать transport: после создания первой messenger-рассылки откат требует предварительно
остановить/погасить такие рассылки согласованной операцией. На момент выкладки активных
рассылок, старых notification_sends pending и правил уведомлений не было.

## Эксплуатационный статус

Автоуведомления **off**, правила не настроены, notification_jobs пуст.
Разовые рассылки доступны для ручного запуска; тестовая отправка не выполнялась.
Chatpush не отключался. Переход shadow → live, загрузка шаблонов и догон — отдельный
этап по `docs/2026-10-13-notifications-cutover-runbook.md`.
