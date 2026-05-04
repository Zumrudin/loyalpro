# Portfolio "До/После" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded "Процедуры" strip on HomeScreen with a "До/после" section fed by `/api/mobile/client/portfolio/*` (already implemented on the loyalpro backend). Add three new screens — a 3-per-row category grid, a modal viewer with stacked Before/After + description + doctor, and a full categories grid behind the "Все" link.

**Architecture:** Standard project pattern — new methods on `clientDataAPI`, new state + fetchers on `clientStore`, three new screens registered inside `HomeStack` (so the bottom tab bar stays visible). One shared `PortfolioCard` component reused on the Home strip and the "Все" grid. Modal viewer (`presentation: 'modal'`) for the enlarged photo view; tap on the doctor reuses the existing `SpecialistDetail` screen.

**Tech Stack:** React Native + Expo SDK 54, Zustand, axios, expo-blur, expo-linear-gradient, react-native-reanimated, expo-haptics, Ionicons. Backend (`/root/loyalpro`) — Node.js + Express + pg-promise; **not modified** in this plan.

**Spec:** [docs/superpowers/specs/2026-05-04-portfolio-before-after-design.md](../specs/2026-05-04-portfolio-before-after-design.md)

**Important:** Per [CLAUDE.md](../../../CLAUDE.md), this codebase has NO test suite, NO linter, NO typecheck (`package.json` only defines `start`/`android`/`ios`/`web`). Verification is manual: `curl` for the backend smoke-checks and Expo dev server (`npm start`) for UI.

---

## File Map

```
MODIFY:
  src/api/client-data.js              + 2 methods on clientDataAPI
  src/store/clientStore.js            + portfolio state + 2 fetchers
  src/screens/HomeScreen.js           replace "Процедуры" section → "До/после"
                                      remove SERVICES constant, ServicePill, sp styles
  App.js                              register 3 new screens in HomeStack

CREATE:
  src/components/PortfolioCard.js     PortfolioCard + PortfolioCardSkeleton (named exports)
  src/screens/PortfolioCategoriesScreen.js
  src/screens/PortfolioCategoryScreen.js
  src/screens/PortfolioItemViewer.js
```

---

## Task 1: API methods on `clientDataAPI`

**Files:**
- Modify: `src/api/client-data.js` (append two methods inside the existing `clientDataAPI` object, before the closing `}`)

- [ ] **Step 1: Add the two methods**

Open `src/api/client-data.js`. The file currently ends at line 105 with `};`. Insert these two methods immediately before that closing brace (after the `getSpecialists` method on line 102-104):

```js
  // Get portfolio categories (Before/After)
  getPortfolioCategories: async () => {
    const res = await apiClient.get('/mobile/client/portfolio/categories');
    return res.data;
  },

  // Get portfolio items in one category
  getPortfolioCategory: async (id) => {
    const res = await apiClient.get(`/mobile/client/portfolio/categories/${id}`);
    return res.data;
  },
```

- [ ] **Step 2: Smoke-test the backend with curl**

The backend endpoints already exist in `/root/loyalpro/backend/routes/mobile-client.js`. Confirm they are reachable.

First grab a JWT (same approach as the specialists plan):
```bash
grep -oE 'eyJ[A-Za-z0-9._-]+' /root/loyalpro/server.log 2>/dev/null | tail -1
```

If empty, login flow:
```bash
TEST_PHONE="<replace with a real test client phone in DB>"
curl -s -X POST http://localhost:3000/api/mobile/auth/login -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\"}"
# OTP comes back in the response body in dev. Verify:
curl -s -X POST http://localhost:3000/api/mobile/auth/verify-otp -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\",\"otp\":\"<otp>\"}"
```

Then call both endpoints:
```bash
TOKEN="<paste JWT>"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/mobile/client/portfolio/categories | head -c 2000
```

Expected: `{"success":true,"categories":[{"id":..,"title":"..","coverPhotoUrl":"http://...","itemsCount":..}, ...]}`. If `categories` is empty, open loyalpro web admin → Настройки → Приложение → Портфолио работ, create one category with cover photo + at least one work, then re-run.

```bash
CAT_ID="<an id from the response above>"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/mobile/client/portfolio/categories/$CAT_ID | head -c 3000
```

Expected: `{"success":true,"category":{"id":..,"title":".."},"items":[{"id":..,"title":"..","description":"..","photoAfterUrl":"http://...","photoBeforeUrl":"http://...|null","specialist":{"id":..,"name":"..","photoUrl":"..."}|null}, ...]}`.

If both responses look correct, the API plumbing is verified.

- [ ] **Step 3: Commit**

```bash
git add src/api/client-data.js
git commit -m "$(cat <<'EOF'
feat(api): add portfolio category endpoints to clientDataAPI

getPortfolioCategories → /mobile/client/portfolio/categories
getPortfolioCategory(id) → /mobile/client/portfolio/categories/:id

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Store state + fetchers on `clientStore`

**Files:**
- Modify: `src/store/clientStore.js`

- [ ] **Step 1: Add state fields**

Open `src/store/clientStore.js`. Find the `// Specialists` block (currently around lines 36-38):

```js
  // Specialists
  specialists: [],
  specialistsLoading: false,
```

Insert this block immediately after it:

```js
  // Portfolio (Before/After)
  portfolioCategories: [],            // [{id, title, coverPhotoUrl, itemsCount}]
  portfolioCategoriesLoading: false,
  portfolioItemsByCategory: {},       // { [categoryId]: items[] }
  portfolioItemsLoading: {},          // { [categoryId]: bool }
```

- [ ] **Step 2: Add fetchers**

Find the existing `fetchSpecialists` action (look for the pattern: `fetchSpecialists: async () => {`). After the closing `},` of that action, insert:

```js
  fetchPortfolioCategories: async () => {
    set({ portfolioCategoriesLoading: true });
    try {
      const response = await clientDataAPI.getPortfolioCategories();
      set({
        portfolioCategories: response.categories || [],
        error: null,
      });
    } catch (error) {
      console.log('[API] portfolio categories failed:', error.message);
      set({ error: error.message });
    } finally {
      set({ portfolioCategoriesLoading: false });
    }
  },

  fetchPortfolioCategory: async (id) => {
    set((s) => ({
      portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: true },
    }));
    try {
      const response = await clientDataAPI.getPortfolioCategory(id);
      set((s) => ({
        portfolioItemsByCategory: {
          ...s.portfolioItemsByCategory,
          [id]: response.items || [],
        },
        error: null,
      }));
    } catch (error) {
      console.log('[API] portfolio category failed:', error.message);
      set({ error: error.message });
    } finally {
      set((s) => ({
        portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: false },
      }));
    }
  },
```

- [ ] **Step 3: Sanity-check with a temporary log**

In `src/screens/HomeScreen.js`, temporarily add at the top of the `HomeScreen` component (right after `const insets = useSafeAreaInsets();` on line 290):

```js
  const fetchPortfolioCategories = useClientStore((st) => st.fetchPortfolioCategories);
  const portfolioCategories = useClientStore((st) => st.portfolioCategories);
  useEffect(() => {
    fetchPortfolioCategories().then(() => {
      console.log('[DEBUG] portfolioCategories:', useClientStore.getState().portfolioCategories);
    });
  }, []);
```

Run `npm start` and open Expo on a device or emulator. In the Metro terminal you should see:
```
[DEBUG] portfolioCategories: [{ id: .., title: '..', coverPhotoUrl: '..', itemsCount: .. }, ...]
```

Confirm the array is non-empty (assuming you created at least one category in Task 1 step 2). **Then remove the temporary log block** before committing.

- [ ] **Step 4: Commit**

```bash
git add src/store/clientStore.js
git commit -m "$(cat <<'EOF'
feat(store): add portfolio categories + items fetchers to clientStore

Adds portfolioCategories, portfolioCategoriesLoading,
portfolioItemsByCategory cache (keyed by category id) and a per-id
loading map. Two thunks: fetchPortfolioCategories and
fetchPortfolioCategory(id). Failure is logged with [API] prefix and
surfaces via the shared error field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `PortfolioCard` component (with skeleton)

**Files:**
- Create: `src/components/PortfolioCard.js`

- [ ] **Step 1: Create the file**

Create `src/components/PortfolioCard.js` with this content:

```js
/**
 * PortfolioCard — cover-photo card with title overlay at the bottom.
 * Used on HomeScreen strip (size="strip") and PortfolioCategoriesScreen grid (size="grid").
 *
 * Sizes:
 *   strip  → fixed 120x150 (4:5)
 *   grid   → width = (screen - 56) / 2, aspect 4:5
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  shadow:     'rgba(100,90,70,0.12)',
};

const STRIP_W = 120;
const STRIP_H = 150;
const GRID_W = (SCREEN_W - 56) / 2;
const GRID_H = GRID_W * (5 / 4);

function getSize(size) {
  return size === 'grid'
    ? { width: GRID_W, height: GRID_H }
    : { width: STRIP_W, height: STRIP_H };
}

export function PortfolioCard({ category, size = 'strip', onPress, style }) {
  const [imgFailed, setImgFailed] = useState(false);
  const { width, height } = getSize(size);

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.card,
        { width, height, opacity: pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {imgFailed || !category.coverPhotoUrl ? (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <Ionicons name="image-outline" size={28} color={T.champagne} />
        </View>
      ) : (
        <Image
          source={{ uri: category.coverPhotoUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      )}

      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.55)']}
        start={{ x: 0, y: 0.4 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <Text style={styles.title} numberOfLines={2}>
        {category.title}
      </Text>
    </Pressable>
  );
}

export function PortfolioCardSkeleton({ size = 'strip', style }) {
  const { width, height } = getSize(size);
  return (
    <View
      style={[
        styles.card,
        { width, height, backgroundColor: T.silk, opacity: 0.7 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: T.glass,
    marginRight: 12,
    shadowColor: T.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 3,
  },
  fallback: {
    backgroundColor: T.silk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
```

Note: `marginRight: 12` is included in the base `card` style. On the strip (HomeScreen) we want it. On the grid (`PortfolioCategoriesScreen`) we override it with the `style` prop in Task 7 (`style={{ marginRight: 0 }}`) — `FlatList` `columnWrapperStyle: { gap: 16 }` handles the gap there.

- [ ] **Step 2: Commit**

```bash
git add src/components/PortfolioCard.js
git commit -m "$(cat <<'EOF'
feat(components): add PortfolioCard + PortfolioCardSkeleton

Cover photo with gradient + title overlay at the bottom. Two sizes:
'strip' (120x150) for the HomeScreen horizontal scroll, 'grid'
(half-screen width, 4:5 aspect) for the all-categories screen.
onError fallback shows a silk square with an image icon.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Replace "Процедуры" section on HomeScreen

**Files:**
- Modify: `src/screens/HomeScreen.js`

This task swaps the section's data source and component but does NOT yet wire navigation to category/viewer screens (those don't exist yet — taps will log a placeholder). After this task the user will see real cover photos on the Home screen.

- [ ] **Step 1: Add imports and selectors**

In `src/screens/HomeScreen.js`, find the existing import line for `LoyaltyRing` (around line 45):
```js
import LoyaltyRing from '../components/LoyaltyRing';
```

Add directly below:
```js
import { PortfolioCard, PortfolioCardSkeleton } from '../components/PortfolioCard';
```

Inside the `HomeScreen` component, find this block (around lines 299-301):
```js
  const fetchProfile  = useClientStore((st) => st.fetchProfile);
  const fetchBonuses  = useClientStore((st) => st.fetchBonuses);
  const fetchBookings = useClientStore((st) => st.fetchBookings);
```

Add directly below:
```js
  const portfolioCategories         = useClientStore((st) => st.portfolioCategories);
  const portfolioCategoriesLoading  = useClientStore((st) => st.portfolioCategoriesLoading);
  const fetchPortfolioCategories    = useClientStore((st) => st.fetchPortfolioCategories);
  const [portfolioFetched, setPortfolioFetched] = useState(false);
```

(`useState` is already imported at line 9.)

- [ ] **Step 2: Wire fetch on mount + on focus**

Find the existing `loadData` callback (around lines 306-308):
```js
  const loadData = useCallback(() =>
    Promise.all([fetchProfile(), fetchBonuses(), fetchBookings('upcoming')]),
  [fetchProfile, fetchBonuses, fetchBookings]);
```

Replace with:
```js
  const loadData = useCallback(() =>
    Promise.all([
      fetchProfile(),
      fetchBonuses(),
      fetchBookings('upcoming'),
      fetchPortfolioCategories().finally(() => setPortfolioFetched(true)),
    ]),
  [fetchProfile, fetchBonuses, fetchBookings, fetchPortfolioCategories]);
```

Find the existing `useFocusEffect` block (around lines 312-314):
```js
  useFocusEffect(useCallback(() => {
    fetchBookings('upcoming');
  }, [fetchBookings]));
```

Replace with:
```js
  useFocusEffect(useCallback(() => {
    fetchBookings('upcoming');
    fetchPortfolioCategories();
  }, [fetchBookings, fetchPortfolioCategories]));
```

- [ ] **Step 3: Replace the "Процедуры" section**

Find the block at lines 480-503 (currently the "Services horizontal scroll" comment + section header + `SCROLL`/`SERVICES.map`). Replace the whole block:

```jsx
        {/* ── Services horizontal scroll ────────────────── */}
        <Reveal delay={240}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Процедуры</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Bookings')}>
              <Text style={s.sectionLink}>Все</Text>
            </TouchableOpacity>
          </View>
        </Reveal>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.servicesScroll}
        >
          {SERVICES.map((svc, i) => (
            <ServicePill
              key={svc.id}
              {...svc}
              delay={280 + i * 60}
              onPress={() => navigation.navigate('Bookings')}
            />
          ))}
        </ScrollView>
```

…with this:

```jsx
        {/* ── Portfolio Before/After ─────────────────────── */}
        {(!portfolioFetched || portfolioCategoriesLoading) && (
          <>
            <Reveal delay={240}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>До/после</Text>
              </View>
            </Reveal>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.servicesScroll}
            >
              {[0, 1, 2, 3].map((i) => (
                <PortfolioCardSkeleton key={i} size="strip" />
              ))}
            </ScrollView>
          </>
        )}

        {portfolioFetched && portfolioCategories.length > 0 && (
          <>
            <Reveal delay={240}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>До/после</Text>
                <TouchableOpacity onPress={() => console.log('[NAV] PortfolioCategories — pending Task 7')}>
                  <Text style={s.sectionLink}>Все</Text>
                </TouchableOpacity>
              </View>
            </Reveal>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.servicesScroll}
            >
              {portfolioCategories.slice(0, 4).map((cat, i) => (
                <Reveal key={cat.id} delay={280 + i * 60}>
                  <PortfolioCard
                    category={cat}
                    size="strip"
                    onPress={() => console.log('[NAV] PortfolioCategory — pending Task 5', cat.id)}
                  />
                </Reveal>
              ))}
            </ScrollView>
          </>
        )}
```

When `portfolioFetched && portfolioCategories.length === 0` neither block renders — the section is hidden, as the spec requires.

- [ ] **Step 4: Remove dead code (`SERVICES`, `ServicePill`, `sp` styles)**

Delete the block at lines 228-286 (in the file *before* this task — line numbers shift after edits, so search for the exact strings):

Find:
```js
// ─── Service pill (horizontal scroll) ───────────────────────────────────────
const SERVICES = [
```
Delete from that line through the closing of the `sp` `StyleSheet.create({...})` block (the line `});` that follows the `label:` definition). The deletion ends right before:
```js
// ─── HomeScreen ──────────────────────────────────────────────────────────────
```

Use Read first to confirm the boundaries, then a single Edit.

- [ ] **Step 5: Verify in Expo**

Run:
```bash
cd /root/mobile && npm start
```

Open the app on a device/emulator. Confirm:
1. The "Процедуры" section is gone.
2. While categories load — 4 skeleton plates appear.
3. After load — up to 4 cover-photo cards with category titles, scrolling horizontally.
4. Tapping a card prints `[NAV] PortfolioCategory — pending Task 5 <id>` to the Metro console.
5. Tapping "Все" prints `[NAV] PortfolioCategories — pending Task 7`.
6. If you delete all categories on the loyalpro admin and pull-to-refresh (next focus / re-mount) — the section disappears entirely (no header, no skeleton).
7. Toggle airplane mode → kill app → reopen: section is hidden, but the rest of HomeScreen renders.

- [ ] **Step 6: Commit**

```bash
git add src/screens/HomeScreen.js
git commit -m "$(cat <<'EOF'
feat(home): replace Процедуры section with До/после portfolio strip

Pulls real categories from clientStore (fetchPortfolioCategories) on
mount and on focus. Shows 4 skeleton tiles while loading; up to 4
PortfolioCards once data arrives; nothing at all if zero categories.
Removes the hard-coded SERVICES + ServicePill + sp styles. Tap handlers
log placeholders — wired to navigation in Tasks 5 and 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `PortfolioCategoryScreen` + wire HomeScreen tap

**Files:**
- Create: `src/screens/PortfolioCategoryScreen.js`
- Modify: `App.js` (register screen)
- Modify: `src/screens/HomeScreen.js` (replace placeholder log)

- [ ] **Step 1: Create the screen file**

Create `src/screens/PortfolioCategoryScreen.js`:

```js
/**
 * PortfolioCategoryScreen — 3-per-row grid of works inside one category.
 * Tap an item → PortfolioItemViewer modal.
 */
import React, { useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useClientStore } from '../store/clientStore';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

const GRID_GAP = 8;
const GRID_PADDING = 16;
const TILE_W = (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * 2) / 3;

export default function PortfolioCategoryScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { id, title } = route.params;

  const items = useClientStore((s) => s.portfolioItemsByCategory[id]) || [];
  const loading = useClientStore((s) => s.portfolioItemsLoading[id]) || false;
  const error = useClientStore((s) => s.error);
  const fetchPortfolioCategory = useClientStore((s) => s.fetchPortfolioCategory);

  const load = useCallback(() => fetchPortfolioCategory(id), [fetchPortfolioCategory, id]);

  useEffect(() => {
    if (items.length === 0) load();
  }, []);

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.tile}
      activeOpacity={0.85}
      onPress={() => {
        Haptics.selectionAsync();
        navigation.navigate('PortfolioItemViewer', { item });
      }}
    >
      <Image
        source={{ uri: item.photoAfterUrl }}
        style={styles.tileImage}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={T.stone} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.champagne} />
        </View>
      ) : error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Не удалось загрузить</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>В этой категории пока нет работ</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          numColumns={3}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: GRID_PADDING, gap: GRID_GAP, paddingBottom: 24 }}
          columnWrapperStyle={{ gap: GRID_GAP }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={load} tintColor={T.champagne} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: T.pearl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 26,
    alignItems: 'flex-start',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
  },
  tile: {
    width: TILE_W,
    height: TILE_W,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: T.silk,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorText: {
    fontSize: 15,
    color: T.stoneMid,
    marginBottom: 16,
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: T.champagne,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 15,
    color: T.stoneFaint,
    textAlign: 'center',
  },
});
```

- [ ] **Step 2: Register the screen in HomeStack**

Open `App.js`. Find the import for `SpecialistDetailScreen` (around line 31):
```js
import SpecialistDetailScreen from './src/screens/SpecialistDetailScreen';
```

Add directly below:
```js
import PortfolioCategoryScreen from './src/screens/PortfolioCategoryScreen';
```

Find the `HomeStack` definition (around lines 40-56). Inside the `HomeStackNav.Navigator`, after the existing `<HomeStackNav.Screen name="SpecialistDetail" ... />` line, add:

```jsx
      <HomeStackNav.Screen name="PortfolioCategory" component={PortfolioCategoryScreen} />
```

- [ ] **Step 3: Wire the HomeScreen tap**

In `src/screens/HomeScreen.js`, find the line added in Task 4 step 3:
```js
                    onPress={() => console.log('[NAV] PortfolioCategory — pending Task 5', cat.id)}
```

Replace with:
```js
                    onPress={() => navigation.navigate('PortfolioCategory', { id: cat.id, title: cat.title })}
```

- [ ] **Step 4: Verify in Expo**

Restart Metro (`r` in the terminal or `npx expo start --clear` if needed). On the device:
1. HomeScreen → tap any portfolio card → opens new screen with the category title at the top.
2. Grid shows works in 3 columns. Each tile is the `photoAfterUrl` cropped to a square.
3. Tapping a tile does nothing yet (Task 6 wires the viewer; the route doesn't exist yet — RN will show a navigation warning. That's expected at this stage; it will be silenced in Task 6).
4. Pull-to-refresh works.
5. Back arrow returns to HomeScreen with the strip intact.
6. Open a category that has zero items (create one via admin if none exist) → "В этой категории пока нет работ" centered.
7. Disable network → kill the cached state → enter category → "Не удалось загрузить" + Повторить button. Tapping it re-fetches.

- [ ] **Step 5: Commit**

```bash
git add src/screens/PortfolioCategoryScreen.js App.js src/screens/HomeScreen.js
git commit -m "$(cat <<'EOF'
feat(screens): add PortfolioCategoryScreen — 3-per-row grid of works

Tap an after-photo thumbnail → opens PortfolioItemViewer (route added
in Task 6). Pull-to-refresh, error retry, and empty state included.
Wired the HomeScreen portfolio strip taps to navigate here.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `PortfolioItemViewer` (modal) + wire from category grid

**Files:**
- Create: `src/screens/PortfolioItemViewer.js`
- Modify: `App.js`

- [ ] **Step 1: Create the viewer file**

Create `src/screens/PortfolioItemViewer.js`:

```js
/**
 * PortfolioItemViewer — modal-style screen with vertically stacked
 * Before/After photos, description, and the doctor who performed the work.
 *
 * Navigation: presented as modal (presentation: 'modal' on the route).
 * Receives the full item object via route.params.item.
 */
import React from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Dimensions,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  pearl:      '#F5F3F0',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  silk:       '#EDE9E3',
};

const PHOTO_W = SCREEN_W - 40;
const PHOTO_H = PHOTO_W * (5 / 4);

export default function PortfolioItemViewer({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const item = route.params?.item;

  if (!item) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.errorText}>Работа не найдена</Text>
      </View>
    );
  }

  const onSpecialistPress = () => {
    if (!item.specialist?.id) return;
    Haptics.selectionAsync();
    // Close the modal first, then push SpecialistDetail on the underlying stack.
    navigation.goBack();
    setTimeout(() => {
      navigation.navigate('SpecialistDetail', { id: item.specialist.id });
    }, 0);
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={{ width: 28 }} />
        <Text style={styles.headerTitle} numberOfLines={1}>До/после</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Ionicons name="close" size={28} color={T.stone} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 32,
        }}
        showsVerticalScrollIndicator={false}
      >
        {item.photoBeforeUrl && (
          <View style={styles.photoBlock}>
            <Text style={styles.photoLabel}>До</Text>
            <Image
              source={{ uri: item.photoBeforeUrl }}
              style={styles.photo}
              resizeMode="cover"
            />
          </View>
        )}

        <View style={styles.photoBlock}>
          <Text style={styles.photoLabel}>После</Text>
          <Image
            source={{ uri: item.photoAfterUrl }}
            style={styles.photo}
            resizeMode="cover"
          />
        </View>

        {!!item.title && (
          <Text style={styles.title}>{item.title}</Text>
        )}

        {!!item.description && (
          <Text style={styles.description}>{item.description}</Text>
        )}

        {item.specialist && (
          <Pressable onPress={onSpecialistPress} style={styles.specRow}>
            {item.specialist.photoUrl ? (
              <Image
                source={{ uri: item.specialist.photoUrl }}
                style={styles.specAvatar}
              />
            ) : (
              <View style={[styles.specAvatar, styles.specAvatarFallback]}>
                <Ionicons name="person" size={20} color={T.stoneMid} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.specCaption}>Выполнил(а)</Text>
              <Text style={styles.specName} numberOfLines={1}>{item.specialist.name}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.stoneFaint} />
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
  },
  photoBlock: {
    marginTop: 8,
    marginBottom: 24,
  },
  photoLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.5,
    color: T.champagne,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  photo: {
    width: PHOTO_W,
    height: PHOTO_H,
    borderRadius: 16,
    backgroundColor: T.silk,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: T.stone,
    marginTop: 8,
  },
  description: {
    fontSize: 14,
    color: T.stoneMid,
    lineHeight: 22,
    marginTop: 8,
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(74,69,64,0.15)',
  },
  specAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: T.silk,
  },
  specAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  specCaption: {
    fontSize: 11,
    color: T.stoneFaint,
    letterSpacing: 0.4,
  },
  specName: {
    fontSize: 15,
    color: T.stone,
    fontWeight: '500',
    marginTop: 2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 15,
    color: T.stoneMid,
  },
});
```

Note on the doctor tap: `navigation.goBack()` first closes the modal, then we navigate to `SpecialistDetail` on the underlying `HomeStack` (where it's already registered). The `setTimeout(..., 0)` defers the second call to the next tick so the modal-close animation can begin — without it, RN sometimes drops the second navigation event in modal stacks.

- [ ] **Step 2: Register the modal route**

In `App.js`, find the line added in Task 5 step 2:
```jsx
      <HomeStackNav.Screen name="PortfolioCategory" component={PortfolioCategoryScreen} />
```

Add the import at the top, near the other screen imports:
```js
import PortfolioItemViewer from './src/screens/PortfolioItemViewer';
```

Add this line directly below the `PortfolioCategory` screen registration:

```jsx
      <HomeStackNav.Screen
        name="PortfolioItemViewer"
        component={PortfolioItemViewer}
        options={{ presentation: 'modal' }}
      />
```

- [ ] **Step 3: Verify in Expo**

Reload the app. Confirm:
1. HomeScreen → portfolio strip → tap a category → grid → tap an item → modal slides up from the bottom.
2. If the work has both photos: «До» label + photo, «После» label + photo, title, description, doctor row with avatar and name.
3. If the work has no `photoBeforeUrl`: only «После» block (no «До» heading).
4. If `specialist` is null: doctor row is hidden.
5. If `specialist.photoUrl` is null: avatar shows person icon fallback.
6. Tap close (X) → modal dismisses. On iOS — swipe down also dismisses.
7. Tap doctor row → modal closes and `SpecialistDetail` for that staff opens (if specialist has a valid id).
8. Tap doctor on a work where specialist.photoUrl is broken → still navigates correctly.

- [ ] **Step 4: Commit**

```bash
git add src/screens/PortfolioItemViewer.js App.js
git commit -m "$(cat <<'EOF'
feat(screens): add PortfolioItemViewer modal — stacked Before/After

Modal presentation. Vertical stack of «До» (if present) and «После»
photos at 4:5, then item title, description, and a tappable doctor
row that closes the modal and pushes SpecialistDetail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `PortfolioCategoriesScreen` (the "Все" target)

**Files:**
- Create: `src/screens/PortfolioCategoriesScreen.js`
- Modify: `App.js`
- Modify: `src/screens/HomeScreen.js` (replace placeholder log on "Все")

- [ ] **Step 1: Create the screen file**

Create `src/screens/PortfolioCategoriesScreen.js`:

```js
/**
 * PortfolioCategoriesScreen — full grid of all portfolio categories (the
 * destination of the "Все" link from HomeScreen).
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';
import { PortfolioCard } from '../components/PortfolioCard';

const T = {
  pearl:      '#F5F3F0',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

export default function PortfolioCategoriesScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const categories = useClientStore((s) => s.portfolioCategories);
  const loading = useClientStore((s) => s.portfolioCategoriesLoading);
  const fetchPortfolioCategories = useClientStore((s) => s.fetchPortfolioCategories);

  const onRefresh = useCallback(() => fetchPortfolioCategories(), [fetchPortfolioCategories]);

  const renderItem = ({ item }) => (
    <PortfolioCard
      category={item}
      size="grid"
      style={{ marginRight: 0 }}
      onPress={() => navigation.navigate('PortfolioCategory', { id: item.id, title: item.title })}
    />
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={T.stone} />
        </TouchableOpacity>
        <Text style={styles.title}>Портфолио работ</Text>
        <View style={{ width: 26 }} />
      </View>

      {categories.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Пока нет работ</Text>
        </View>
      ) : (
        <FlatList
          data={categories}
          numColumns={2}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 32 }}
          columnWrapperStyle={{ gap: 16 }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.champagne} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: T.pearl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 26,
    alignItems: 'flex-start',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 15,
    color: T.stoneFaint,
    textAlign: 'center',
  },
});
```

- [ ] **Step 2: Register the route**

In `App.js`, add the import at the top with the other screens:
```js
import PortfolioCategoriesScreen from './src/screens/PortfolioCategoriesScreen';
```

In the `HomeStack`, before the `PortfolioCategory` line, add:
```jsx
      <HomeStackNav.Screen name="PortfolioCategories" component={PortfolioCategoriesScreen} />
```

Final order in `HomeStack` should be:
```jsx
      <HomeStackNav.Screen name="PortfolioCategories" component={PortfolioCategoriesScreen} />
      <HomeStackNav.Screen name="PortfolioCategory" component={PortfolioCategoryScreen} />
      <HomeStackNav.Screen
        name="PortfolioItemViewer"
        component={PortfolioItemViewer}
        options={{ presentation: 'modal' }}
      />
```

- [ ] **Step 3: Wire the "Все" tap on HomeScreen**

In `src/screens/HomeScreen.js`, find the line:
```js
                <TouchableOpacity onPress={() => console.log('[NAV] PortfolioCategories — pending Task 7')}>
```

Replace with:
```js
                <TouchableOpacity onPress={() => navigation.navigate('PortfolioCategories')}>
```

- [ ] **Step 4: Verify in Expo**

Reload. Confirm:
1. HomeScreen → tap "Все" → opens `PortfolioCategoriesScreen` with all categories in a 2-col grid.
2. Each card has a 4:5 aspect cover photo with title overlay at the bottom.
3. Pull-to-refresh refetches the list.
4. Tap any card → opens `PortfolioCategoryScreen` (3-col grid).
5. Back arrow returns to HomeScreen.
6. If the salon has zero categories — "Все" link does not show on HomeScreen (per Task 4 logic), so this screen is unreachable through normal flow. Manually deep-linking to it (or temporarily hard-coding navigation in dev) shows "Пока нет работ" centered.

- [ ] **Step 5: Commit**

```bash
git add src/screens/PortfolioCategoriesScreen.js App.js src/screens/HomeScreen.js
git commit -m "$(cat <<'EOF'
feat(screens): add PortfolioCategoriesScreen — full 2-col grid

Destination for the "Все" link on HomeScreen. Reuses PortfolioCard at
size='grid'. Pull-to-refresh and an empty fallback included.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: End-to-end manual UAT pass

**Files:** none (verification-only).

This is a final pass through the whole flow with all phases live. Catches integration bugs that only surface when everything is glued together.

- [ ] **Step 1: Backend prep**

In loyalpro web admin (Settings → Приложение → Портфолио работ for the test salon):

- Create at least **2 categories** with cover photos and titles. Make at least **5 categories** if you want to verify the "first 4 + Все" cutoff.
- In each category: add at least **2 works**. In one category, include:
  - One work with both `before` and `after` photos, a description, AND a doctor assigned.
  - One work with only `after` photo (no before) and no description, no doctor.
- Verify the data via curl (Task 1 step 2 commands).

- [ ] **Step 2: Cold-start the mobile app**

Force-quit and reopen the app. Confirm:
- HomeScreen shows the "До/после" section between the bonus card and "Кабинет" grid.
- Skeleton plates appear briefly, then up to 4 cover-photo cards.
- "Все" link is visible if there are >0 categories.

- [ ] **Step 3: Walk the full flow**

1. Tap card 1 → category screen (3-col grid).
2. Tap a 2-photo work → modal opens with До + После + description + doctor row.
3. Tap doctor row → modal closes, `SpecialistDetail` opens for that staff. Back to HomeScreen.
4. From HomeScreen → tap "Все" → all-categories screen (2-col grid).
5. Tap any card → same 3-col grid as step 1.
6. Tap a 1-photo work (only After) → modal opens; no «До» block.
7. Close modal with the X button on Android, with swipe-down on iOS — both work.
8. Pull-to-refresh on category screen and on all-categories screen.
9. Open a category, navigate back, re-enter same category — content appears instantly (cached in `portfolioItemsByCategory`), pull-to-refresh still re-fetches.
10. Toggle airplane mode → kill app → reopen → no portfolio section visible (silent fail, the rest of HomeScreen renders).
11. Re-enable network → return to Home → portfolio section appears (focus refresh fires).

- [ ] **Step 4: Visual sanity**

- Cover photos fill the card edge-to-edge.
- Bottom gradient is subtle but title text is legible against it.
- No content sliding under the bottom tab bar — categories list and viewer modal both respect `insets.bottom` and the tab-bar offset on the Home strip is unchanged.
- Skeleton plates match the same dimensions as real cards (no jump).

- [ ] **Step 5: No-action commit (if needed)**

This task does not produce code changes. If any defect is found, fix it as a follow-up commit on the relevant task's file. If everything is clean, **no commit is needed for Task 8**.

---

## Coverage check (against spec)

| Spec section / requirement | Task |
|---|---|
| API: `getPortfolioCategories`, `getPortfolioCategory` | Task 1 |
| Store state: `portfolioCategories`, `*Loading`, `portfolioItemsByCategory`, `portfolioItemsLoading` | Task 2 |
| Store actions: `fetchPortfolioCategories`, `fetchPortfolioCategory` | Task 2 |
| `PortfolioCard` strip + grid sizes, fallback on error | Task 3 |
| `PortfolioCardSkeleton` co-located | Task 3 |
| HomeScreen: replace "Процедуры" → "До/после", first 4 cards, hide section if empty, focus refresh | Task 4 |
| Remove `SERVICES`, `ServicePill`, `sp` styles | Task 4 |
| `PortfolioCategoryScreen` 3-per-row, after-photo thumbs, pull-to-refresh, error retry, empty state | Task 5 |
| `PortfolioItemViewer` modal, vertical stack, optional `photoBeforeUrl`, optional `specialist` | Task 6 |
| Doctor tap → close modal + push `SpecialistDetail` | Task 6 |
| `PortfolioCategoriesScreen` ("Все") 2-col grid, pull-to-refresh | Task 7 |
| Wire "Все" link from HomeScreen | Task 7 |
| Three new screens registered in `HomeStack` (not root) | Tasks 5, 6, 7 |
| Modal presentation for the viewer | Task 6 |
| End-to-end UAT including airplane-mode, missing-before, no-doctor, empty category | Task 8 |
