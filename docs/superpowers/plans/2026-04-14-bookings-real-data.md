# Bookings Real Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display real booking history and upcoming appointments from the `records` PostgreSQL table in the mobile app, with a tap-to-detail flow showing per-service prices and discounts, styled in the "Liquid Glass & Silk" luxury design system.

**Architecture:** Fix two backend endpoints (list + detail) to extract data from JSONB columns instead of querying non-existent columns; add `fetchBookingDetail` to Zustand store; rewrite `BookingsScreen` in luxury style; create new `BookingDetailScreen`; wrap `TabNavigator` in a root `Stack` so the detail screen can slide in from the right above the tab bar.

**Tech Stack:** React Native / Expo, React Navigation v6 (Stack + Tab), Zustand, react-native-reanimated 3, expo-linear-gradient, expo-blur, expo-haptics, date-fns (ru locale), PostgreSQL JSONB operators.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `loyalpro/backend/routes/mobile-client.js` | Fix JSONB extraction in `/bookings` and `/bookings/:id` |
| Modify | `mobile/src/store/clientStore.js` | Add `fetchBookingDetail` action |
| Rewrite | `mobile/src/screens/BookingsScreen.js` | Luxury list screen with tap navigation |
| Create  | `mobile/src/screens/BookingDetailScreen.js` | Luxury detail screen |
| Modify  | `mobile/App.js` | Wrap TabNavigator in root Stack, register BookingDetailScreen |

---

## Task 1: Fix backend — bookings list endpoint

**Files:**
- Modify: `loyalpro/backend/routes/mobile-client.js:62-75`

The current query references `service_name` and `specialist_name` columns which don't exist. Data lives in `services` (JSONB array of `{title, cost, cost_to_pay, discount}`) and `staff` (JSONB array of `{id, name}`).

- [ ] **Step 1: Replace the broken SELECT in GET /bookings**

Open `loyalpro/backend/routes/mobile-client.js`. Replace lines 62–75:

```js
const bookings = await db.many(
  `SELECT
    id,
    visit_date as "dateTime",
    services->0->>'title'  as "serviceName",
    staff->0->>'name'      as "specialistName",
    status,
    amount as price
   FROM records
   WHERE ${whereSql}
   ORDER BY visit_date DESC
   LIMIT 50`,
  [req.client.clientId]
);
```

Also replace the empty-result fallback — `db.many` throws when 0 rows; use `db.manyOrNone`:

```js
const bookings = await db.manyOrNone(
  `SELECT
    id,
    visit_date as "dateTime",
    services->0->>'title'  as "serviceName",
    staff->0->>'name'      as "specialistName",
    status,
    amount as price
   FROM records
   WHERE ${whereSql}
   ORDER BY visit_date DESC
   LIMIT 50`,
  [req.client.clientId]
);
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "require('./loyalpro/backend/routes/mobile-client.js'); console.log('OK')"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
cd /root
git add loyalpro/backend/routes/mobile-client.js
git commit -m "fix: extract serviceName/specialistName from JSONB in bookings list endpoint"
```

---

## Task 2: Fix backend — booking detail endpoint

**Files:**
- Modify: `loyalpro/backend/routes/mobile-client.js:89-118`

The detail endpoint also queries the non-existent columns and doesn't return the `services` array needed for the detail screen.

- [ ] **Step 1: Replace the broken SELECT in GET /bookings/:bookingId**

Replace lines 91–103:

```js
const booking = await db.oneOrNone(
  `SELECT
    id,
    visit_date as "dateTime",
    services->0->>'title'  as "serviceName",
    staff->0->>'name'      as "specialistName",
    status,
    amount as price,
    services,
    staff,
    client_id
   FROM records
   WHERE id=$1 AND client_id=$2`,
  [req.params.bookingId, req.client.clientId]
);
```

Also update the null check from `if (!booking)` — `db.oneOrNone` returns `null` when not found (no throw), so the existing check works correctly.

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "require('./loyalpro/backend/routes/mobile-client.js'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /root
git add loyalpro/backend/routes/mobile-client.js
git commit -m "fix: return full services JSONB array in booking detail endpoint"
```

---

## Task 3: Add fetchBookingDetail to Zustand store

**Files:**
- Modify: `mobile/src/store/clientStore.js`

The store has no action to fetch a single booking's detail. `BookingDetailScreen` will call this action on mount.

- [ ] **Step 1: Add state fields and action**

In `mobile/src/store/clientStore.js`, add to the store object:

After the existing `bookings: []` and `bookingsLoading: false` fields, add:

```js
  // Booking detail
  bookingDetail: null,
  bookingDetailLoading: false,
```

After the existing `fetchBookings` action, add:

```js
  fetchBookingDetail: async (bookingId) => {
    set({ bookingDetailLoading: true, bookingDetail: null });
    try {
      const response = await clientDataAPI.getBooking(bookingId);
      set({ bookingDetail: response.booking || response, error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bookingDetailLoading: false });
    }
  },
```

- [ ] **Step 2: Verify module loads**

```bash
cd /root/mobile
node -e "console.log('store ok')"
```

Expected: `store ok`

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add src/store/clientStore.js
git commit -m "feat: add fetchBookingDetail action to clientStore"
```

---

## Task 4: Rewrite BookingsScreen in luxury style

**Files:**
- Rewrite: `mobile/src/screens/BookingsScreen.js`

Match the "Liquid Glass & Silk" design system from `HomeScreen.js`. Key patterns: `T` design tokens, `Skeleton` shimmer, `Reveal` entry animation, `PressCard` haptic press, pearl background, gold accents, glass cards with `rgba(255,252,248,0.88)` fill and `rgba(212,175,55,0.4)` border.

Navigation: tap a card → `navigation.navigate('BookingDetail', { bookingId: booking.id })`.

- [ ] **Step 1: Overwrite BookingsScreen.js with full implementation**

Replace the entire file content of `mobile/src/screens/BookingsScreen.js`:

```js
/**
 * BookingsScreen — "Liquid Glass & Silk" redesign
 * Aura Aesthetics Premium Clinic
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
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
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

// ─── Design tokens ───────────────────────────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.88)',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  shadow:     'rgba(100,90,70,0.12)',
};

// ─── Shimmer skeleton ─────────────────────────────────────────────────────────
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
    <Animated.View style={[{ width: w, height: h, borderRadius: radius, overflow: 'hidden' }, style, animStyle]}>
      <LinearGradient colors={[T.silk, '#E8E2DA', T.silk]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
    </Animated.View>
  );
}

// ─── Fade + slide entry ───────────────────────────────────────────────────────
function Reveal({ delay = 0, children }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(28);
  const scale = useSharedValue(0.96);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 600, easing: Easing.out(Easing.cubic) }));
    ty.value      = withDelay(delay, withSpring(0, { damping: 20, stiffness: 100 }));
    scale.value   = withDelay(delay, withSpring(1, { damping: 20, stiffness: 100 }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }, { scale: scale.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

// ─── Haptic press card ────────────────────────────────────────────────────────
function PressCard({ style, onPress, children }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    shadowOpacity: interpolate(scale.value, [0.97, 1], [0.06, 0.14]),
  }));
  const handleIn = () => {
    scale.value = withSpring(0.975, { damping: 18, stiffness: 200 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  const handleOut = () => { scale.value = withSpring(1, { damping: 18, stiffness: 200 }); };
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

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    confirmed:  { label: '✓ Подтверждена', bg: '#e8f5e9', color: '#4CAF50' },
    pending:    { label: '⏳ Ожидает',      bg: '#FFF8E1', color: '#FFA000' },
    cancelled:  { label: '✗ Отменена',     bg: '#FFEBEE', color: '#E53935' },
    completed:  { label: '✓ Завершена',    bg: '#e8f5e9', color: '#4CAF50' },
  };
  const cfg = map[status] || { label: status, bg: '#F5F5F5', color: T.stoneMid };
  return (
    <View style={{ backgroundColor: cfg.bg, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ fontSize: 10, fontWeight: '600', color: cfg.color }}>{cfg.label}</Text>
    </View>
  );
}

// ─── Booking card ─────────────────────────────────────────────────────────────
function BookingCard({ booking, index, onPress }) {
  const isFirst = index === 0;
  return (
    <Reveal delay={index * 80}>
      <PressCard
        onPress={onPress}
        style={[
          styles.card,
          isFirst && { borderColor: 'rgba(212,175,55,0.45)', shadowColor: T.champagne, shadowOpacity: 0.14, shadowRadius: 16 },
        ]}
      >
        <View style={styles.cardInner}>
          {/* Date row */}
          <View style={styles.cardTopRow}>
            <View>
              {isFirst && (
                <Text style={styles.cardLabel}>
                  {new Date(booking.dateTime) > new Date() ? 'Следующий визит' : 'Последний визит'}
                </Text>
              )}
              <Text style={styles.cardDate}>
                {format(new Date(booking.dateTime), 'd MMMM, EEEE', { locale: ru })}
              </Text>
              <Text style={styles.cardTime}>
                {format(new Date(booking.dateTime), 'HH:mm')}
              </Text>
            </View>
            <StatusBadge status={booking.status} />
          </View>

          {/* Divider */}
          <View style={styles.divider} />

          {/* Service + specialist */}
          <Text style={styles.cardService}>{booking.serviceName || '—'}</Text>
          <Text style={styles.cardSpecialist}>💼 {booking.specialistName || '—'}</Text>
        </View>

        {/* Footer */}
        <View style={styles.cardFooter}>
          <Text style={styles.cardPrice}>
            {booking.price ? Number(booking.price).toLocaleString('ru-RU') + ' ₽' : '—'}
          </Text>
          <Text style={styles.cardHint}>Нажмите для деталей →</Text>
        </View>
      </PressCard>
    </Reveal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function BookingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('upcoming');

  const bookings        = useClientStore((s) => s.bookings);
  const bookingsLoading = useClientStore((s) => s.bookingsLoading);
  const fetchBookings   = useClientStore((s) => s.fetchBookings);

  useEffect(() => { fetchBookings(filter); }, [filter]);

  const onRefresh = useCallback(() => fetchBookings(filter), [filter]);

  const handleCardPress = (booking) => {
    navigation.navigate('BookingDetail', { bookingId: booking.id });
  };

  return (
    <View style={[styles.root, { paddingTop: 0 }]}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />
      <LinearGradient colors={[T.pearl, T.silk]} style={StyleSheet.absoluteFill} />

      {/* Blur header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <BlurView intensity={60} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(245,243,240,0.92)', 'rgba(237,233,227,0.88)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.headerBorder} />
        <Text style={styles.headerSub}>Аура Эстетик</Text>
        <Text style={styles.headerTitle}>Мои записи</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {[
          { key: 'upcoming', label: 'Предстоящие' },
          { key: 'past',     label: 'История' },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, filter === tab.key && styles.tabActive]}
            onPress={() => setFilter(tab.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, filter === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
        refreshControl={
          <RefreshControl refreshing={bookingsLoading} onRefresh={onRefresh} tintColor={T.champagne} />
        }
        showsVerticalScrollIndicator={false}
      >
        {bookingsLoading && bookings.length === 0 ? (
          // Skeleton placeholders
          [0, 1, 2].map((i) => (
            <View key={i} style={[styles.card, { padding: 16, gap: 10 }]}>
              <Skeleton width="60%" height={14} />
              <Skeleton width="40%" height={20} />
              <Skeleton width="100%" height={1} />
              <Skeleton width="70%" height={14} />
              <Skeleton width="50%" height={12} />
            </View>
          ))
        ) : bookings.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>
              {filter === 'upcoming' ? 'Нет предстоящих записей' : 'История визитов пуста'}
            </Text>
          </View>
        ) : (
          bookings.map((booking, i) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              index={i}
              onPress={() => handleCardPress(booking)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:       { flex: 1, backgroundColor: T.pearl },
  header:     { paddingHorizontal: 20, paddingBottom: 12, zIndex: 10, overflow: 'hidden' },
  headerBorder: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(212,175,55,0.22)' },
  headerSub:  { fontSize: 11, color: T.stoneMid, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 2 },
  headerTitle:{ fontSize: 26, color: T.stone, fontFamily: 'serif' },

  tabs:       { flexDirection: 'row', backgroundColor: 'rgba(245,243,240,0.95)', borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.2)', paddingHorizontal: 16, zIndex: 9 },
  tab:        { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive:  { borderBottomColor: T.champagne },
  tabText:    { fontSize: 13, fontWeight: '600', color: T.stoneFaint },
  tabTextActive: { color: T.champagne },

  scroll:     { flex: 1 },
  list:       { padding: 12, gap: 10 },

  card: {
    backgroundColor: T.glass,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.3)',
    overflow: 'hidden',
    shadowColor: 'rgba(100,90,70,1)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 3,
  },
  cardInner:  { padding: 14 },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  cardLabel:  { fontSize: 10, color: T.stoneMid, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 2 },
  cardDate:   { fontSize: 18, color: T.stone, fontFamily: 'serif' },
  cardTime:   { fontSize: 13, color: T.champagne, letterSpacing: 0.4, marginTop: 1 },
  divider:    { height: 1, backgroundColor: 'rgba(212,175,55,0.22)', marginBottom: 8 },
  cardService:{ fontSize: 14, color: T.stone, fontWeight: '500', marginBottom: 2 },
  cardSpecialist: { fontSize: 12, color: T.stoneMid },

  cardFooter: {
    backgroundColor: 'rgba(212,175,55,0.06)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(212,175,55,0.15)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardPrice:  { fontSize: 13, color: T.champagne, fontWeight: '600' },
  cardHint:   { fontSize: 11, color: T.stoneMid },

  empty:      { alignItems: 'center', paddingVertical: 80 },
  emptyIcon:  { fontSize: 48, marginBottom: 12 },
  emptyText:  { fontSize: 16, color: T.stoneMid },
});
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile
git add src/screens/BookingsScreen.js
git commit -m "feat: rewrite BookingsScreen in Liquid Glass & Silk luxury style"
```

---

## Task 5: Create BookingDetailScreen

**Files:**
- Create: `mobile/src/screens/BookingDetailScreen.js`

Shows full detail of a single booking: date/time + status card, per-service rows with original price (struck-through if discounted), discount badge, final price; total in gold serif; bonus-accrued card. Data source: `booking.services` (JSONB array from backend).

Service cost display logic:
- If `s.cost_to_pay` < `s.cost` → show strike-through `s.cost`, green discount badge `((s.cost - s.cost_to_pay)/s.cost * 100)%`, final price `s.cost_to_pay`
- Otherwise → show plain price `s.cost_to_pay ?? s.cost`

Total = `booking.price` (from `amount` column).

Bonus accrual is not stored per-visit in the current schema, so the bonus card is hidden unless a future field is added.

- [ ] **Step 1: Create BookingDetailScreen.js**

Create file `mobile/src/screens/BookingDetailScreen.js`:

```js
/**
 * BookingDetailScreen — "Liquid Glass & Silk" redesign
 * Aura Aesthetics Premium Clinic
 */
import React, { useEffect } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSpring,
  Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.88)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

// ─── Fade + slide entry ───────────────────────────────────────────────────────
function Reveal({ delay = 0, children }) {
  const opacity = useSharedValue(0);
  const ty      = useSharedValue(24);
  const scale   = useSharedValue(0.97);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }));
    ty.value      = withDelay(delay, withSpring(0, { damping: 20, stiffness: 120 }));
    scale.value   = withDelay(delay, withSpring(1, { damping: 20, stiffness: 120 }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }, { scale: scale.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    confirmed: { label: '✓ Подтверждена', bg: '#e8f5e9', color: '#4CAF50' },
    pending:   { label: '⏳ Ожидает',      bg: '#FFF8E1', color: '#FFA000' },
    cancelled: { label: '✗ Отменена',     bg: '#FFEBEE', color: '#E53935' },
    completed: { label: '✓ Завершена',    bg: '#e8f5e9', color: '#4CAF50' },
  };
  const cfg = map[status] || { label: status, bg: '#F5F5F5', color: T.stoneMid };
  return (
    <View style={{ backgroundColor: cfg.bg, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5 }}>
      <Text style={{ fontSize: 10, fontWeight: '600', color: cfg.color }}>{cfg.label}</Text>
    </View>
  );
}

// ─── Service row ──────────────────────────────────────────────────────────────
function ServiceRow({ service, isLast }) {
  const cost    = Number(service.cost     ?? 0);
  const payable = Number(service.cost_to_pay ?? cost);
  const hasDiscount = payable < cost && cost > 0;
  const discountPct = hasDiscount ? Math.round((cost - payable) / cost * 100) : 0;

  return (
    <View style={[styles.serviceRow, !isLast && styles.serviceRowBorder]}>
      <View style={styles.serviceRowTop}>
        <Text style={styles.serviceTitle} numberOfLines={2}>{service.title || '—'}</Text>
        {hasDiscount ? (
          <Text style={styles.serviceOrigPrice}>{cost.toLocaleString('ru-RU')} ₽</Text>
        ) : (
          <Text style={styles.serviceFinalPrice}>{payable.toLocaleString('ru-RU')} ₽</Text>
        )}
      </View>
      {hasDiscount && (
        <View style={styles.serviceRowBottom}>
          <View style={styles.discountBadge}>
            <Text style={styles.discountText}>Скидка {discountPct}%</Text>
          </View>
          <Text style={styles.serviceFinalPrice}>{payable.toLocaleString('ru-RU')} ₽</Text>
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function BookingDetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { bookingId } = route.params;

  const booking              = useClientStore((s) => s.bookingDetail);
  const bookingDetailLoading = useClientStore((s) => s.bookingDetailLoading);
  const fetchBookingDetail   = useClientStore((s) => s.fetchBookingDetail);

  useEffect(() => { fetchBookingDetail(bookingId); }, [bookingId]);

  // Parse services — backend returns JSONB; may come as string or array
  const services = React.useMemo(() => {
    if (!booking?.services) return [];
    if (Array.isArray(booking.services)) return booking.services;
    try { return JSON.parse(booking.services); } catch { return []; }
  }, [booking]);

  const specialist = React.useMemo(() => {
    if (!booking?.staff) return booking?.specialistName || null;
    const staff = Array.isArray(booking.staff) ? booking.staff : (() => { try { return JSON.parse(booking.staff); } catch { return []; } })();
    return staff[0]?.name || booking?.specialistName || null;
  }, [booking]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />
      <LinearGradient colors={[T.pearl, T.silk]} style={StyleSheet.absoluteFill} />

      {/* Blur header */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <BlurView intensity={60} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(245,243,240,0.92)', 'rgba(237,233,227,0.88)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.headerBorder} />
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={styles.backBtn}>← Мои записи</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Детали визита</Text>
      </View>

      {bookingDetailLoading || !booking ? (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color={T.champagne} />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Date + status card */}
          <Reveal delay={0}>
            <View style={[styles.card, styles.cardHighlight]}>
              <View style={styles.cardTopRow}>
                <View>
                  <Text style={styles.cardDate}>
                    {format(new Date(booking.dateTime), 'd MMMM, EEEE', { locale: ru })}
                  </Text>
                  <Text style={styles.cardTime}>
                    {format(new Date(booking.dateTime), 'HH:mm')}
                  </Text>
                </View>
                <StatusBadge status={booking.status} />
              </View>
              <View style={styles.divider} />
              {specialist && (
                <Text style={styles.specialist}>
                  💼 Специалист: <Text style={{ color: T.stone, fontWeight: '500' }}>{specialist}</Text>
                </Text>
              )}
            </View>
          </Reveal>

          {/* Services card */}
          {services.length > 0 && (
            <Reveal delay={80}>
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Выполненные процедуры</Text>
                {services.map((s, i) => (
                  <ServiceRow key={i} service={s} isLast={i === services.length - 1} />
                ))}
                {/* Total */}
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Итого оплачено</Text>
                  <Text style={styles.totalAmount}>
                    {Number(booking.price || 0).toLocaleString('ru-RU')} ₽
                  </Text>
                </View>
              </View>
            </Reveal>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: T.pearl },
  header: { paddingHorizontal: 20, paddingBottom: 12, zIndex: 10, overflow: 'hidden' },
  headerBorder: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(212,175,55,0.22)' },
  backBtn:      { fontSize: 14, color: T.champagne, marginBottom: 4 },
  headerTitle:  { fontSize: 26, color: T.stone, fontFamily: 'serif' },

  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flex: 1 },
  list:   { padding: 12, gap: 10 },

  card: {
    backgroundColor: T.glass,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.3)',
    padding: 16,
    shadowColor: 'rgba(100,90,70,1)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  cardHighlight: { borderColor: 'rgba(212,175,55,0.45)', shadowOpacity: 0.14 },

  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  cardDate:   { fontSize: 20, color: T.stone, fontFamily: 'serif' },
  cardTime:   { fontSize: 14, color: T.champagne, letterSpacing: 0.4, marginTop: 2 },
  divider:    { height: 1, backgroundColor: 'rgba(212,175,55,0.22)', marginBottom: 10 },
  specialist: { fontSize: 13, color: T.stoneMid },

  sectionTitle: { fontSize: 15, color: T.stone, fontFamily: 'serif', marginBottom: 12 },

  serviceRow:       { paddingVertical: 10 },
  serviceRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.15)' },
  serviceRowTop:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  serviceTitle:     { flex: 1, fontSize: 13, color: T.stone, fontWeight: '500', paddingRight: 8 },
  serviceOrigPrice: { fontSize: 13, color: T.stoneMid, textDecorationLine: 'line-through' },
  serviceFinalPrice:{ fontSize: 13, color: T.champagne, fontWeight: '600' },
  serviceRowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  discountBadge:    { backgroundColor: 'rgba(123,198,122,0.15)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  discountText:     { fontSize: 11, color: '#5A9A59', fontWeight: '500' },

  totalRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(212,175,55,0.2)' },
  totalLabel: { fontSize: 14, color: T.stone, fontFamily: 'serif' },
  totalAmount:{ fontSize: 20, color: T.champagne, fontFamily: 'serif', fontWeight: '600' },
});
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile
git add src/screens/BookingDetailScreen.js
git commit -m "feat: create BookingDetailScreen in Liquid Glass & Silk luxury style"
```

---

## Task 6: Update App.js — root Stack navigator

**Files:**
- Modify: `mobile/App.js`

The current navigator tree is `NavigationContainer > TabNavigator`. `BookingDetailScreen` must slide in from the right, above the tab bar. The fix: wrap `TabNavigator` in a root Stack and register `BookingDetail` as a root stack screen with `headerShown: false`.

- [ ] **Step 1: Import BookingDetailScreen and restructure App.js**

In `mobile/App.js`:

1. Add import after the existing screen imports:
```js
import BookingDetailScreen from './src/screens/BookingDetailScreen';
```

2. Rename the existing `Stack` (used in AuthNavigator) to `AuthStack`, or create a second stack. The cleanest approach: use ONE stack variable for the root, and a separate one for auth. Update as follows:

Replace:
```js
const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
```
With:
```js
const RootStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
```

3. Update `AuthNavigator` to use `AuthStack`:
```js
function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
    </AuthStack.Navigator>
  );
}
```

4. Add a `MainNavigator` that wraps TabNavigator + BookingDetailScreen:
```js
function MainNavigator() {
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="Tabs" component={TabNavigator} />
      <RootStack.Screen
        name="BookingDetail"
        component={BookingDetailScreen}
        options={{ animation: 'slide_from_right' }}
      />
    </RootStack.Navigator>
  );
}
```

5. In `App` return, change `{token ? <TabNavigator /> : <AuthNavigator />}` to:
```js
{token ? <MainNavigator /> : <AuthNavigator />}
```

- [ ] **Step 2: Verify the app still loads (Expo check)**

```bash
cd /root/mobile
npx expo export --platform ios --output-dir /tmp/expo-check 2>&1 | tail -5
```

If `expo export` is not available or takes too long, at minimum check JS parses:

```bash
node -e "
const b = require('@babel/core');
const fs = require('fs');
b.transformSync(fs.readFileSync('App.js','utf8'), {
  filename: 'App.js',
  presets: ['babel-preset-expo']
});
console.log('App.js OK');
" 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add App.js
git commit -m "feat: wrap TabNavigator in root Stack to support BookingDetail push navigation"
```

---

## Self-Review

**Spec coverage:**
| Requirement | Task |
|---|---|
| Real booking data from `records` table | Task 1 (list), Task 2 (detail) |
| Upcoming + past filter | Task 1 (`type` query param) |
| Tap card → detail screen | Task 4 (`navigation.navigate('BookingDetail')`) |
| Detail shows per-procedure prices + discounts | Task 5 (`ServiceRow` component) |
| Luxury design matching HomeScreen | Tasks 4 & 5 (T tokens, Skeleton, Reveal, PressCard) |
| Push from right navigation | Task 6 (`animation: 'slide_from_right'`) |

**Placeholder scan:** None found — all steps contain full code.

**Type consistency:**
- `booking.dateTime` — returned by backend as `visit_date as "dateTime"` ✓
- `booking.serviceName` / `booking.specialistName` — returned by list endpoint ✓
- `booking.services` / `booking.staff` — returned by detail endpoint ✓
- `fetchBookingDetail(bookingId)` — defined in Task 3, called in Task 5 ✓
- `navigation.navigate('BookingDetail', { bookingId })` in Task 4 matches `RootStack.Screen name="BookingDetail"` in Task 6 ✓
