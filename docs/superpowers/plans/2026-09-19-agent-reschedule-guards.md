# План: гейты переноса записи + соседние дыры инцидента 2026-09-19

Спека: `docs/superpowers/specs/2026-09-19-agent-reschedule-guards-design.md`. Каждая задача — тест → красный → код → зелёный → коммит. Все тесты — `cd backend && npx jest <файл>`.

## Задача 1. Ретрай 429 на write-путях YClients
- `services/yclients-retry.js`: `withRateLimitRetry(fn, {retries, delayMs, sleep})`, `isRateLimitError(err)`.
- `yclients-retry.test.js`: повтор на `status 429`, на текст «Превышен лимит запросов», НЕ повтор на прочих, лимит попыток, задержка через инжектированный `sleep`.
- Провести через него `ycUpdateRecord` в `booking-modify.js` (все три функции) и `ycCreateRecord` в `booking.js`; тесты в `agent-booking-modify.test.js` и `agent-booking.test.js`.

## Задача 2. `slot-evidence.js`
- `createSlotEvidence()`: `add`, `has`, `size`, `seedFromJournal`.
- `agent-slot-evidence.test.js`.

## Задача 3. Гейты write-инструментов
- `reschedule-booking.js`: `unverified_slot` → `needs_confirmation` → дальше как было. `agent-reschedule-booking.test.js`.
- `create-booking.js`: `unverified_slot` перед lead-time. `agent-create-booking-slot-evidence.test.js`.
- `book-chain.js`: `slotEvidence` вырезается из `linkCtx`. Тест в `agent-book-chain.test.js`.

## Задача 4. Оркестратор
- `toolCtx.slotEvidence` (на попытку, засев из журнала), `toolCtx.recentDialogText`, пополнение evidence после каждого вызова.
- `reschedule_booking`: ошибка без hint-флагов → `bookingErrored`; успех → `bookingSucceeded`.
- `slotToolCalled`, `prevOfferTimes`; вызовы новых проверок reply-guard.
- Сьюты в `agent-orchestrator.test.js`.

## Задача 5. Reply-guard
- `checkUnbackedUnavailability`, `checkRejectedRepeat`, `REFUSAL_RE`, `HARD_TYPES`, тексты в `buildHardFixPrompt`.
- `agent-reply-guard.test.js`.

## Задача 6. `parseDayPart`
- `patient-time.js` + `get-available-slots.js` (`day_part_inferred`). Тесты `agent-patient-time.test.js`, `agent-slots-offer.test.js`.

## Задача 7. Пустая запись
- `record-liveness.isEmptyRecord`, фильтр в `list-client-bookings.js`. Тесты.

## Задача 8. Закрытие окна
- `window-handover.js` (`decideWindowHandover`), `history.lastAgentReplyAt`, `closing.isPureClosing` экспорт, `config.AGENT_WINDOW_HANDOVER_MIN`, вебхук `meta.text`, диспетчер, `dialog-state`/`operator-pause-sweep` для `window_closed`.
- Тесты: `agent-window-handover.test.js`, `agent-dispatcher.test.js`, `agent-dialog-state.test.js`, `agent-history.test.js`.

## Задача 9. Промпт и логи
- Сценарий 3 Шаг 5/СОГЛАСИЕ: упоминание `unverified_slot`/`needs_confirmation` (правка существующего правила). `agent-system-prompt.test.js`.
- Тексты диспетчера «запись/перенос не удался».

## Задача 10. Документация и прогон
- CLAUDE.md (раздел AI-агент), память. Полный `npx jest` (известный флейк `primary-clients.test.js` исключить).
