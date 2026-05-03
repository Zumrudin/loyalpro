# Specialists Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Специалисты" section to the mobile app: HomeScreen entry card → list (hero + 2-per-row grid) → minimal detail screen with 4:5 photos, backed by a new `GET /api/mobile/client/specialists` endpoint that reads from `staff_members` (`show_in_app = TRUE` and `is_active = TRUE`).

**Architecture:** New backend endpoint in loyalpro returns the salon's visible staff with resolved photo URLs. Mobile gets a new API method, a new Zustand store slice, two new screens (list + detail), and one new entry card on HomeScreen. No DB migration — `staff_members` already has `bio`, `custom_photo_url`, `avatar_url`, `show_in_app`, `display_order`, `is_active`.

**Tech Stack:** Backend — Node.js + Express + pg-promise (loyalpro). Mobile — React Native + Expo SDK 54, Zustand, axios, expo-blur, expo-linear-gradient, react-native-reanimated, expo-haptics, Ionicons.

**Spec:** [docs/superpowers/specs/2026-05-03-specialists-section-design.md](../specs/2026-05-03-specialists-section-design.md)

**Important:** Per [CLAUDE.md](../../../CLAUDE.md), this codebase has NO test suite, NO linter, NO typecheck. Verification is manual: `curl` for the backend endpoint and Expo dev server (`npm start`) for UI checks.

---

## Task 1: Backend — add `GET /api/mobile/client/specialists`

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js` (insert before `module.exports = router;` at line 472)

- [ ] **Step 1: Add the endpoint**

Open `/root/loyalpro/backend/routes/mobile-client.js`. Find the line `module.exports = router;` (currently line 472) and insert the following block immediately before it:

```js
// Get specialists (staff_members with show_in_app=TRUE and is_active=TRUE)
router.get('/specialists', mobileAuth, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const rows = await db.any(
      `SELECT id, name, specialization, bio,
              custom_photo_url, avatar_url, display_order
       FROM staff_members
       WHERE salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND show_in_app = TRUE
         AND is_active   = TRUE
       ORDER BY display_order ASC NULLS LAST, name ASC`,
      [req.client.clientId]
    );

    const specialists = rows.map((r) => {
      let photoUrl = null;
      if (r.custom_photo_url && r.custom_photo_url.trim()) {
        photoUrl = r.custom_photo_url.startsWith('http')
          ? r.custom_photo_url
          : `${baseUrl}${r.custom_photo_url}`;
      } else if (r.avatar_url && r.avatar_url.trim()) {
        photoUrl = r.avatar_url;
      }
      return {
        id: r.id,
        name: r.name,
        specialization: r.specialization,
        bio: r.bio,
        photoUrl,
        displayOrder: r.display_order,
      };
    });

    res.json({ success: true, specialists });

  } catch (e) {
    logger.error(`Get specialists error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

```

- [ ] **Step 2: Restart the loyalpro backend so the new route is loaded**

Run from `/root/loyalpro`:
```bash
pm2 restart loyalpro 2>/dev/null || (cd backend && pkill -f "node server.js"; nohup node server.js > /tmp/loyalpro.log 2>&1 &)
sleep 2
```

If neither pm2 nor the manual fallback applies in this environment, restart however the user normally restarts the backend (ask if unclear — do NOT skip).

- [ ] **Step 3: Smoke-test the endpoint with `curl`**

First obtain a valid mobile JWT. The simplest path is to grab one from a recent login in `server.log`:
```bash
grep -oE 'eyJ[A-Za-z0-9._-]+' /root/loyalpro/server.log 2>/dev/null | tail -1
```

If no token is in the log, send an OTP and verify it for an existing test client (use the dev OTP from logs):
```bash
TEST_PHONE="<replace with a real test client phone in DB>"
curl -s -X POST http://localhost:3000/api/mobile/auth/login -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\"}"
# Then fetch the OTP from logs and verify:
curl -s -X POST http://localhost:3000/api/mobile/auth/verify-otp -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\",\"otp\":\"<otp>\"}"
```

Then call the new endpoint:
```bash
TOKEN="<paste JWT here>"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/mobile/client/specialists | head -c 2000
```

Expected: `{"success":true,"specialists":[ ... ]}` with one entry per `staff_members` row that has `show_in_app=TRUE AND is_active=TRUE` for that client's salon. Each entry must have `id`, `name`, `specialization`, `bio`, `photoUrl`, `displayOrder`. `photoUrl` should be either an absolute URL beginning with `http://localhost:3000/uploads/...` (when `custom_photo_url` is set), the YClients absolute URL (when only `avatar_url`), or `null`.

If the array is empty: pick a staff member from the loyalpro web admin (Settings → Сотрудники), enable "Показывать в приложении" (this writes `show_in_app=TRUE`), then re-run the curl.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js && git commit -m "$(cat <<'EOF'
feat(mobile-api): add GET /mobile/client/specialists

Returns staff_members for the client's salon where show_in_app=TRUE
and is_active=TRUE, ordered by display_order. Resolves photoUrl from
custom_photo_url (absolute via request host) with avatar_url fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mobile API — add `getSpecialists()`

**Files:**
- Modify: `/root/mobile/src/api/client-data.js` (insert new method on `clientDataAPI` object)

- [ ] **Step 1: Add the method**

Open `/root/mobile/src/api/client-data.js`. Find the `getPriceList` method (currently lines 95-98) and insert the new method right after it, before the closing `};`:

```js
  // Get specialists (staff with show_in_app enabled)
  getSpecialists: async () => {
    const res = await apiClient.get('/mobile/client/specialists');
    return res.data;
  },
```

The final shape should be:
```js
  getPriceList: async () => {
    const res = await apiClient.get('/mobile/client/price-list');
    return res.data;
  },

  // Get specialists (staff with show_in_app enabled)
  getSpecialists: async () => {
    const res = await apiClient.get('/mobile/client/specialists');
    return res.data;
  },
};
```

- [ ] **Step 2: Verify it loads cleanly**

The file is plain JS with no build step. Quick syntax check:
```bash
cd /root/mobile && node -e "const m = require('./src/api/client-data.js'); console.log(Object.keys(m.clientDataAPI).filter(k => k.includes('pecial')));"
```

Expected output: `[ 'getSpecialists' ]`

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/api/client-data.js && git commit -m "$(cat <<'EOF'
feat(api): add getSpecialists() for /mobile/client/specialists

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Mobile store — `specialists` state & `fetchSpecialists` action

**Files:**
- Modify: `/root/mobile/src/store/clientStore.js`

- [ ] **Step 1: Add the state fields**

Open `/root/mobile/src/store/clientStore.js`. Find the `Prescriptions` block (currently lines 30-34) and immediately after it, before the `// Errors` comment (line 36), insert:

```js
  // Specialists
  specialists: [],
  specialistsLoading: false,

```

- [ ] **Step 2: Add the fetchSpecialists action**

In the same file, find the `fetchPrescriptionDetail` action (currently lines 220-230). Insert the new action immediately after it, before the `clearError` action:

```js
  fetchSpecialists: async () => {
    set({ specialistsLoading: true });
    try {
      const response = await clientDataAPI.getSpecialists();
      console.log('[API] specialists →', (response.specialists || []).length);
      set({ specialists: response.specialists || response || [], error: null });
    } catch (error) {
      console.error('[API] specialists error:', error.message);
      set({ error: error.message });
    } finally {
      set({ specialistsLoading: false });
    }
  },

```

- [ ] **Step 3: Verify the store loads**

```bash
cd /root/mobile && node -e "
const { useClientStore } = require('./src/store/clientStore.js');
const s = useClientStore.getState();
console.log({
  hasSpecialistsArray: Array.isArray(s.specialists),
  specialistsLoading: s.specialistsLoading,
  fetchSpecialistsType: typeof s.fetchSpecialists,
});
"
```

Expected: `{ hasSpecialistsArray: true, specialistsLoading: false, fetchSpecialistsType: 'function' }`

If `node` cannot resolve `zustand` (because the file uses ESM-style imports that Node won't run as CJS), skip this command and instead grep to confirm both insertions are present:
```bash
grep -n "specialists\|fetchSpecialists" /root/mobile/src/store/clientStore.js
```
Expected: at least 4 matches (state field, loading flag, action name, and one `set({ specialists: ... })`).

- [ ] **Step 4: Commit**

```bash
cd /root/mobile && git add src/store/clientStore.js && git commit -m "$(cat <<'EOF'
feat(store): add specialists state and fetchSpecialists action

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create `SpecialistsScreen.js` — list with hero + 2-per-row grid

**Files:**
- Create: `/root/mobile/src/screens/SpecialistsScreen.js`

This screen reuses the visual language of [HomeScreen](../../../src/screens/HomeScreen.js) (tokens, glass cards, blur, gradients). The helpers (`Skeleton`, `Reveal`, `PressCard`) from HomeScreen are local to that file, so we duplicate the small ones we need here rather than refactoring HomeScreen — that's intentional and matches the "screens are flat, no shared abstractions yet" project convention.

- [ ] **Step 1: Create the file with imports, tokens, helpers**

Create `/root/mobile/src/screens/SpecialistsScreen.js` with the following content:

```jsx
import React, { useEffect, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  ScrollView,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSpring,
  withRepeat,
  withSequence,
  Easing,
  interpolate,
  cancelAnimation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';

const { width } = Dimensions.get('window');

// ─── Design tokens (match HomeScreen) ──────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.72)',
  glassBorder:'rgba(255,255,255,0.85)',
  champagne:  '#D4AF37',
  champLight: '#F0D882',
  champDark:  '#A8881C',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  stoneMuted: 'rgba(74,69,64,0.60)',
  shadow:     'rgba(100,90,70,0.12)',
  glowA:      'rgba(240,216,130,0.22)',
  glowB:      'rgba(220,210,240,0.18)',
};

// ─── Skeleton shimmer ──────────────────────────────────────────────────────
function Skeleton({ width: w, height: h, radius = 12, style }) {
  const shimmer = useSharedValue(0);
  useEffect(() => {
    shimmer.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => cancelAnimation(shimmer);
  }, []);
  const animStyle = useAnimatedStyle(() => ({
    opacity: interpolate(shimmer.value, [0, 1], [0.45, 0.85]),
  }));
  return (
    <Animated.View
      style={[{ width: w, height: h, borderRadius: radius, overflow: 'hidden' }, style, animStyle]}
    >
      <LinearGradient
        colors={[T.silk, '#E8E2DA', T.silk]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ flex: 1 }}
      />
    </Animated.View>
  );
}

// ─── Reveal entry animation ────────────────────────────────────────────────
function Reveal({ delay = 0, children }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }));
    ty.value = withDelay(delay, withSpring(0, { damping: 20, stiffness: 100 }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

// ─── Press scale + haptic ──────────────────────────────────────────────────
function PressCard({ style, onPress, children }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const handleIn = () => {
    scale.value = withSpring(0.975, { damping: 18, stiffness: 200 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  const handleOut = () => {
    scale.value = withSpring(1, { damping: 18, stiffness: 200 });
  };
  return (
    <Animated.View style={[animStyle, style]}>
      {children}
      <TouchableOpacity
        onPressIn={handleIn}
        onPressOut={handleOut}
        onPress={onPress}
        activeOpacity={1}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

// ─── Initials placeholder when no photo ────────────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function SpecialistPhoto({ photoUrl, name, style, fontSize = 36 }) {
  if (photoUrl) {
    return <Image source={{ uri: photoUrl }} style={style} resizeMode="cover" />;
  }
  return (
    <View style={[style, { backgroundColor: T.glowA, justifyContent: 'center', alignItems: 'center' }]}>
      <LinearGradient
        colors={[T.glowA, T.glowB]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Text style={{ fontSize, color: T.champDark, fontFamily: 'serif' }}>
        {getInitials(name)}
      </Text>
    </View>
  );
}

// Placeholder default export (will be replaced in Step 2 below).
export default function SpecialistsScreen({ navigation }) {
  return null;
}
```

- [ ] **Step 2: Replace the placeholder default export with the real component**

In the same file, replace the placeholder export at the bottom with:

```jsx
export default function SpecialistsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const specialists = useClientStore((s) => s.specialists);
  const loading = useClientStore((s) => s.specialistsLoading);
  const error = useClientStore((s) => s.error);
  const fetchSpecialists = useClientStore((s) => s.fetchSpecialists);

  useFocusEffect(
    useCallback(() => {
      fetchSpecialists();
    }, [])
  );

  const hero = specialists[0] || null;
  const rest = specialists.slice(1);

  const goToDetail = (id) => {
    Haptics.selectionAsync();
    navigation.navigate('SpecialistDetail', { id });
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={22} color={T.stone} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Специалисты</Text>
          <Text style={s.headerSub}>Команда клиники</Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={loading && specialists.length > 0}
            onRefresh={fetchSpecialists}
            tintColor={T.champagne}
          />
        }
      >
        {/* Loading skeleton (only on first load — no items yet) */}
        {loading && specialists.length === 0 && (
          <>
            <Skeleton width={width - 40} height={(width - 40) * 1.25} radius={24} style={{ marginBottom: 24 }} />
            <View style={s.gridRow}>
              <Skeleton width={(width - 52) / 2} height={((width - 52) / 2) * 1.25 + 60} radius={20} />
              <Skeleton width={(width - 52) / 2} height={((width - 52) / 2) * 1.25 + 60} radius={20} />
            </View>
          </>
        )}

        {/* Error state */}
        {!loading && error && specialists.length === 0 && (
          <View style={s.emptyWrap}>
            <Ionicons name="cloud-offline-outline" size={48} color={T.stoneFaint} />
            <Text style={s.emptyTitle}>Не удалось загрузить</Text>
            <TouchableOpacity style={s.retryBtn} onPress={fetchSpecialists} activeOpacity={0.85}>
              <LinearGradient
                colors={[T.champagne, T.champDark]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
              <Text style={s.retryText}>Повторить</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Empty state (no error, just nothing to show) */}
        {!loading && !error && specialists.length === 0 && (
          <View style={s.emptyWrap}>
            <Ionicons name="people-outline" size={48} color={T.stoneFaint} />
            <Text style={s.emptyTitle}>Скоро здесь появится команда клиники</Text>
          </View>
        )}

        {/* Hero */}
        {hero && (
          <Reveal delay={0}>
            <PressCard style={s.heroCard} onPress={() => goToDetail(hero.id)}>
              <SpecialistPhoto
                photoUrl={hero.photoUrl}
                name={hero.name}
                style={s.heroPhoto}
                fontSize={64}
              />
              <View style={s.heroMeta}>
                <Text style={s.heroName} numberOfLines={2}>{hero.name}</Text>
                {!!hero.specialization && (
                  <Text style={s.heroSpec} numberOfLines={2}>{hero.specialization}</Text>
                )}
              </View>
            </PressCard>
          </Reveal>
        )}

        {/* Grid 2-per-row */}
        {rest.length > 0 && (
          <View style={s.grid}>
            {rest.map((sp, i) => (
              <Reveal key={sp.id} delay={120 + Math.floor(i / 2) * 80}>
                <PressCard style={s.gridCard} onPress={() => goToDetail(sp.id)}>
                  <SpecialistPhoto
                    photoUrl={sp.photoUrl}
                    name={sp.name}
                    style={s.gridPhoto}
                    fontSize={36}
                  />
                  <View style={s.gridMeta}>
                    <Text style={s.gridName} numberOfLines={2}>{sp.name}</Text>
                    {!!sp.specialization && (
                      <Text style={s.gridSpec} numberOfLines={2}>{sp.specialization}</Text>
                    )}
                  </View>
                </PressCard>
              </Reveal>
            ))}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
const HERO_W      = width - 40;
const HERO_PHOTO_H = HERO_W * 1.25;       // 4:5
const GRID_W      = (width - 52) / 2;     // 20 padding * 2 + 12 gap
const GRID_PHOTO_H = GRID_W * 1.25;       // 4:5

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  headerTitle: { fontSize: 22, color: T.stone, fontFamily: 'serif', letterSpacing: 0.3 },
  headerSub:   { fontSize: 12, color: T.stoneMid, marginTop: 2, letterSpacing: 0.5 },

  scroll: { paddingHorizontal: 20, paddingTop: 8 },

  // Hero card
  heroCard: {
    width: HERO_W,
    borderRadius: 24,
    backgroundColor: T.glass,
    borderWidth: 1, borderColor: T.champagne + '40',
    overflow: 'hidden',
    marginBottom: 24,
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18, shadowRadius: 20, elevation: 6,
  },
  heroPhoto: { width: HERO_W, height: HERO_PHOTO_H },
  heroMeta: { padding: 18 },
  heroName: { fontSize: 20, color: T.stone, fontFamily: 'serif', marginBottom: 4 },
  heroSpec: { fontSize: 13, color: T.stoneMid, letterSpacing: 0.3, lineHeight: 18 },

  // Grid 2-per-row
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  gridRow: { flexDirection: 'row', gap: 12 },
  gridCard: {
    width: GRID_W,
    borderRadius: 20,
    backgroundColor: T.glass,
    borderWidth: 1, borderColor: T.glassBorder,
    overflow: 'hidden',
    shadowColor: T.shadow, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10, shadowRadius: 14, elevation: 3,
  },
  gridPhoto: { width: GRID_W, height: GRID_PHOTO_H },
  gridMeta: { padding: 12, minHeight: 60 },
  gridName: { fontSize: 13, color: T.stone, fontFamily: 'serif', marginBottom: 2 },
  gridSpec: { fontSize: 11, color: T.stoneMid, letterSpacing: 0.2, lineHeight: 14 },

  // Empty / error
  emptyWrap: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyTitle: {
    fontSize: 14, color: T.stoneMuted, marginTop: 14, textAlign: 'center',
    paddingHorizontal: 40, lineHeight: 20,
  },
  retryBtn: {
    marginTop: 18, paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: 14, overflow: 'hidden',
  },
  retryText: { fontSize: 14, color: '#fff', letterSpacing: 0.5 },
});
```

- [ ] **Step 3: Quick syntax check**

```bash
cd /root/mobile && node --check src/screens/SpecialistsScreen.js && echo OK
```

Expected: `OK` (no syntax error). JSX is not pure JS but Node's `--check` will accept arrow-function/import syntax — it would only fail on actual JS syntax errors. If `--check` complains because of JSX, fall back to a grep:
```bash
grep -c "export default function SpecialistsScreen" src/screens/SpecialistsScreen.js
```
Expected: `1`.

- [ ] **Step 4: Commit**

```bash
cd /root/mobile && git add src/screens/SpecialistsScreen.js && git commit -m "$(cat <<'EOF'
feat(screens): add SpecialistsScreen — hero + 2-per-row grid list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Create `SpecialistDetailScreen.js`

**Files:**
- Create: `/root/mobile/src/screens/SpecialistDetailScreen.js`

- [ ] **Step 1: Create the file**

Create `/root/mobile/src/screens/SpecialistDetailScreen.js` with the following content:

```jsx
import React, { useEffect, useMemo, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  ScrollView,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';

const { width } = Dimensions.get('window');

// ─── Design tokens (match HomeScreen) ──────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  glass:      'rgba(255,252,248,0.72)',
  glassBorder:'rgba(255,255,255,0.85)',
  champagne:  '#D4AF37',
  champLight: '#F0D882',
  champDark:  '#A8881C',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  glowA:      'rgba(240,216,130,0.22)',
  glowB:      'rgba(220,210,240,0.18)',
};

const PHOTO_W = width;
const PHOTO_H = width * 1.25; // 4:5

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function SpecialistDetailScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const id = route.params?.id;

  const specialists = useClientStore((s) => s.specialists);
  const fetchSpecialists = useClientStore((s) => s.fetchSpecialists);

  const specialist = useMemo(
    () => specialists.find((sp) => sp.id === id) || null,
    [specialists, id]
  );

  // Defensive fallback: if list isn't in the store (e.g. deep link), fetch it
  useEffect(() => {
    if (!specialist && specialists.length === 0) {
      fetchSpecialists();
    }
  }, [specialist, specialists.length]);

  // Switch status bar to light while photo is at the top, restore on blur
  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle('light-content', true);
      return () => StatusBar.setBarStyle('dark-content', true);
    }, [])
  );

  if (!specialist) {
    // Either still loading or genuinely missing — keep this minimal
    return (
      <View style={s.root}>
        <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />
        <View style={[s.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtnPlain} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={22} color={T.stone} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const hasPhoto = !!specialist.photoUrl;
  const hasBio = !!(specialist.bio && specialist.bio.trim());

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Photo (extends under status bar) */}
        <View style={s.photoWrap}>
          {hasPhoto ? (
            <Image source={{ uri: specialist.photoUrl }} style={s.photo} resizeMode="cover" />
          ) : (
            <View style={s.photo}>
              <LinearGradient
                colors={[T.glowA, T.glowB]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={s.initialsCenter}>
                <Text style={s.initialsText}>{getInitials(specialist.name)}</Text>
              </View>
            </View>
          )}
          {/* Subtle dark gradient at top so the back button is readable on bright photos */}
          <LinearGradient
            colors={['rgba(0,0,0,0.35)', 'transparent']}
            style={s.photoTopShade}
          />
        </View>

        {/* Body */}
        <View style={s.body}>
          <Text style={s.name}>{specialist.name}</Text>
          {!!specialist.specialization && (
            <Text style={s.spec}>{specialist.specialization}</Text>
          )}
          <View style={s.divider} />

          {hasBio ? (
            <Text style={s.bio}>{specialist.bio}</Text>
          ) : (
            <Text style={s.bioPlaceholder}>Подробная информация скоро появится</Text>
          )}
        </View>
      </ScrollView>

      {/* Floating back button over photo */}
      <View style={[s.backWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.85}>
          <BlurView intensity={50} tint="dark" style={s.backBlur}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </BlurView>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backBtnPlain: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    justifyContent: 'center', alignItems: 'center',
  },

  photoWrap: {
    width: PHOTO_W,
    height: PHOTO_H,
    overflow: 'hidden',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  photo: { width: PHOTO_W, height: PHOTO_H, justifyContent: 'center', alignItems: 'center' },
  photoTopShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 120 },
  initialsCenter: { justifyContent: 'center', alignItems: 'center' },
  initialsText: { fontSize: 80, color: T.champDark, fontFamily: 'serif' },

  backWrap: {
    position: 'absolute',
    left: 16,
  },
  backBlur: {
    width: 40, height: 40, borderRadius: 20,
    overflow: 'hidden',
    justifyContent: 'center', alignItems: 'center',
  },

  body: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  name: { fontSize: 26, color: T.stone, fontFamily: 'serif', letterSpacing: 0.3 },
  spec: { fontSize: 14, color: T.stoneMid, marginTop: 6, letterSpacing: 0.3, lineHeight: 20 },
  divider: {
    width: 48, height: 1.5, backgroundColor: T.champagne,
    marginTop: 18, marginBottom: 18, borderRadius: 2,
  },
  bio: { fontSize: 15, color: T.stone, lineHeight: 24 },
  bioPlaceholder: { fontSize: 14, color: T.stoneFaint, fontStyle: 'italic' },
});
```

- [ ] **Step 2: Quick syntax check**

```bash
cd /root/mobile && grep -c "export default function SpecialistDetailScreen" src/screens/SpecialistDetailScreen.js
```
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/screens/SpecialistDetailScreen.js && git commit -m "$(cat <<'EOF'
feat(screens): add SpecialistDetailScreen — large 4:5 photo + bio

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire up navigation in `App.js`

**Files:**
- Modify: `/root/mobile/App.js`

- [ ] **Step 1: Import the new screens**

Open `/root/mobile/App.js`. Find the imports block (lines 17-29). Add two new imports anywhere in that block (e.g. after the `RouteToClinicScreen` import on line 29):

```js
import SpecialistsScreen from './src/screens/SpecialistsScreen';
import SpecialistDetailScreen from './src/screens/SpecialistDetailScreen';
```

- [ ] **Step 2: Register the screens in `HomeStack`**

Find the `HomeStack` function (lines 38-52). Add two new `<HomeStackNav.Screen>` entries inside the navigator, after the `Notifications` line (line 49) and before `</HomeStackNav.Navigator>`:

```jsx
      <HomeStackNav.Screen name="Specialists" component={SpecialistsScreen} />
      <HomeStackNav.Screen name="SpecialistDetail" component={SpecialistDetailScreen} />
```

The full `HomeStack` should now look like:

```jsx
function HomeStack() {
  return (
    <HomeStackNav.Navigator
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <HomeStackNav.Screen name="HomeRoot" component={HomeScreen} />
      <HomeStackNav.Screen name="PriceList" component={PriceListScreen} />
      <HomeStackNav.Screen name="PriceListDetail" component={PriceListDetailScreen} />
      <HomeStackNav.Screen name="Prescriptions" component={PrescriptionsScreen} />
      <HomeStackNav.Screen name="PrescriptionDetail" component={PrescriptionDetailScreen} />
      <HomeStackNav.Screen name="BookingDetail" component={BookingDetailScreen} />
      <HomeStackNav.Screen name="Notifications" component={NotificationsScreen} />
      <HomeStackNav.Screen name="Specialists" component={SpecialistsScreen} />
      <HomeStackNav.Screen name="SpecialistDetail" component={SpecialistDetailScreen} />
    </HomeStackNav.Navigator>
  );
}
```

- [ ] **Step 3: Verify imports and registrations**

```bash
cd /root/mobile && grep -n "Specialists" App.js
```

Expected: 4 lines — 2 imports + 2 `<HomeStackNav.Screen ...>` registrations.

- [ ] **Step 4: Commit**

```bash
cd /root/mobile && git add App.js && git commit -m "$(cat <<'EOF'
feat(nav): register Specialists and SpecialistDetail in HomeStack

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add entry card on `HomeScreen`

**Files:**
- Modify: `/root/mobile/src/screens/HomeScreen.js`

- [ ] **Step 1: Add the new tile to the quickGrid**

Open `/root/mobile/src/screens/HomeScreen.js`. Find the quickGrid array (currently lines 510-516). Insert one new entry — placed **first** so the new section is the most prominent in the grid (display order is purely visual; nothing else depends on it):

Replace:
```jsx
          {[
            { icon: 'calendar-outline',       label: 'История',     nav: 'Bookings',      delay: 540 },
            { icon: 'person-outline',          label: 'Профиль',     nav: 'Profile',       delay: 580 },
            { icon: 'notifications-outline',   label: 'Уведомления', nav: 'Notifications', delay: 620 },
            { icon: 'gift-outline',            label: 'Бонусы',      nav: 'Bonuses',       delay: 660 },
            { icon: 'medical-outline',         label: 'Назначения',  nav: 'Prescriptions', delay: 700 },
            { icon: 'pricetag-outline',        label: 'Прайс',       nav: 'PriceList',     delay: 740 },
          ].map(({ icon, label, nav, delay }) => (
```

With:
```jsx
          {[
            { icon: 'people-outline',          label: 'Специалисты', nav: 'Specialists',   delay: 540 },
            { icon: 'calendar-outline',       label: 'История',     nav: 'Bookings',      delay: 580 },
            { icon: 'person-outline',          label: 'Профиль',     nav: 'Profile',       delay: 620 },
            { icon: 'notifications-outline',   label: 'Уведомления', nav: 'Notifications', delay: 660 },
            { icon: 'gift-outline',            label: 'Бонусы',      nav: 'Bonuses',       delay: 700 },
            { icon: 'medical-outline',         label: 'Назначения',  nav: 'Prescriptions', delay: 740 },
            { icon: 'pricetag-outline',        label: 'Прайс',       nav: 'PriceList',     delay: 780 },
          ].map(({ icon, label, nav, delay }) => (
```

This adds the "Специалисты" tile and shifts the existing tiles' reveal delays by 40ms each so the staggered animation still flows through the new 7-card grid.

- [ ] **Step 2: Verify the tile is wired**

```bash
cd /root/mobile && grep -n "Специалисты" src/screens/HomeScreen.js
```

Expected: `1` line — the new tile entry.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/screens/HomeScreen.js && git commit -m "$(cat <<'EOF'
feat(home): add Специалисты entry tile to HomeScreen quickGrid

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Manual UI smoke test in Expo

This is the single test stage — there is no automated suite. Plan time for actually running the app.

**Files:** None modified.

- [ ] **Step 1: Start Metro / Expo**

```bash
cd /root/mobile && npm start
```

A QR code appears. Open the app on a physical device (Expo Go) or press `a` for Android emulator / `i` for iOS simulator.

If the build is being weird from a previous run:
```bash
cd /root/mobile && npx expo start --clear
```

- [ ] **Step 2: Log in and reach the new tile**

Log in with a test account (phone OTP). On HomeScreen, scroll to the "Кабинет" section (quick-links grid). Confirm:
- A new tile labeled **"Специалисты"** is present, first in the grid, with a `people-outline` icon.
- Tapping it pushes a new screen with header "Специалисты" / "Команда клиники".

- [ ] **Step 3: Verify the list state**

On the SpecialistsScreen, confirm:
- A skeleton appears briefly while loading.
- After load, the **first specialist (display_order = 1)** appears as a full-width hero card with a 4:5 photo above and name+specialization below.
- All other specialists with `show_in_app=TRUE AND is_active=TRUE` appear in a 2-per-row grid below the hero.
- Pull-to-refresh works (champagne-tinted spinner).
- Specialists with no `custom_photo_url`/`avatar_url` show a champagne initials placeholder (no broken-image icon).

If the list is empty: open the loyalpro web admin → Settings → Сотрудники → toggle "Показывать в приложении" on for several rows, set `display_order` so one of them is `1`, optionally upload a photo, and pull-to-refresh on the mobile app.

- [ ] **Step 4: Verify the detail screen**

Tap the hero card. Confirm:
- A new screen opens with a large 4:5 photo at the top extending under the status bar.
- A floating back button (dark blur chip) is visible top-left and works.
- Name (Playfair Display, large) and specialization appear under the photo, separated by a champagne divider, then biography text.
- If `bio` is empty: italic "Подробная информация скоро появится" placeholder appears instead.
- Status bar text turns light over the photo, then dark again when navigating back.

Tap a grid card too — the detail screen should work identically for non-hero specialists.

- [ ] **Step 5: Verify regressions on neighbouring screens**

Quickly tap each tab and each adjacent quickGrid tile (Прайс / Назначения / Бонусы / Уведомления) to make sure nothing else regressed (the tile delay shift is the only HomeScreen change).

- [ ] **Step 6: If everything looks correct, summarise the manual test result for the user**

In your final message report:
- Which scenarios were tested (logged-in flow, empty state, photo fallback, detail screen, status bar transition).
- Any visual rough edges noticed (e.g. text overflow on a particular Cyrillic name) — note these as follow-ups, do not fix in this plan.
- If you could NOT run the simulator/device, say so explicitly. **Do not claim "tested in Expo" unless you actually opened the app.**

---

## Self-review (against [the spec](../specs/2026-05-03-specialists-section-design.md))

Spec section → covering task:

| Spec section                     | Task |
| -------------------------------- | ---- |
| Architecture diagram             | All  |
| API contract — endpoint, fields  | 1    |
| API contract — `photoUrl` resolution | 1 |
| API contract — SQL & ordering    | 1    |
| Mobile store / fetch behavior    | 3    |
| Entry card on HomeScreen         | 7    |
| `SpecialistsScreen` UI + states  | 4    |
| `SpecialistDetailScreen` UI      | 5    |
| Edge cases — no photo / no bio / no spec | 4, 5 |
| Russian copy strings             | 4, 5, 7 |
| Implementation order             | 1 → 7 |

No placeholders, no contradictory types (the field names `id`, `name`, `specialization`, `bio`, `photoUrl`, `displayOrder` match across backend response, store, and both screens). No "TBD" / "TODO" / "similar to Task N" / vague error-handling phrases. The `clearClientData()` reset hook mentioned in the spec is omitted because that helper does not exist in the current `clientStore.js` (the spec acknowledges this with "if such function exists; otherwise by analogy with `bookings`" — leaving `specialists` un-cleared on logout matches the existing `bookings` behavior).
