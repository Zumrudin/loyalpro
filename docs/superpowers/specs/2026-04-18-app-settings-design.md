# App Settings — Design Spec

**Date:** 2026-04-18  
**Status:** Approved

## Overview

Clinic name, logo, and contact info are stored in the backend database and loaded by the mobile app at startup. Designed for future multi-tenant use (one row per clinic).

---

## Backend (loyalpro)

### Database Table: `app_settings`

```sql
CREATE TABLE app_settings (
  id           SERIAL PRIMARY KEY,
  clinic_name  TEXT NOT NULL,
  logo_url     TEXT,
  phone        TEXT,
  whatsapp     TEXT,
  telegram     TEXT,
  instagram    TEXT,
  maps_url     TEXT,
  email        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

Single row for now. Multi-tenant: add `company_id FK` column in future migration.

### New Files

- `backend/routes/app-settings.js` — route handlers
- `backend/middleware/upload.js` — multer config for logo upload (if not already present)

### Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/app-settings` | Public | Returns all settings as JSON |
| PUT | `/api/app-settings` | Admin only | Update text fields |
| POST | `/api/app-settings/logo` | Admin only | Upload logo file, returns `{ logoUrl }` |

### GET /api/app-settings — Response Shape

```json
{
  "clinicName": "Название клиники",
  "logoUrl": "https://domain.com/uploads/logo.png",
  "phone": "+7 999 000 00 00",
  "whatsapp": "+7 999 000 00 00",
  "telegram": "@clinic",
  "instagram": "@clinic",
  "mapsUrl": "https://yandex.ru/maps/...",
  "email": "info@clinic.ru"
}
```

Returns empty object `{}` if no settings row exists yet (app handles gracefully).

### Logo Upload

- Saved to `backend/uploads/` directory
- Served as static files via Express (`/uploads/`)
- Multer limits: max 5MB, accept `image/*` only
- Old logo file deleted from disk when replaced

### Migration

New file: `backend/migrations/NNNN_create_app_settings.sql`

---

## Mobile App

### New Files

- `src/store/appSettingsStore.js` — Zustand store with AsyncStorage persistence

### Store Shape

```js
{
  clinicName: string,
  logoUrl: string | null,
  phone: string | null,
  whatsapp: string | null,
  telegram: string | null,
  instagram: string | null,
  mapsUrl: string | null,
  email: string | null,
  loaded: boolean,
  fetchAppSettings: () => Promise<void>
}
```

### Startup Flow

1. `App.js` calls `fetchAppSettings()` on mount
2. Fetches `GET /api/app-settings`
3. On success: updates store + writes to AsyncStorage cache
4. On failure: loads last cached value from AsyncStorage (graceful degradation)
5. `loaded` flag prevents rendering before settings are available

### Usage in Screens

```js
const { clinicName, logoUrl, phone } = useAppSettings();
```

Used in:
- `HomeScreen.js` — clinic name in header, logo
- Any screen showing contact info (phone, social links)

### Existing Files Modified

- `App.js` — call `fetchAppSettings()` on mount
- `HomeScreen.js` — replace hardcoded name/logo with store values
- `src/api/client-data.js` — add `fetchAppSettings()` API call

---

## Web Admin (loyalpro frontend)

A settings page in the admin panel with:
- Text fields for all contact fields
- Logo upload input (preview current logo)
- Save button (calls `PUT /api/app-settings`)
- Separate upload button for logo (calls `POST /api/app-settings/logo`)

Location: new page at `/settings/app` in loyalpro web frontend.

---

## Out of Scope

- Color scheme / theming (future phase)
- Per-branch settings (future multi-tenant migration)
- Push notification settings
