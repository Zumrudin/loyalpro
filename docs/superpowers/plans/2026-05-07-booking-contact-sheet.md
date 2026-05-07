# Booking Contact Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При тапе на «Записаться» в мобильном приложении открывается bottom sheet с кнопками «Позвонить / Telegram / WhatsApp / MAX»; админ управляет каналами через loyalpro-админку (поле `max` добавляется в `app_settings`).

**Architecture:** Расширяем существующий `app_settings` (single-row global table в loyalpro) одной колонкой `max`. Mobile получает её через существующий `GET /api/app-settings` и кладёт в `appSettingsStore`. Новый компонент `BookingContactSheet` читает `phone/telegram/whatsapp/max` из стора и рендерит RN `Modal` с кнопками; пустые поля скрываются. Подключается к кнопке «Записаться» в `HomeScreen` empty-state.

**Tech Stack:** React Native (Expo SDK 54), Zustand, Express + node-postgres backend, Ionicons, expo-linear-gradient, expo-blur. Тестов в проекте нет — верификация ручная (curl + симулятор).

**Note on TDD:** В проекте отсутствует тестовый раннер (`package.json` определяет только `start/android/ios/web`, см. CLAUDE.md). Каждая задача завершается ручной верификацией (curl/админка/симулятор) вместо автотестов. Не выдумывайте `npm test`.

**Spec:** [`docs/superpowers/specs/2026-05-07-booking-contact-sheet-design.md`](../specs/2026-05-07-booking-contact-sheet-design.md)

**Repos:** Plan касается двух репозиториев:
- Backend: `/root/loyalpro` (отдельный git repo)
- Mobile: `/root/mobile` (этот repo)

Tasks 1-3 — backend, tasks 4-6 — mobile. Каждый таск коммитится в свой репозиторий.

---

## File Structure

**Backend (`/root/loyalpro`):**
| File | Action | Responsibility |
|---|---|---|
| `backend/migrations.js` | Modify | Добавить `ALTER TABLE app_settings ADD COLUMN max` после CREATE-блока |
| `backend/routes/app-settings.js` | Modify | Прокинуть `max` в GET-ответ и принять в PUT-body |
| `backend/frontend/index.html` | Modify | Новый `<input id="app-max">` рядом с Telegram |
| `backend/frontend/js/pages/settings.js` | Modify | Загрузка/сохранение значения MAX в админке |

**Mobile (`/root/mobile`):**
| File | Action | Responsibility |
|---|---|---|
| `src/store/appSettingsStore.js` | Modify | Добавить `max` в state, fetch, кэш |
| `src/components/BookingContactSheet.js` | Create | Bottom-sheet UI с 4 кнопками, deeplinks |
| `src/screens/HomeScreen.js` | Modify | Завести `sheetOpen` state, подключить компонент, поменять onPress кнопки «Записаться» |

---

## Task 1: Backend migration — добавить колонку `max` в `app_settings`

**Repo:** `/root/loyalpro`

**Files:**
- Modify: `backend/migrations.js` (вставка после блока `CREATE TABLE app_settings`, ~line 248)

- [ ] **Step 1: Найти блок `// ── App Settings ──` в `backend/migrations.js`** и добавить ALTER сразу после закрывающего `).catch(() => {});` этого блока.

```js
// ── App Settings ───────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS app_settings (
    id           SERIAL PRIMARY KEY,
    clinic_name  TEXT NOT NULL DEFAULT '',
    logo_url     TEXT,
    phone        TEXT,
    whatsapp     TEXT,
    telegram     TEXT,
    instagram    TEXT,
    maps_url     TEXT,
    email        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

// ── App Settings: MAX messenger field ──────────────────────
await client.query(`
  ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS max TEXT
`).catch(() => {});
```

- [ ] **Step 2: Перезапустить loyalpro-сервер**, чтобы миграция выполнилась.

```bash
# Найти процесс (pm2 или nodemon)
pm2 restart loyalpro 2>/dev/null || pkill -HUP -f "node server.js" || echo "Restart manually"
```

- [ ] **Step 3: Верификация — поле появилось в БД**

```bash
psql $DATABASE_URL -c "\d app_settings" | grep max
```

Expected: строка вида `max | text |` в выводе.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add backend/migrations.js
git commit -m "feat(app-settings): add max messenger column

Adds 'max' TEXT column to app_settings table for the MAX messenger
contact handle. Surfaced via /api/app-settings and used by mobile
booking contact sheet."
```

---

## Task 2: Backend — прокинуть `max` в `/api/app-settings`

**Repo:** `/root/loyalpro`

**Files:**
- Modify: `backend/routes/app-settings.js`

- [ ] **Step 1: Обновить GET-ответ** (line ~30-45). Добавить `max: row.max` рядом с `telegram`:

```js
// Public — mobile app calls this at startup without auth
router.get('/', async (req, res) => {
  try {
    const row = await db.oneOrNone('SELECT * FROM app_settings ORDER BY id LIMIT 1');
    if (!row) return res.json({});
    res.json({
      clinicName: row.clinic_name,
      logoUrl:    row.logo_url,
      phone:      row.phone,
      whatsapp:   row.whatsapp,
      telegram:   row.telegram,
      max:        row.max,
      instagram:  row.instagram,
      mapsUrl:    row.maps_url,
      email:      row.email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Обновить PUT-body destructuring и SQL** (line ~48-69). Добавить `max` везде:

```js
// Admin only — update text fields
router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clinicName, phone, whatsapp, telegram, max, instagram, mapsUrl, email } = req.body;
    const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
    if (existing) {
      await db.query(
        `UPDATE app_settings SET clinic_name=$1, phone=$2, whatsapp=$3, telegram=$4,
         max=$5, instagram=$6, maps_url=$7, email=$8, updated_at=NOW() WHERE id=$9`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         max || null, instagram || null, mapsUrl || null, email || null, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO app_settings (clinic_name, phone, whatsapp, telegram, max, instagram, maps_url, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         max || null, instagram || null, mapsUrl || null, email || null]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**Важно:** placeholders шифт `$5..$9` — внимательно перенумеровать массив значений и `id=$9`.

- [ ] **Step 3: Перезапустить сервер.**

```bash
pm2 restart loyalpro 2>/dev/null || pkill -HUP -f "node server.js"
```

- [ ] **Step 4: Верификация GET — пока пустой `max`**

```bash
curl -s http://localhost:3000/api/app-settings | jq '.max // "absent"'
```

Expected: `null` (не "absent" — значит ключ присутствует).

- [ ] **Step 5: Верификация PUT — установить значение и прочитать обратно**

```bash
# Получить admin JWT — взять из браузера loyalpro (localStorage 'lp_tk') или используйте свой способ
TOKEN="<вставьте JWT админа>"

curl -s -X PUT http://localhost:3000/api/app-settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"max":"@peri_clinic_test"}'

curl -s http://localhost:3000/api/app-settings | jq '.max'
```

Expected: `"@peri_clinic_test"`.

После проверки очистите тестовое значение:

```bash
curl -s -X PUT http://localhost:3000/api/app-settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"max":null}'
```

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro
git add backend/routes/app-settings.js
git commit -m "feat(app-settings): expose max field via GET/PUT

Wires the new 'max' column into the public GET and admin PUT
handlers so mobile clients see it and admins can edit it."
```

---

## Task 3: Backend admin UI — input для MAX в loyalpro-админке

**Repo:** `/root/loyalpro`

**Files:**
- Modify: `backend/frontend/index.html` (вставка после Telegram input на line 644)
- Modify: `backend/frontend/js/pages/settings.js` (load + save)

**Note:** Файлы фронта обновляются без перезапуска — просто перезагрузите страницу `/settings` в браузере.

- [ ] **Step 1: Добавить HTML input в `index.html` после блока Telegram** (line 644):

Найти:
```html
<div class="fg" style="margin:0"><label class="fl" style="font-size:11.5px">Telegram</label><input type="text" id="app-telegram" placeholder="@clinic"></div>
```

Добавить **сразу после** этой строки:
```html
<div class="fg" style="margin:0"><label class="fl" style="font-size:11.5px">MAX</label><input type="text" id="app-max" placeholder="@clinic или https://max.ru/clinic"></div>
```

- [ ] **Step 2: Обновить `loadAppSettings()` в `js/pages/settings.js`** (line 217). Добавить строку после `s('app-telegram', d.telegram);`:

```js
s('app-clinic-name', d.clinicName);
s('app-phone',       d.phone);
s('app-whatsapp',    d.whatsapp);
s('app-telegram',    d.telegram);
s('app-max',         d.max);
s('app-instagram',   d.instagram);
s('app-maps-url',    d.mapsUrl);
s('app-email',       d.email);
```

- [ ] **Step 3: Обновить `saveAppSettings()` в `js/pages/settings.js`** (line 235). Добавить `max` в объект:

```js
await api('PUT', '/api/app-settings', {
  clinicName: g('app-clinic-name'),
  phone:      g('app-phone'),
  whatsapp:   g('app-whatsapp'),
  telegram:   g('app-telegram'),
  max:        g('app-max'),
  instagram:  g('app-instagram'),
  mapsUrl:    g('app-maps-url'),
  email:      g('app-email'),
});
```

- [ ] **Step 4: Верификация — открыть админку и проверить поле**

1. Открыть `https://<loyalpro-host>/settings` в браузере, авторизоваться как owner/admin.
2. Найти секцию «Настройки приложения» (App Settings).
3. Убедиться что новое поле **MAX** видно сразу после **Telegram**.
4. Ввести `@test_max_handle`, нажать Save.
5. Перезагрузить страницу — значение должно подтянуться.
6. Проверить через curl:
   ```bash
   curl -s http://localhost:3000/api/app-settings | jq '.max'
   ```
   Expected: `"@test_max_handle"`.
7. Очистить (поставить пустое значение) и сохранить — проверить что приходит `null`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/frontend/index.html backend/frontend/js/pages/settings.js
git commit -m "feat(admin): add MAX messenger field to app settings UI

Adds an editable MAX input next to Telegram in /settings, with
load/save wiring to /api/app-settings."
```

---

## Task 4: Mobile store — `max` в `appSettingsStore`

**Repo:** `/root/mobile`

**Files:**
- Modify: `src/store/appSettingsStore.js`

- [ ] **Step 1: Заменить файл целиком** (33 → 34 line diff: добавляется `max` в трёх местах — initial state, fetched settings, кэш-объект уже его получает автоматически):

```js
import { create } from 'zustand';
import { Platform } from 'react-native';
import { appSettingsAPI } from '../api/app-settings';

const CACHE_KEY = 'app_settings_cache';

const storage = {
  async setItem(key, value) {
    try {
      const SecureStore = require('expo-secure-store');
      await SecureStore.setItemAsync(key, value);
    } catch {
      if (Platform.OS === 'web') localStorage.setItem(key, value);
    }
  },
  async getItem(key) {
    try {
      const SecureStore = require('expo-secure-store');
      return await SecureStore.getItemAsync(key);
    } catch {
      if (Platform.OS === 'web') return localStorage.getItem(key);
      return null;
    }
  },
};

export const useAppSettingsStore = create((set) => ({
  clinicName: '',
  logoUrl:    null,
  phone:      null,
  whatsapp:   null,
  telegram:   null,
  max:        null,
  instagram:  null,
  mapsUrl:    null,
  email:      null,
  loaded:     false,

  fetchAppSettings: async () => {
    try {
      const data = await appSettingsAPI.getAppSettings();
      const settings = {
        clinicName: data.clinicName || '',
        logoUrl:    data.logoUrl    || null,
        phone:      data.phone      || null,
        whatsapp:   data.whatsapp   || null,
        telegram:   data.telegram   || null,
        max:        data.max        || null,
        instagram:  data.instagram  || null,
        mapsUrl:    data.mapsUrl    || null,
        email:      data.email      || null,
      };
      set({ ...settings, loaded: true });
      await storage.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch {
      // Offline fallback: load last cached settings
      try {
        const cached = await storage.getItem(CACHE_KEY);
        if (cached) set({ ...JSON.parse(cached), loaded: true });
        else set({ loaded: true });
      } catch {
        set({ loaded: true });
      }
    }
  },
}));
```

- [ ] **Step 2: Верификация — store содержит `max` после старта**

1. Перед запуском убедиться, что Backend Task 2 закоммичен и сервер перезапущен, иначе `data.max` будет undefined и в стор попадёт `null` (что тоже валидно).
2. Установить тестовое значение в loyalpro-админке (`@test_max`) — см. Task 3 Step 4.
3. Запустить mobile:
   ```bash
   cd /root/mobile
   npx expo start --clear
   ```
4. Открыть приложение в симуляторе/эмуляторе, дождаться загрузки.
5. Открыть React Native debugger / Metro logs — добавить временный лог в `App.js` или любом экране:
   ```js
   import { useAppSettingsStore } from './src/store/appSettingsStore';
   console.log('[verify] max =', useAppSettingsStore.getState().max);
   ```
6. Expected log: `[verify] max = @test_max`.
7. Удалить временный console.log перед коммитом.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add src/store/appSettingsStore.js
git commit -m "feat(store): add max messenger to appSettingsStore

Reads new 'max' field from /api/app-settings and caches it alongside
phone/whatsapp/telegram for offline fallback."
```

---

## Task 5: Mobile — компонент `BookingContactSheet`

**Repo:** `/root/mobile`

**Files:**
- Create: `src/components/BookingContactSheet.js`

- [ ] **Step 1: Создать файл `src/components/BookingContactSheet.js`** с полным содержимым:

```js
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Linking,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useAppSettingsStore } from '../store/appSettingsStore';

// ─── Design tokens (mirrors HomeScreen palette) ────────────────
const T = {
  pearl:      '#F5F3F0',
  champagne:  '#D4AF37',
  champDark:  '#A8881C',
  stone:      '#4A4540',
  stoneMuted: 'rgba(74,69,64,0.60)',
  shadow:     'rgba(100,90,70,0.20)',
};

// ─── URL builders ──────────────────────────────────────────────
function buildPhoneUrl(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `tel:${digits}` : null;
}

function buildTelegramUrl(handle) {
  const raw = String(handle || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  const clean = raw.replace(/^@/, '');
  return clean ? `tg://resolve?domain=${encodeURIComponent(clean)}` : null;
}

function buildWhatsappUrl(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `whatsapp://send?phone=${digits}` : null;
}

function buildMaxUrl(handle) {
  const raw = String(handle || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  const clean = raw.replace(/^@/, '');
  return clean ? `https://max.ru/${encodeURIComponent(clean)}` : null;
}

// ─── Single channel button ─────────────────────────────────────
function ChannelButton({ icon, label, url, onClose }) {
  const handlePress = async () => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Не удалось открыть приложение');
    } finally {
      onClose();
    }
  };

  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.btn} onPress={handlePress}>
      <LinearGradient
        colors={[T.champagne, T.champDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <Ionicons name={icon} size={22} color="#fff" style={styles.btnIcon} />
      <Text style={styles.btnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Main sheet ────────────────────────────────────────────────
export default function BookingContactSheet({ visible, onClose }) {
  const phone    = useAppSettingsStore((s) => s.phone);
  const telegram = useAppSettingsStore((s) => s.telegram);
  const whatsapp = useAppSettingsStore((s) => s.whatsapp);
  const max      = useAppSettingsStore((s) => s.max);

  const phoneUrl    = buildPhoneUrl(phone);
  const telegramUrl = buildTelegramUrl(telegram);
  const whatsappUrl = buildWhatsappUrl(whatsapp);
  const maxUrl      = buildMaxUrl(max);

  const hasAny = phoneUrl || telegramUrl || whatsappUrl || maxUrl;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
      </Pressable>

      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Связаться с клиникой</Text>

        {!hasAny ? (
          <Text style={styles.empty}>Контакты клиники не настроены</Text>
        ) : (
          <View style={styles.btnList}>
            {phoneUrl && (
              <ChannelButton
                icon="call"
                label="Позвонить в клинику"
                url={phoneUrl}
                onClose={onClose}
              />
            )}
            {telegramUrl && (
              <ChannelButton
                icon="paper-plane"
                label="Telegram"
                url={telegramUrl}
                onClose={onClose}
              />
            )}
            {whatsappUrl && (
              <ChannelButton
                icon="logo-whatsapp"
                label="WhatsApp"
                url={whatsappUrl}
                onClose={onClose}
              />
            )}
            {maxUrl && (
              <ChannelButton
                icon="chatbubbles"
                label="MAX"
                url={maxUrl}
                onClose={onClose}
              />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: T.pearl,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    shadowColor: T.shadow,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: T.stoneMuted,
    marginBottom: 14,
    opacity: 0.4,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
    marginBottom: 18,
  },
  empty: {
    fontSize: 14,
    color: T.stoneMuted,
    textAlign: 'center',
    paddingVertical: 28,
  },
  btnList: {
    gap: 12,
  },
  btn: {
    height: 56,
    borderRadius: 16,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  btnIcon: {
    marginRight: 14,
  },
  btnLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
```

- [ ] **Step 2: Верификация компилируется** — открыть Metro логи и убедиться, что нет красных ошибок. Сам компонент пока ниоткуда не подключен, поэтому в UI ничего не появится.

```bash
cd /root/mobile
# Если Expo dev server уже запущен — должен автоматически перебилдить
# Если нет:
npx expo start --clear
```

В Metro логах не должно быть `Unable to resolve module` или syntax errors.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add src/components/BookingContactSheet.js
git commit -m "feat(components): add BookingContactSheet bottom sheet

Modal with brand-styled buttons for Call/Telegram/WhatsApp/MAX,
sourced from appSettingsStore. Empty channels are hidden; if all are
empty, shows fallback text."
```

---

## Task 6: Mobile — подключить шит к кнопке «Записаться» в HomeScreen

**Repo:** `/root/mobile`

**Files:**
- Modify: `src/screens/HomeScreen.js`

- [ ] **Step 1: Найти секцию `import` в начале файла и добавить импорт компонента.** Импорт идёт после остальных компонентов — найти существующие импорты `from '../components/...'` и добавить:

```js
import BookingContactSheet from '../components/BookingContactSheet';
```

Если в файле ещё нет импорта `useState` из `react`, проверить: вероятно `useState` уже импортирован — он используется в других местах. Если нет, добавить:

```js
import React, { useState, useEffect, useCallback } from 'react';
```

(сохранив существующие импорты из `react`).

- [ ] **Step 2: Внутри компонента `HomeScreen` (перед `return`), завести state**

Найти место рядом с другими `useState` объявлениями в функциональном компоненте `HomeScreen` и добавить:

```js
const [bookingSheetOpen, setBookingSheetOpen] = useState(false);
```

- [ ] **Step 3: Поменять `onPress` кнопки «Записаться»** в empty-state карточке.

Найти в `HomeScreen.js` (line 463-478, в блоке `<TouchableOpacity style={s.bookNowBtn} ...>`):

```js
<TouchableOpacity
  style={s.bookNowBtn}
  onPressIn={() => { btnFill.value = withSpring(1); }}
  onPressOut={() => { btnFill.value = withSpring(0); }}
  onPress={() => navigation.navigate('Bookings')}
  activeOpacity={1}
>
```

Заменить `onPress={() => navigation.navigate('Bookings')}` на:

```js
  onPress={() => setBookingSheetOpen(true)}
```

Полный изменённый блок:

```js
<TouchableOpacity
  style={s.bookNowBtn}
  onPressIn={() => { btnFill.value = withSpring(1); }}
  onPressOut={() => { btnFill.value = withSpring(0); }}
  onPress={() => setBookingSheetOpen(true)}
  activeOpacity={1}
>
```

- [ ] **Step 4: Отрендерить шит в конце JSX-дерева компонента.**

Найти закрывающий тег корневого `View` или `ScrollView` функции `HomeScreen` (в самом конце return-блока). Перед закрывающим тегом или сразу после внешнего `View`, но в пределах того же фрагмента, добавить:

```js
<BookingContactSheet
  visible={bookingSheetOpen}
  onClose={() => setBookingSheetOpen(false)}
/>
```

Если корневой элемент — `<View>...</View>`, поместите шит как последний child перед `</View>`. Если используется `<>...</>` (fragment), туда же.

- [ ] **Step 5: Верификация — golden path**

1. Запустить:
   ```bash
   cd /root/mobile
   npx expo start --clear
   ```
2. В loyalpro-админке (Task 3) убедиться, что заполнены **все 4 поля** в App Settings:
   - phone: `+7 999 123 45 67`
   - whatsapp: `+79991234567`
   - telegram: `@peri_clinic`
   - max: `@peri_clinic`
3. На главном экране мобильного приложения (HomeScreen) нужно **отсутствие предстоящих записей** (empty state). Если запись есть — кнопка «Записаться» в empty-state не покажется. Решение для теста: использовать клиента без upcoming-записей или временно закомментировать `nextBooking` в HomeScreen.
4. Тапнуть «Записаться» — должна выехать снизу шторка с 4 золотыми кнопками + затемнение фона.
5. Тапнуть на каждую кнопку поочерёдно (с возвратом в приложение):
   - **Позвонить** → открывается dialer iOS/Android с номером
   - **Telegram** → открывается приложение Telegram (или t.me в браузере если не установлен)
   - **WhatsApp** → открывается WhatsApp (или web.whatsapp.com)
   - **MAX** → открывается max.ru в браузере
6. После тапа шит должен закрыться автоматически.
7. Открыть шит снова, тапнуть на затемнение (не на кнопку) — шит закрывается без действия.

- [ ] **Step 6: Верификация — empty case**

1. В админке очистить **все 4 поля** (phone/whatsapp/telegram/max) и сохранить.
2. Перезапустить мобильное приложение (чтобы свежие настройки загрузились).
3. Тапнуть «Записаться» — шит открывается, но вместо кнопок видно текст «Контакты клиники не настроены».
4. Восстановить значения в админке.

- [ ] **Step 7: Верификация — partial case**

1. В админке оставить только `phone`, остальные три поля очистить.
2. Перезапустить приложение.
3. Тапнуть «Записаться» — в шите видна **только** одна кнопка «Позвонить в клинику».
4. Восстановить значения.

- [ ] **Step 8: Commit**

```bash
cd /root/mobile
git add src/screens/HomeScreen.js
git commit -m "feat(home): wire booking contact sheet to 'Записаться' CTA

Replaces navigation.navigate('Bookings') on the empty-state book
button with a bottom-sheet picker (Call/Telegram/WhatsApp/MAX),
sourced from appSettingsStore."
```

---

## Smoke Test (после всех тасков)

Полный sanity-check на устройстве:

1. **Backend up:** `curl http://<host>/api/app-settings | jq` — все поля включая `max` присутствуют.
2. **Admin UI:** `https://<loyalpro>/settings` — поле MAX редактируется и сохраняется.
3. **Mobile golden path:** все 4 канала заполнены → 4 кнопки → каждый deeplink работает.
4. **Mobile empty path:** все каналы пустые → fallback-текст в шите.
5. **iOS + Android:** проверить оба симулятора, не только один.
6. **Web:** `npm run web` — приложение не падает; `Linking.openURL` отдаёт переход в браузерные версии (tg `tg://...` на вебе может ругнуться — это ОК, кейс не критичный, пусть Alert ловит).

## Rollback

Если что-то сломалось:
- **Backend (Tasks 1-3):** `git revert <hash>` соответствующих коммитов в `/root/loyalpro` + перезапуск сервера. Колонка `max` останется в БД, но без неё приложение продолжит работать (всё с `IF NOT EXISTS`).
- **Mobile (Tasks 4-6):** `git revert <hash>` в `/root/mobile`. Стор без `max` поля совместим с backend, в котором `max` есть (просто игнорируется).

Backend и Mobile независимы — можно откатить только одну сторону.
