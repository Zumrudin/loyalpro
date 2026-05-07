# Booking Contact Sheet — Design

**Status**: Pending user review
**Date**: 2026-05-07
**Scope**: Mobile (`/root/mobile`) + Backend (`/root/loyalpro`)

## Problem

Клиент в приложении должен иметь возможность инициировать запись на приём, но самостоятельная online-запись через YClients намеренно отключена (политическое решение клиники: оператор сам подбирает время и подтверждает). Сейчас CTA «Записаться» на главном экране ведёт на список существующих записей — это путает пользователей и не решает задачу.

## Solution

При тапе на «Записаться» открывается bottom sheet с четырьмя действиями:

1. **Позвонить в клинику** — `tel:<phone>`
2. **Telegram** — `tg://resolve?domain=<handle>` (handle без `@`)
3. **WhatsApp** — `whatsapp://send?phone=<digits-only>`
4. **MAX** — `https://max.ru/<handle>`

Каждая кнопка скрывается, если соответствующее поле в `app_settings` пустое — админ может выключить любой канал из админки loyalpro без релиза приложения.

Никакого предзаполненного текста сообщения не передаётся — клиент пишет сам.

YClients API, заявки в БД, встроенный чат — **вне scope этой фичи**.

## Architecture

### Backend (`/root/loyalpro`)

**Миграция.** Миграции в проекте хранятся inline в [backend/migrations.js](../../../backend/migrations.js) как `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` вызовы (директория `backend/migrations/` существует, но используется только для отдельных мобильных таблиц). Добавляем после блока `CREATE TABLE app_settings` (~line 248):

```js
await client.query(`
  ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS max TEXT
`).catch(() => {});
```

**`backend/routes/app-settings.js`**:

- `GET /` — добавить `max: row.max` в response object рядом с `telegram`
- `PUT /` — принять `max` в body; добавить в `UPDATE` и `INSERT` SQL рядом с `telegram`

**`backend/frontend/index.html`** (это файл админки):

- После input `app-telegram` (line 644) добавить новый блок:
  ```html
  <div class="fg" style="margin:0">
    <label class="fl" style="font-size:11.5px">MAX</label>
    <input type="text" id="app-max" placeholder="@clinic">
  </div>
  ```

**`backend/frontend/js/pages/settings.js`**:

- В `loadAppSettings()` (after line 217): `s('app-max', d.max);`
- В `saveAppSettings()` (after line 235): `max: g('app-max'),`

### Mobile (`/root/mobile`)

**`src/store/appSettingsStore.js`**:

- В initial state добавить `max: null`
- В `fetchAppSettings()` распаковать `data.max` так же как `data.telegram`
- В кэшируемый `settings` объект добавить `max`

**Новый компонент `src/components/BookingContactSheet.js`**:

- Принимает `visible: bool`, `onClose: () => void`
- Читает `phone`, `telegram`, `whatsapp`, `max` из `useAppSettingsStore`
- Рендерит RN `Modal` с `transparent={true}`, `animationType="slide"`
- Подложка: `BlurView` (как в tab-баре) + полупрозрачный затемняющий слой; тап по подложке закрывает
- Контейнер шита: радиус `24px` сверху, фон `T.cream` (#F5F3F0), padding `24px`
- Заголовок: «Связаться с клиникой» (`T.brown`, weight 600, 18px)
- 4 кнопки в столбик с gap `12px`. Каждая кнопка:
  - Высота 56px, радиус 16px
  - LinearGradient `[T.champagne, T.champDark]` (золотой брендовый), как у существующего `bookNowBtn` в `HomeScreen.js`
  - Слева Ionicon (24px, белый), справа текст (16px, weight 600, белый)
  - Иконки: `call` / `paper-plane` (Telegram) / `logo-whatsapp` / `chatbubbles` (MAX — нет родного логотипа в Ionicons)
- Кнопка скрывается, если её источник в store пустой (`null` или пустая строка)
- Если все 4 пустые — рендерим текст «Контакты клиники не настроены» вместо кнопок
- При нажатии — `Linking.openURL(url).catch(() => Alert.alert('Не удалось открыть приложение'))`, потом `onClose()`

Нормализация:
- `phone` и `whatsapp` → `String(value).replace(/\D/g, '')` (только цифры)
- `telegram` → если начинается с `@`, отрезать `@`; если уже URL `https://t.me/...`, использовать как есть
- `max` → аналогично telegram (handle с/без `@`)

**`src/screens/HomeScreen.js:476`**:

- Завести локальный state `const [sheetOpen, setSheetOpen] = useState(false);`
- На кнопке «Записаться» в empty-state поменять `onPress={() => navigation.navigate('Bookings')}` на `onPress={() => setSheetOpen(true)}`
- Перед закрывающим тегом корневого `View` отрендерить `<BookingContactSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />`

## Components & Boundaries

| Component | Purpose | Inputs | Outputs |
|---|---|---|---|
| `BookingContactSheet` | Модальный селектор канала связи | `visible`, `onClose` | Side-effect: `Linking.openURL` |
| `appSettingsStore` (расш.) | Источник правды для контактов | — | `phone`, `telegram`, `whatsapp`, `max` |
| `app_settings` table (расш.) | Хранение значения MAX | — | колонка `max` |

`BookingContactSheet` ничего не знает про `HomeScreen` и наоборот. Любая будущая точка входа («Записаться» в `BookingsScreen`, FAB и т.д.) импортирует тот же компонент.

## Data Flow

```
[App start] → fetchAppSettings → GET /api/app-settings
                                  ↓
                         appSettingsStore (in-memory + SecureStore cache)
                                  ↓
[User taps Записаться] → setSheetOpen(true)
                          ↓
                  BookingContactSheet reads store
                          ↓
[User taps канал] → Linking.openURL → external app
                  → onClose()
```

## Error Handling

| Случай | Поведение |
|---|---|
| Все 4 поля пустые | Шит открывается, показывает текст «Контакты клиники не настроены» вместо кнопок |
| Поле задано, но `Linking.openURL` бросил ошибку | `Alert.alert('Не удалось открыть приложение')`, шит закрывается |
| Сеть упала на старте, `app_settings` не загрузились | Используется `app_settings_cache` из SecureStore (существующая логика). Если кэша нет — все кнопки скрыты, видим «Контакты не настроены» |
| Невалидное значение (например, кириллица в `whatsapp`) | Нормализация `replace(/\D/g, '')` отбросит всё кроме цифр; если получится пустая строка — кнопка скроется |

## Testing

Test suite в проекте отсутствует ([CLAUDE.md](../../../CLAUDE.md)). Manual smoke checklist:

1. Все 4 поля заполнены — все 4 кнопки видны, каждая открывает свой мессенджер/звонок.
2. `max` пустой в админке → кнопка MAX исчезает.
3. Все поля очищены → шит показывает «Контакты не настроены».
4. Тап вне шита (по затемнению) → шит закрывается.
5. Админ обновил `max` в loyalpro → клиент перезапускает приложение → новое значение подтягивается; offline → используется кэш.
6. iOS + Android emulator + web (web — `Linking.openURL` отдаёт окно браузера, проверить что не падает).

## Out of Scope

- YClients online booking API (`book_services`, `book_record` etc.) — отдельная фича на будущее
- Сохранение «заявки на запись» в БД loyalpro
- Push-уведомление админу о тапе
- Аналитика тапов по каналам
- FAB на других экранах
- Локализация (всё на русском, как и весь проект)

## Migration Order

1. Backend миграция (новый `ALTER TABLE` блок в `migrations.js`)
2. Backend routes (GET + PUT в `app-settings.js`)
3. Backend admin UI (input в `index.html` + read/write в `settings.js`)
4. Mobile store (`max` field в `appSettingsStore.js`)
5. Mobile component (`BookingContactSheet.js`)
6. Mobile wiring (`HomeScreen.js`)

Каждый шаг — отдельный атомарный коммит.
