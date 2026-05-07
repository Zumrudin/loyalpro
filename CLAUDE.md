# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PERI CLINIC mobile app — React Native (Expo SDK 54) client app for clinic patients. Pairs with the backend in `/root/loyalpro` which exposes `/api/mobile/*` endpoints. UI strings are in Russian.

## Commands

```bash
npm start              # Expo dev server (QR code for device, then a/i for emu)
npm run android        # Open Android emulator
npm run ios            # Open iOS simulator (Mac only)
npm run web            # Web preview (uses localStorage instead of SecureStore)

npx expo start --clear # Reset Metro cache when builds get weird
npx expo doctor        # Diagnose dependency / SDK mismatches

eas build --platform android   # Production builds (EAS project: 237ab06c-...)
eas build --platform ios
```

There is no test suite, no linter, and no typecheck script — `package.json` only defines `start`/`android`/`ios`/`web`. Do not invent test commands.

## Environment

Single env var consumed by the app:

```
EXPO_PUBLIC_API_URL=https://89.22.233.73          # production backend
EXPO_PUBLIC_YANDEX_MAPS_KEY=...                   # for MapChooser / RouteToClinic
```

Local dev gotcha: Android emulator must use `http://10.0.2.2:<port>` to reach the host's localhost; iOS simulator can use `http://localhost:<port>`. `app.json` has `usesCleartextTraffic: true` (Android) and `NSAllowsArbitraryLoads: true` (iOS) so HTTP / self-signed HTTPS works in dev.

## Architecture

### Navigation (App.js)

Auth gate is at the root: `token ? <MainNavigator /> : <AuthNavigator />`. The token comes from `useAuthStore` and is restored on launch via `restoreToken()` (Promise.race with a 5s timeout so an unreachable server doesn't block the splash for 15s).

Main app is a **bottom tab navigator with per-tab native stacks** (Home / Bookings / Bonuses / Contacts / Profile). Per-tab stacks exist specifically so the custom blurred tab bar stays visible when navigating into detail screens. Stacks live inline in [App.js](App.js) — there is no `src/navigation/` content yet.

When adding a detail screen, register it inside the relevant per-tab stack, not at the root, or the tab bar will disappear.

### State (Zustand, no persist middleware)

Three stores in [src/store/](src/store/):

- **authStore** — `token`, `user`, login/verifyOtp/restoreToken/logout. Token persistence is hand-rolled around `expo-secure-store` with a `localStorage` fallback for web (see `storage` shim).
- **clientStore** — profile, bookings, bonuses, notifications, prescriptions, recommendations. Each domain has its own `*Loading` flag and a single shared `error`. Note `fetchBookingDetailGroup(ids)` which merges multiple bookings client-side (services flattened, price/bonus summed) — used when the backend returns split records that should display as one.
- **appSettingsStore** — clinic name / logo / phone / socials / mapsUrl. Fetched on app launch from `/api/app-settings` and **cached to SecureStore** under `app_settings_cache` so the app degrades gracefully offline.

Stores are not persisted — only `auth_token` and `app_settings_cache` survive restart.

### API layer (src/api/)

[client.js](src/api/client.js) is the only Axios instance. `baseURL` = `${EXPO_PUBLIC_API_URL}/api`, 15s timeout. A request interceptor injects `Authorization: Bearer <token>` from SecureStore (web → localStorage). On 401 the interceptor deletes the token, but it does **not** redirect — the next `restoreToken()` call drops the user back to the login screen.

Endpoint modules: `auth.js` (`/mobile/auth/*`), `client-data.js` (`/mobile/client/*`), `app-settings.js` (`/app-settings`). Add new endpoints as methods on the existing exported `*API` objects rather than creating new modules.

### Cross-platform storage pattern

Every place that touches secure storage repeats the same pattern: `try { require('expo-secure-store') } catch { localStorage }` with `Platform.OS === 'web'` checks. This is intentional — `expo-secure-store` is unavailable on web. When adding new persisted values, copy the existing `storage` shim from authStore or appSettingsStore rather than introducing a new abstraction.

### UI / theming

`@gluestack-ui/themed` with a custom config in [src/config/gluestack.config.js](src/config/gluestack.config.js). The brand palette is gold `#D4AF37` on cream `#F5F3F0` with brown text `#4A4540`. Many screens use raw React Native + Ionicons + LinearGradient/BlurView rather than Gluestack components — see [GLUESTACK_SETUP.md](GLUESTACK_SETUP.md) for the wrapped components in `src/components/` (`Button`, `Card`, `Input`) when consistency matters.

The tab bar is rendered with `BlurView` + `LinearGradient` and `position: 'absolute'` — screens need bottom padding (~72px) to avoid content sliding under it.

### Babel / Reanimated

[babel.config.js](babel.config.js) uses `react-native-worklets/plugin` (the new package; not `react-native-reanimated/plugin`). Reanimated 4 + React 19 + RN 0.81. If a worklet error appears, verify the plugin is still last in the list and that you're not on a stale Metro cache (`npx expo start --clear`).

## Backend integration notes

The backend lives at `/root/loyalpro` (separate repo). Mobile routes are mounted via:

```js
app.use('/api/mobile/auth',   require('./mobile-auth'));
app.use('/api/mobile/client', require('./mobile-client'));
```

OTP login flow: `POST /mobile/auth/login {phone}` → backend sends SMS via SMS.ru → `POST /mobile/auth/verify-otp {phone, otp}` returns JWT (30-day TTL). In dev the OTP is echoed in the response body / server logs.

When changing an endpoint shape, update both the API method in `src/api/client-data.js` and the store's response unwrapping (most fetchers do `response.thing || response` to tolerate either `{thing: [...]}` or a bare array — keep that pattern).

## Conventions

- All UI copy is Russian. Keep new strings in Russian unless adding i18n.
- Screens are flat in `src/screens/` (no subdirectories). One file per screen, named `<Name>Screen.js`.
- Zustand selectors: subscribe narrowly (`useAuthStore((s) => s.token)`) — the codebase already does this consistently.
- `console.log('[API] …')` prefixes are used for debug-only API logging; keep that prefix when adding similar logs.
