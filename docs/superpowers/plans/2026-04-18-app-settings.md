# App Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store clinic name, logo, and contact info in the backend DB and load them in the mobile app at startup, replacing hardcoded values.

**Architecture:** A new `app_settings` table (single row, multi-tenant ready) is exposed via a public `GET /api/app-settings` endpoint. The mobile app fetches settings on startup, stores them in a Zustand store with SecureStore-based cache for offline fallback. Admin can update settings via `PUT /api/app-settings` and upload a logo via `POST /api/app-settings/logo`.

**Tech Stack:** Node.js/Express, pg-promise, multer (already installed), React Native, Zustand, expo-secure-store

---

## File Map

**Backend (loyalpro):**
- Create: `backend/routes/app-settings.js` — GET / PUT / POST logo routes
- Modify: `backend/routes/index.js` — mount the new router
- Modify: `backend/migrations.js` — add `app_settings` table creation
- Modify: `backend/server.js` — serve `/uploads/` as static (already serves `frontend/uploads`, verify coverage)

**Mobile:**
- Create: `src/store/appSettingsStore.js` — Zustand store, fetch + SecureStore cache
- Create: `src/api/app-settings.js` — API call for `GET /api/app-settings`
- Modify: `App.js` — call `fetchAppSettings()` on startup
- Modify: `src/screens/HomeScreen.js` — replace hardcoded clinic name with store value

---

## Task 1: DB Migration — create `app_settings` table

**Files:**
- Modify: `backend/migrations.js:160-170`

- [ ] **Step 1: Add migration block at the end of `runMigrations()`**

Open `backend/migrations.js`. Before the closing `}` of `runMigrations`, add:

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
```

- [ ] **Step 2: Restart the backend to run migrations**

```bash
cd /root/loyalpro && pm2 restart backend 2>/dev/null || node backend/server.js &
```

- [ ] **Step 3: Verify table was created**

```bash
cd /root/loyalpro && node -e "
const { db } = require('./backend/db');
db.any('SELECT column_name FROM information_schema.columns WHERE table_name=\$1', ['app_settings'])
  .then(r => { console.log(r.map(c=>c.column_name)); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected output: `[ 'id', 'clinic_name', 'logo_url', 'phone', 'whatsapp', 'telegram', 'instagram', 'maps_url', 'email', 'created_at', 'updated_at' ]`

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add backend/migrations.js
git commit -m "feat: add app_settings table migration"
```

---

## Task 2: Backend route — GET / PUT / POST logo

**Files:**
- Create: `backend/routes/app-settings.js`

- [ ] **Step 1: Create `backend/routes/app-settings.js`**

```js
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `app_logo${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
});

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
      instagram:  row.instagram,
      mapsUrl:    row.maps_url,
      email:      row.email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — update text fields
router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clinicName, phone, whatsapp, telegram, instagram, mapsUrl, email } = req.body;
    const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
    if (existing) {
      await db.query(
        `UPDATE app_settings SET clinic_name=$1, phone=$2, whatsapp=$3, telegram=$4,
         instagram=$5, maps_url=$6, email=$7, updated_at=NOW() WHERE id=$8`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         instagram || null, mapsUrl || null, email || null, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO app_settings (clinic_name, phone, whatsapp, telegram, instagram, maps_url, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         instagram || null, mapsUrl || null, email || null]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — upload logo
router.post('/logo', auth, requireRole('owner', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const logoUrl = `/uploads/${req.file.filename}`;
    try {
      const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
      if (existing) {
        await db.query('UPDATE app_settings SET logo_url=$1, updated_at=NOW() WHERE id=$2', [logoUrl, existing.id]);
      } else {
        await db.query('INSERT INTO app_settings (clinic_name, logo_url) VALUES ($1, $2)', ['', logoUrl]);
      }
      res.json({ ok: true, logoUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;
```

- [ ] **Step 2: Mount route in `backend/routes/index.js`**

After the line `app.use('/api/template-settings', require('./home-care-template-settings'));`, add:

```js
  app.use('/api/app-settings',      require('./app-settings'));
```

Also add `'/api/app-settings'` to the public routes list in `backend/config.js`:

In `config.js`, change:
```js
API_PUBLIC: ['/api/auth/login', '/api/auth/register'],
```
to:
```js
API_PUBLIC: ['/api/auth/login', '/api/auth/register', '/api/app-settings'],
```

- [ ] **Step 3: Restart backend and test GET**

```bash
cd /root/loyalpro && pm2 restart backend 2>/dev/null || pkill -f "node backend" && node backend/server.js &
sleep 2
curl -s http://localhost:3001/api/app-settings
```

Expected: `{}` (empty object, no row yet)

- [ ] **Step 4: Test PUT (requires admin token — get one first)**

```bash
# Get admin token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your_password"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

# Create settings
curl -s -X PUT http://localhost:3001/api/app-settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"clinicName":"Aura Aesthetics","phone":"+7 999 000 00 00","telegram":"@aura_clinic"}'
```

Expected: `{"ok":true}`

- [ ] **Step 5: Verify GET returns data**

```bash
curl -s http://localhost:3001/api/app-settings
```

Expected:
```json
{"clinicName":"Aura Aesthetics","logoUrl":null,"phone":"+7 999 000 00 00","whatsapp":null,"telegram":"@aura_clinic","instagram":null,"mapsUrl":null,"email":null}
```

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro
git add backend/routes/app-settings.js backend/routes/index.js backend/config.js
git commit -m "feat: add app-settings API routes (GET public, PUT/POST logo admin)"
```

---

## Task 3: Mobile — API function

**Files:**
- Create: `src/api/app-settings.js`

- [ ] **Step 1: Create `src/api/app-settings.js`**

```js
import apiClient from './client';

export const appSettingsAPI = {
  getAppSettings: async () => {
    const res = await apiClient.get('/app-settings');
    return res.data;
  },
};
```

Note: `apiClient` base URL is `${API_URL}/api`, so `/app-settings` maps to `/api/app-settings`. The endpoint is public so no auth header is needed (axios interceptor adds it if token exists — harmless).

- [ ] **Step 2: Commit**

```bash
cd /root/mobile
git add src/api/app-settings.js
git commit -m "feat: add appSettingsAPI.getAppSettings()"
```

---

## Task 4: Mobile — Zustand store with SecureStore cache

**Files:**
- Create: `src/store/appSettingsStore.js`

- [ ] **Step 1: Create `src/store/appSettingsStore.js`**

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

- [ ] **Step 2: Commit**

```bash
cd /root/mobile
git add src/store/appSettingsStore.js
git commit -m "feat: add appSettingsStore with SecureStore offline cache"
```

---

## Task 5: Mobile — call fetchAppSettings in App.js

**Files:**
- Modify: `App.js`

- [ ] **Step 1: Import the store in App.js**

At the top of `App.js`, after the existing store imports:
```js
import { useAuthStore } from './src/store/authStore';
import { useClientStore } from './src/store/clientStore';
```
Add:
```js
import { useAppSettingsStore } from './src/store/appSettingsStore';
```

- [ ] **Step 2: Wire up fetchAppSettings in the bootstrap effect**

Find the existing `useEffect` in `App.js` that calls `restoreToken()`. It looks like:

```js
const token = useAuthStore((state) => state.token);
const restoreToken = useAuthStore((state) => state.restoreToken);
```

After those two lines, add:
```js
const fetchAppSettings = useAppSettingsStore((state) => state.fetchAppSettings);
```

Then inside `bootstrapAsync`, after `await restoreToken();` add:
```js
        await fetchAppSettings();
```

The effect should look like:
```js
  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        await restoreToken();
        await fetchAppSettings();
      } catch (e) {
        console.error('Error bootstrapping app:', e);
      } finally {
        setIsLoading(false);
      }
    };
    bootstrapAsync();
  }, []);
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add App.js
git commit -m "feat: fetch app settings on startup in App.js"
```

---

## Task 6: Mobile — use settings in HomeScreen

**Files:**
- Modify: `src/screens/HomeScreen.js`

- [ ] **Step 1: Find hardcoded clinic name in HomeScreen**

The file has a comment at line 3: `* Aura Aesthetics Premium Clinic`

Search for where the clinic name is rendered:

```bash
grep -n "Aura\|clinicName\|clinic_name\|Clinic App" /root/mobile/src/screens/HomeScreen.js
```

- [ ] **Step 2: Add store import to HomeScreen.js**

Near the top of the file, after existing imports, add:
```js
import { useAppSettingsStore } from '../store/appSettingsStore';
```

- [ ] **Step 3: Use clinicName from store**

Inside the component function, add:
```js
  const clinicName = useAppSettingsStore((state) => state.clinicName);
```

Replace any hardcoded clinic name string (e.g. `'Aura Aesthetics Premium Clinic'` or `'Clinic App'`) with `clinicName`.

If there's a logo `<Image>` already, add:
```js
  const logoUrl = useAppSettingsStore((state) => state.logoUrl);
```
And use `logoUrl` as the image source URI (keep a local fallback image if `logoUrl` is null).

- [ ] **Step 4: Commit**

```bash
cd /root/mobile
git add src/screens/HomeScreen.js
git commit -m "feat: display clinic name and logo from appSettingsStore in HomeScreen"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `app_settings` table with all fields — Task 1
- ✅ `GET /api/app-settings` public — Task 2
- ✅ `PUT /api/app-settings` admin-only — Task 2
- ✅ `POST /api/app-settings/logo` admin-only with multer — Task 2
- ✅ Logo saved to `/uploads/`, served as static (existing `express.static` at `frontend/` covers `frontend/uploads/`) — Task 2
- ✅ Mobile API function — Task 3
- ✅ Zustand store with offline fallback — Task 4
- ✅ fetchAppSettings called on startup — Task 5
- ✅ HomeScreen uses store values — Task 6
- ✅ `API_PUBLIC` updated so mobile can call GET without auth — Task 2

**Type consistency:** `clinicName`, `logoUrl`, `phone`, `whatsapp`, `telegram`, `instagram`, `mapsUrl`, `email` used consistently across Tasks 2–6.

**Placeholders:** None.
