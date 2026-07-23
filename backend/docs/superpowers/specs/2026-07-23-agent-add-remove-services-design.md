# Агент: добавление/удаление услуг в существующем визите

Дата: 2026-07-23. Статус: утверждён.

## Проблема

Пациент по ходу диалога просит добавить вторую процедуру к своей записи
(«могу добавить фото лица?») или убрать услугу. Инструмента нет — агент
эскалирует на человека (agent_events id 39). Нужна возможность менять состав
услуг визита, **всегда пересчитывая общую длительность**, чтобы визит не
накладывался на следующие записи мастера.

## Решение

### Инструмент `modify_booking_services` (`services/agent/tools/modify-booking-services.js`)

Вход:
- `record_id` (integer, обяз.) — из `list_client_bookings`.
- `add_service_yc_ids` (integer[], опц.) — yc_id услуг из `list_services`.
- `remove_service_yc_ids` (integer[], опц.) — yc_id услуг из `list_services`.

Логика тонкой обёртки (как reschedule/cancel):
- Резолвит `expectedYcClientId = identity.resolveYclientsClientId(salonId, ctx.clientPhone)`;
  при отсутствии — отказ (не открываем модификацию на выдуманный record_id).
- Требует хотя бы один из массивов непустым, иначе `invalid_args`.
- Зовёт `modifyBookingServices` и возвращает результат модели.

### Исполнитель `modifyBookingServices` (`services/agent/booking-modify.js`)

Сигнатура: `modifyBookingServices(salonId, { dialogKey, recordId, expectedYcClientId, addServiceYcIds, removeServiceYcIds })`.

Поток:
1. `loadSalon`; `ycGetRecord(recordId)`; проверка `ownershipError`.
2. Новый набор услуг = текущие `rec.services` (по id) + `add` − `remove`, дедуп по id.
3. Гварды:
   - Набор пуст → `{ ok:false, removed_all:true }` → модель предлагает отмену (`cancel_booking`).
   - Каждый добавляемый yc_id: есть в каталоге (`list_services`) **и** мастер записи
     (`rec.staff_id`) его выполняет; иначе `{ ok:false, invalid_service:true, error }`
     (корректирующая ошибка, как в create_booking).
4. Пересчёт: `seance_length = Σ durationByService[id]` по всему набору
   (`ycGetServiceMeta(salon)`), сек. Если какая-то длительность отсутствует —
   считаем её 0 (best-effort), общий фолбэк на `rec.seance_length` только если сумма 0.
5. Проверка наложения: `ycGetDayRecords(salon, датаНашейЗаписи)`, найти запись
   мастера (`rec.staff_id`) с минимальным `datetime > rec.datetime` (исключая нашу).
   Если `start(rec) + seance_length > start(next)` → `{ ok:false, overlaps:true }`
   → модель отказывает и предлагает другое время/день или админа. Визит не меняется.
6. Иначе `ycUpdateRecord(authSalonFor(salon), recordId, { staff_id, services, client:clientOf(rec),
   datetime: rec.datetime, seance_length, comment, save_if_busy:false })`.
   `save_if_busy:false` — грубая страховка от прочих конфликтов (напр. оборудование).
7. `logEvent 'booking_services_modified'`; вернуть `{ ok:true, record_id, seance_length, services_count }`.

### Интеграция

- `tools/index.js`: зарегистрировать инструмент; отметить WRITE (оркестратор
  ловит falseSuccess/write-сигналы).
- `system-prompt.js`: сценарий «добавить/удалить услугу» (кратко): взять record_id
  из list_client_bookings, yc_id услуги из list_services; при `overlaps` — не
  обещать, предложить варианты; при `removed_all` — предложить отмену.
- Обновить snapshot реестра инструментов в `agent-tools.test.js`.

## Тесты

`agent-booking-modify.test.js` (моки yclients-records/yclients):
- add: услуга добавлена, seance_length = сумма длительностей.
- remove: услуга убрана, длительность пересчитана.
- removed_all: удаление последней → `removed_all:true`, PUT не зовётся.
- overlaps: следующая запись близко → `overlaps:true`, PUT не зовётся.
- invalid_service: добавляемый id не выполняется мастером → `invalid_service:true`.
- ok-path: PUT вызван с верным body (services, seance_length, client, save_if_busy).

## Границы v1

Наложение проверяется по креслу мастера (следующая запись мастера за день).
Наложение по общему оборудованию (аппараты) в v1 не проверяется проактивно —
подстраховано `save_if_busy:false`. Расширение — отдельной итерацией.
