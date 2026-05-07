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
import { useAppSettingsStore } from '../store/appSettingsStore';
import { format, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';

// Hermes (iOS) не парсит "YYYY-MM-DD HH:mm:ss" — заменяем пробел на T
function parseDate(value) {
  if (!value) return new Date(NaN);
  if (typeof value === 'string') {
    return new Date(value.replace(' ', 'T'));
  }
  return new Date(value);
}
function safeFmt(value, fmt, opts) {
  const d = parseDate(value);
  if (isNaN(d.getTime())) return '—';
  return format(d, fmt, opts);
}

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
    waiting:   { label: '⏳ Ожидание',    bg: '#FFF8E1', color: '#FFA000' },
    pending:   { label: '⏳ Ожидание',    bg: '#FFF8E1', color: '#FFA000' },
    confirmed: { label: '✓ Подтвердил',  bg: '#e8f5e9', color: '#4CAF50' },
    completed: { label: '✓ Пришел',      bg: '#e8f5e9', color: '#2E7D32' },
    no_show:   { label: '✗ Не пришел',   bg: '#FFEBEE', color: '#E53935' },
    cancelled: { label: '✗ Отменена',    bg: '#FFEBEE', color: '#E53935' },
  };
  const cfg = map[status] || { label: status, bg: '#F5F5F5', color: T.stoneMid };
  return (
    <View style={{ backgroundColor: cfg.bg, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ fontSize: 10, fontWeight: '600', color: cfg.color }}>{cfg.label}</Text>
    </View>
  );
}

// ─── Pulsing prescription badge ──────────────────────────────────────────────
function PulsingPrescriptionBadge() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => cancelAnimation(pulse);
  }, []);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0, 0.7]),
    transform: [{ scale: interpolate(pulse.value, [0, 1], [0.6, 1.5]) }],
  }));
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 1.15]) }],
  }));
  return (
    <View style={{ marginLeft: 6, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 5 }}>
      <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[{
          position: 'absolute',
          width: 20, height: 20, borderRadius: 10,
          backgroundColor: 'rgba(212,175,55,0.35)',
        }, ringStyle]} />
        <Animated.View style={[{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: T.champagne,
        }, dotStyle]} />
      </View>
      <View style={{
        backgroundColor: 'rgba(212,175,55,0.12)',
        borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3,
        borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)',
      }}>
        <Text style={{ fontSize: 10, color: '#D4AF37', fontWeight: '600' }}>Назначения</Text>
      </View>
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
                  {parseDate(booking.dateTime) > new Date() ? 'Следующий визит' : 'Последний визит'}
                </Text>
              )}
              <Text style={styles.cardDate}>
                {(() => {
                  const d = parseDate(booking.dateTime);
                  const isOtherYear = !isNaN(d.getTime()) && d.getFullYear() !== new Date().getFullYear();
                  return safeFmt(booking.dateTime, isOtherYear ? 'd MMMM yyyy, EEEE' : 'd MMMM, EEEE', { locale: ru });
                })()}
              </Text>
              <Text style={styles.cardTime}>
                {safeFmt(booking.dateTime, 'HH:mm')}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <StatusBadge status={booking.status} />
              {booking.hasPrescription && <PulsingPrescriptionBadge />}
            </View>
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

// ─── Group records from the same visit (≤4 h apart on same day) ───────────────
function groupVisits(bookings) {
  if (!bookings || bookings.length === 0) return [];
  const sorted = [...bookings].sort((a, b) => parseDate(a.dateTime) - parseDate(b.dateTime));
  const groups = [];
  let cur = null;
  for (const b of sorted) {
    const d = parseDate(b.dateTime);
    if (!cur) {
      cur = { ids: [b.id], items: [b] };
    } else {
      const prev = parseDate(cur.items[cur.items.length - 1].dateTime);
      const diffH = (d - prev) / 3600000;
      if (d.toDateString() === prev.toDateString() && diffH <= 4) {
        cur.ids.push(b.id);
        cur.items.push(b);
      } else {
        groups.push(cur);
        cur = { ids: [b.id], items: [b] };
      }
    }
  }
  if (cur) groups.push(cur);
  groups.reverse(); // newest first

  return groups.map(({ ids, items }) => {
    const first = items[0];
    const totalPrice = items.reduce((s, x) => s + Number(x.price || 0), 0);
    const names = items.map((x) => x.serviceName).filter(Boolean);
    const serviceName = names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] || '—');
    return { id: first.id, ids, dateTime: first.dateTime, serviceName, specialistName: first.specialistName, status: first.status, price: totalPrice || null, hasPrescription: items.some(x => x.hasPrescription), prescriptionId: items.find(x => x.prescriptionId)?.prescriptionId || null };
  });
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function BookingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('upcoming');

  const bookings        = useClientStore((s) => s.bookings);
  const bookingsLoading = useClientStore((s) => s.bookingsLoading);
  const fetchBookings   = useClientStore((s) => s.fetchBookings);
  const clinicName      = useAppSettingsStore((s) => s.clinicName);

  useEffect(() => { fetchBookings(filter); }, [filter]);

  const onRefresh = useCallback(() => fetchBookings(filter), [filter]);

  const grouped = React.useMemo(() => groupVisits(bookings), [bookings]);

  const handleCardPress = (booking) => {
    navigation.navigate('BookingDetail', { bookingId: booking.id, bookingIds: booking.ids });
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
        {!!clinicName && <Text style={styles.headerSub}>{clinicName}</Text>}
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
          grouped.map((booking, i) => (
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
