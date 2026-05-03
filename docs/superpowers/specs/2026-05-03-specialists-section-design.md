# Specialists Section — Design Spec

**Date:** 2026-05-03
**Status:** Approved by user, ready for implementation plan

## Goal

Add a new "Специалисты" (Specialists) section to the mobile app. It pulls staff
members from the loyalpro backend (`staff_members` table) — only those flagged
`show_in_app = TRUE` and `is_active = TRUE` — and presents each one with their
photo, name, position and biography in an Instagram-portrait-style layout that
matches the existing "Liquid Glass & Silk" visual language of [HomeScreen](../../../src/screens/HomeScreen.js).

## Non-goals

- No edit/upload of staff data from the mobile app (staff fields remain
  managed via the existing loyalpro web admin: Settings → Сотрудники).
- No "Записаться к специалисту" CTA / booking integration in this iteration.
- No new bottom-tab — the section is reached from the HomeScreen.
- No real-time / push-driven updates — list refreshes on screen focus and via
  pull-to-refresh.
- No bio/photo from YClients API — both fields are manually maintained in
  loyalpro. (`avatar_url` from YClients is used only as a photo fallback.)

## Architecture

```
┌─────────── HomeScreen (mobile) ────────────────────────┐
│  [Card "Специалисты"] ──tap──▶ SpecialistsScreen      │
└────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────── SpecialistsScreen (list) ──────────────────────┐
│  Hero card (display_order = 1) — full-width            │
│  ────────────────────────────────────                  │
│  [card] [card]   ◀ 2-per-row grid for the rest         │
│  [card] [card]                                         │
└────────────────────────────────────────────────────────┘
                tap any card
                       ▼
┌──── SpecialistDetailScreen (minimal detail) ───────────┐
│  ←  back                                               │
│  Large 4:5 photo                                       │
│  Name · Specialization                                 │
│  Biography                                             │
└────────────────────────────────────────────────────────┘
                       ▲
                       │ GET /api/mobile/client/specialists
                       │
┌─────── Backend (loyalpro) ──────┐
│  routes/mobile-client.js        │
│  → SELECT FROM staff_members    │
│    WHERE salon_id = client.salon│
│      AND show_in_app = TRUE     │
│      AND is_active  = TRUE      │
│    ORDER BY display_order, name │
└─────────────────────────────────┘
```

### Components changed / added

| Layer        | File                                       | Change                                     |
| ------------ | ------------------------------------------ | ------------------------------------------ |
| Backend      | `loyalpro/backend/routes/mobile-client.js` | + `GET /specialists` (≈30 LoC)             |
| Mobile API   | `mobile/src/api/client-data.js`            | + `getSpecialists()` method                |
| Mobile store | `mobile/src/store/clientStore.js`          | + `specialists`, `specialistsLoading`, `fetchSpecialists()` |
| Screens      | `mobile/src/screens/SpecialistsScreen.js`  | NEW                                        |
| Screens      | `mobile/src/screens/SpecialistDetailScreen.js` | NEW                                    |
| Navigation   | `mobile/App.js`                            | Register both screens in `HomeStackNav`    |
| HomeScreen   | `mobile/src/screens/HomeScreen.js`         | Add entry card next to "Прайс-лист" / "Назначения" |

No new dependencies, no DB migration (the `staff_members` table already has
`bio`, `custom_photo_url`, `avatar_url`, `show_in_app`, `display_order`,
`is_active`).

## API contract

### `GET /api/mobile/client/specialists`

- **Auth:** `mobileAuth` middleware (same as other `/mobile/client/*` routes).
- **Salon scope:** derived from `clients.salon_id` for `req.client.clientId`.

**Response (200):**

```json
{
  "success": true,
  "specialists": [
    {
      "id": 42,
      "name": "Иванова Анна Петровна",
      "specialization": "Генеральный директор, врач-косметолог",
      "bio": "Окончила РНИМУ им. Пирогова в 2010 году…",
      "photoUrl": "https://89.22.233.73/uploads/staff_42_1714…jpg",
      "displayOrder": 1
    },
    {
      "id": 51,
      "name": "Петрова Мария",
      "specialization": "Косметолог-эстетист",
      "bio": null,
      "photoUrl": "https://yclients-cdn.com/avatars/abc.jpg",
      "displayOrder": 2
    }
  ]
}
```

**`photoUrl` resolution (server-side):**

1. If `custom_photo_url` is non-empty → prefix with the request-derived base
   URL `\`${req.protocol}://${req.get('host')}\`` (the photo is stored as a
   relative path like `/uploads/staff_42_xxx.jpg`, served by `express.static`
   on the same origin — see [server.js:69](../../../../loyalpro/backend/server.js)).
2. Else if `avatar_url` (from YClients) is non-empty → return as-is
   (already absolute).
3. Else → `null`. Mobile renders an initials placeholder.

No new env var is introduced — the existing public host (e.g. `89.22.233.73`)
is the same one the mobile client used to call this endpoint, so
`req.get('host')` is correct.

**SQL:**

```sql
SELECT id, name, specialization, bio,
       custom_photo_url, avatar_url, display_order
FROM staff_members
WHERE salon_id = $1
  AND show_in_app = TRUE
  AND is_active   = TRUE
ORDER BY display_order ASC NULLS LAST, name ASC
```

**Errors:** standard `500 { error: message }` (mirroring siblings). No 404 —
empty list when no specialists are visible.

### Mobile store / fetch behavior

- `clientStore.specialists` is a plain array, no SecureStore persist (matches
  `bookings` / `bonuses` pattern, not `appSettingsStore`).
- `fetchSpecialists()` toggles `specialistsLoading`, sets shared `error` on
  failure, and unwraps `response.specialists || response` to tolerate either
  shape (existing convention in the store).
- Triggered on `SpecialistsScreen` focus (via `useFocusEffect`) and pull-to-refresh.
- Cleared in `logout()` / `clearClientData()` alongside other domain arrays.

## UI / Screens

All visual tokens come from [HomeScreen](../../../src/screens/HomeScreen.js)
(`T.pearl`, `T.glass`, `T.champagne`, `T.stone`, etc.). Photo aspect ratio is
**4:5 in all three places** (entry card preview is unaffected — it is icon-only).

### Entry card on HomeScreen

A new tile sits in the existing quick-actions block next to "Прайс-лист" /
"Назначения":

```
┌────────────────────────┐
│  ✨ icon (people)      │
│                        │
│  Специалисты           │
│  Команда клиники       │
└────────────────────────┘
```

- Icon: `people-outline` (Ionicons), color `T.champagne`.
- Tap: `navigation.navigate('Specialists')`.
- Reuses the same `PressCard`/`Reveal` interactions as adjacent tiles.

### `SpecialistsScreen` — list

```
┌─ status bar (T.pearl) ───────────────────┐
│  ←   Специалисты                          │
│      Команда клиники                      │
├───────────────────────────────────────────┤
│  ┌─────────────────────────────────────┐  │
│  │                                     │  │
│  │       HERO PHOTO 4:5                │  │ ← display_order = 1
│  │       (full-width minus 32 px)      │  │   slightly larger
│  │                                     │  │
│  ├─────────────────────────────────────┤  │
│  │  Иванова Анна Петровна              │  │
│  │  Генеральный директор · косметолог  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌──────────────┐  ┌──────────────┐       │
│  │  photo 4:5   │  │  photo 4:5   │       │ ← 2-per-row grid
│  │              │  │              │       │   gap 12 px
│  ├──────────────┤  ├──────────────┤       │
│  │  Name        │  │  Name        │       │
│  │  Position    │  │  Position    │       │
│  └──────────────┘  └──────────────┘       │
│  ┌──────────────┐  ┌──────────────┐       │
│  │     ...      │  │     ...      │       │
└───────────────────────────────────────────┘
```

**Behavior:**

- `ScrollView` with `RefreshControl` (pull-to-refresh → `fetchSpecialists()`).
- Reveal animation (reuse helper from HomeScreen) with staggered delays
  (0 / 120 / 240 ms for hero / first row / second row).
- Card tap: `Haptics.selectionAsync()` + `navigation.navigate('SpecialistDetail', { id })`.
- Bottom padding 100 px (clears the blurred tab bar).

**States:**

- **Loading:** `Skeleton` from HomeScreen — 1 hero + 2×2 grid.
- **Empty** (no `show_in_app` rows): centered `people-outline` icon
  (`T.stoneFaint`) + text "Скоро здесь появится команда клиники".
- **Error:** "Не удалось загрузить" + "Повторить" button.
- **Per-card with no photo:** `T.glowA → T.glowB` gradient background +
  centered initials (Playfair Display, `T.champDark`).

### `SpecialistDetailScreen` — detail

```
┌───────────────────────────────────────────┐
│  ←                                        │  ← absolute back button over photo
├───────────────────────────────────────────┤
│                                           │
│         PHOTO 4:5 full-width              │
│         (24 px rounded bottom)            │
│                                           │
├───────────────────────────────────────────┤
│  Иванова Анна Петровна                    │  ← Playfair Display 26
│  Генеральный директор · косметолог        │  ← Inter 14, T.stoneMid
│  ─── champagne divider ───                │
│                                           │
│  Lorem ipsum dolor sit amet, consectetur  │  ← biography
│  adipiscing elit. Sed do eiusmod tempor   │     Inter 15, line-height 24
│  incididunt ut labore et dolore magna…    │
│                                           │
│  (if bio empty: "Подробная информация     │
│   скоро появится" — italic, T.stoneFaint) │
└───────────────────────────────────────────┘
```

**Behavior:**

- Data is read from `clientStore.specialists.find(s => s.id === route.params.id)`
  (no extra request — list always loads first).
- Defensive fallback: if the entry isn't in the store, call
  `fetchSpecialists()` once and re-look-up.
- ScrollView with the photo at the top; back button is `position: 'absolute'`
  with a small `BlurView` chip behind it for legibility against any photo.
- Photo extends under the status bar; `StatusBar` set to `light-content` while
  this screen is focused, restored on blur.
- Bottom padding 100 px (tab bar).

## Edge cases (consolidated)

- **No photo** (neither `custom_photo_url` nor `avatar_url`): initials
  placeholder (described above).
- **No bio:** card preview shows only name + position; detail screen shows
  the italic placeholder line.
- **No specialization:** the position line is omitted entirely; name remains.
- **Single visible specialist:** show only the hero, no grid.
- **Odd count of "rest":** last grid row contains one card in the left
  column — no full-width stretch.
- **Slow / failed network:** shared `clientStore.error` is reused; the screen
  shows a retry button.

## Implementation order (rough)

1. **Backend** — add `GET /mobile/client/specialists` to
   `loyalpro/backend/routes/mobile-client.js`; verify with `curl`.
2. **Mobile API layer** — add `getSpecialists()` to
   `mobile/src/api/client-data.js`.
3. **Mobile store** — add fields + action to `mobile/src/store/clientStore.js`;
   wire into `clearClientData()` / `logout()`.
4. **`SpecialistsScreen.js`** — list with hero + grid + loading / empty / error
   states.
5. **`SpecialistDetailScreen.js`** — detail screen.
6. **Navigation** — register both screens in `HomeStackNav` ([App.js](../../../App.js)).
7. **Entry card on HomeScreen** — add tile next to "Прайс-лист" /
   "Назначения".

## Russian copy (final)

| Where                       | Text                                       |
| --------------------------- | ------------------------------------------ |
| HomeScreen entry card title | Специалисты                                |
| HomeScreen entry card sub   | Команда клиники                            |
| SpecialistsScreen title     | Специалисты                                |
| SpecialistsScreen subtitle  | Команда клиники                            |
| Empty state                 | Скоро здесь появится команда клиники       |
| Bio placeholder (detail)    | Подробная информация скоро появится        |
| Error                       | Не удалось загрузить                       |
| Retry button                | Повторить                                  |
