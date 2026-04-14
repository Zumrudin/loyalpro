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

function parseDate(value) {
  if (!value) return new Date(NaN);
  if (typeof value === 'string') return new Date(value.replace(' ', 'T'));
  return new Date(value);
}
function safeFmt(value, fmt, opts) {
  const d = parseDate(value);
  if (isNaN(d.getTime())) return '—';
  return format(d, fmt, opts);
}

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
    waiting:   { label: '⏳ Ожидание',    bg: '#FFF8E1', color: '#FFA000' },
    pending:   { label: '⏳ Ожидание',    bg: '#FFF8E1', color: '#FFA000' },
    confirmed: { label: '✓ Подтвердил',  bg: '#e8f5e9', color: '#4CAF50' },
    completed: { label: '✓ Пришел',      bg: '#e8f5e9', color: '#2E7D32' },
    no_show:   { label: '✗ Не пришел',   bg: '#FFEBEE', color: '#E53935' },
    cancelled: { label: '✗ Отменена',    bg: '#FFEBEE', color: '#E53935' },
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
  const origCost = Number(service.first_cost ?? service.cost ?? 0);
  const payable  = Number(service.cost_to_pay ?? origCost);
  const hasDiscount = payable < origCost && origCost > 0;
  const discountPct = hasDiscount ? Math.round((origCost - payable) / origCost * 100) : 0;

  return (
    <View style={[styles.serviceRow, !isLast && styles.serviceRowBorder]}>
      <View style={styles.serviceRowTop}>
        <Text style={styles.serviceTitle} numberOfLines={2}>{service.title || '—'}</Text>
        {hasDiscount ? (
          <Text style={styles.serviceOrigPrice}>{origCost.toLocaleString('ru-RU')} ₽</Text>
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
                    {safeFmt(booking.dateTime, 'd MMMM, EEEE', { locale: ru })}
                  </Text>
                  <Text style={styles.cardTime}>
                    {safeFmt(booking.dateTime, 'HH:mm')}
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

          {/* Bonuses card */}
          {(Number(booking.bonusAccrued) > 0) && (
            <Reveal delay={160}>
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Бонусы</Text>
                <View style={styles.bonusRow}>
                  <Text style={styles.bonusLabel}>Начислено</Text>
                  <Text style={styles.bonusAccrued}>+{Number(booking.bonusAccrued).toLocaleString('ru-RU')} ₽</Text>
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

  bonusRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  bonusLabel:  { fontSize: 13, color: T.stoneMid },
  bonusAccrued:{ fontSize: 13, color: '#4CAF50', fontWeight: '600' },
});
