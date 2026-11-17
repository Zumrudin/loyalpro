# Исправление независимого auth/tenant аудита

Статус: реализация принята и выложена на dev 17.11.2026, source `0d3c6b8`. Повторная приёмка: 343 candidate tests, 16 live checks, browser MCP оба чата PASS; production не менялся. Детали и backup: `docs/security/2026-11-17-auth-tenant-rollout.md`. Нижние формулировки «ещё не выполнялись» относятся к моменту локальной приёмки до разрешения dev rollout.

Исходный отчёт: `docs/security/2026-11-17-independent-auth-tenant-audit.md`.
Объём: A1–A5. Руководитель принимает архитектурные решения и проверяет каждый diff; три младших исполнителя работают в отдельных файлах. Никаких реальных отправок, production-данных или выкладки в рамках локальной реализации.

## 1. Назначения и синхронизация товаров (исполнитель fix_homecare)

- Проверять client_id, record_id и их связь с текущим салоном до записи; использовать транзакцию для проверок, назначения и items.
- Закрыть POST и PUT, ограничить связанные JOIN/UPDATE; push разрешён только после commit и клиенту текущего салона.
- Категории обновлять через goods_sales с server-derived salonId.
- Тесты: два салона, чужие/несуществующие ID, несовпадающий клиент записи, rollback, отсутствие побочных эффектов, штатное создание/редактирование.

## 2. Вложения (исполнитель fix_attachments)

- Запретить прямую статическую выдачу `/uploads/gateway` до общего express.static.
- Выдавать вложения через авторизованный маршрут с проверкой салона; проверить traversal, ошибочные пути, отозванную сессию и роль.
- Сохранить просмотр изображений, audio/video и скачивание документов в чате через Bearer-запросы и Blob либо другой проверенный ограниченный механизм.
- Учесть существующие файлы и URL без разрушительного переноса. Проверить потребителей файлов; отдельно описать nginx/CDN: обход backend через статическую выдачу недопустим.

## 3. Пароли и сессии (исполнитель fix_auth)

- При must_change_password разрешать только необходимые me/change-password/logout; прямой API должен отказать остальным действиям.
- Recovery CLI: import-safe entry point, секрет без argv/stdout, изменение хеша и отзыв всех сессий в одной транзакции.
- Тесты: временная/обычная сессия, успешная смена, отзыв старых сессий, rollback CLI и отсутствие вывода пароля.

## 4. Защита БД (руководитель)

- Добавить идемпотентную защиту связей назначения с клиентом, записью и сотрудником по салону в migrations.js.
- Новые ограничения не должны автоматически удалять/перепривязывать старые данные. Сначала блокировать новые неверные связи; существующие нарушения выявлять агрегатным аудитом и устранять отдельно.
- Сохранить существующее ON DELETE SET NULL для необязательных ссылок и удаление салона CASCADE. Проверить это на отдельном временном PostgreSQL с синтетическими таблицами.
- Оценить блокировки индексов/ALTER TABLE до выкладки; bounded lock/statement timeouts. Совместимость со старой версией приложения сохраняется для корректных связей. При rollback приложения защитные ограничения сохранять; автоматический откат данных не нужен.

## 5. Ревью и приёмка (руководитель)

- Проверить diff каждого исполнителя и достижимые callers; преобразовать audit characterization в защитные regression assertions.
- Запустить сфокусированные backend и frontend тесты, реальный изолированный DB-тест миграции; browser MCP при наличии.
- Не включать чужие изменения scripts/journal-toolbar-ui-e2e.js и scripts/sidebar-ui-e2e.js.
- Обновить CLAUDE.md, отчёт и память: чётко разделить исправлено в коде / проверено локально / применено на сервере.
- Подготовить runbook выкладки: backup → read-only audit → ограничения с timeout → приложение/интерфейс и nginx как единый пакет → отрицательные и штатные smoke checks → rollback. Старые публичные пути должны оставаться закрыты и при rollback.

Критерий готовности: все A1–A5 закрыты кодом и воспроизводимыми проверками; нет внешних эффектов до успешной авторизации/commit; указан любой непроверенный инфраструктурный шаг. Выкладка и изменение существующих данных — отдельные операции.

## Приёмка реализации — 17.11.2026

Все пять исправлений реализованы; руководитель проверил diff и вернул на доработку несуществующий db.tx (заменён реальным withTransaction), URL-encoded обход raw static deny, фильтр новых ссылок в журнале и открытие окна после async fetch. Итоговые решения: disabled gateway account сохраняет доступ своего салона к истории; удалённый аккаунт не разрешает скачивание. Account mapping использует external_id, как webhook. Неизвестные MIME выдаются как application/octet-stream attachment. Старые повреждённые связи не раскрывают чужое имя/телефон через JOIN и не перепривязываются миграцией.

Общий запуск из backend:

```sh
HOME_CARE_AUDIT_PG_SOCKET=/tmp/loyalpro-auth-tenant-pg npx jest --runInBand --runTestsByPath home-care-tenant-db.test.js tenant-independent-audit.test.js boundaries-independent-audit.test.js auth-independent-audit.test.js reset-password-security.test.js staff-auth-security.test.js chat-attachments.test.js chat-route-send.test.js chatpush-webhook-route.test.js chatpush-webhook-provider.test.js journal-ui.test.js query-token-ui.test.js homecare-tree.test.js home-care-send.test.js case-tenant-integrity.test.js mobile-client-security.test.js mobile-auth-routes-security.test.js access-tickets.test.js salon-security.test.js
```

**19 suites / 356 tests PASS**, из них 13 — реальный отдельный PostgreSQL15 в временном каталоге, только synthetic schema, каждая проверка rollback. Подтверждены все три чужих FK на INSERT/UPDATE, запрет переноса связанного родителя в другой салон, nullable links, SET NULL и CASCADE, идемпотентность, NOT VALID для legacy rows, отсутствие изменения товаров другого салона. Тест по умолчанию skip без явного socket opt-in; production DATABASE_URL он не использует.

Browser MCP с фактическими chat.js/journal-chat.js, строгим CSP и синтетическим локальным API: ссылка → Bearer fetch → Blob viewer в обоих интерфейсах; window.opener=null; запрос без токена отвергнут. Page errors: 0; ожидаемые console network errors от отрицательного запроса и отсутствующего favicon. В первом запуске ошибочная glob-маска ожидания blob URL вызвала timeout; исправлена regex-маской, повторный проход успешен. Реальные вложения не читались.

`git diff --check` и syntax checks PASS. Полный исторически красный Jest и live OTP не запускались, mobile код не менялся. Dev/production rollout, аудит реальных старых связей и nginx/CDN deny ещё не выполнялись. Инструкция: `docs/security/2026-11-17-auth-tenant-rollout.md`.
