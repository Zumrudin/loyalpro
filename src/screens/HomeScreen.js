/**
 * HomeScreen — "Liquid Glass & Silk" luxury redesign
 * Aura Aesthetics Premium Clinic
 *
 * Stack: React Native · Expo · react-native-reanimated 3 · expo-linear-gradient
 *        expo-blur · expo-sensors (gyroscope parallax) · expo-haptics
 *        @expo-google-fonts/playfair-display · @expo-google-fonts/inter
 */
import React, { useEffect, useCallback, useRef, useState } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  Platform,
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
import { Gyroscope } from 'expo-sensors';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../store/authStore';
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

const { width, height } = Dimensions.get('window');

// ─── Design tokens ──────────────────────────────────────────────────────────
const T = {
  // Backgrounds
  pearl:      '#F5F3F0',      // main bg — warm pearl
  silk:       '#EDE9E3',      // slightly deeper silk
  glass:      'rgba(255,252,248,0.72)', // glass card fill
  glassBorder:'rgba(255,255,255,0.85)',

  // Champagne palette
  champagne:  '#D4AF37',
  champLight: '#F0D882',
  champDark:  '#A8881C',
  champGlow:  'rgba(212,175,55,0.18)',

  // Stone/taupe
  stone:      '#4A4540',      // deep graphite-taupe
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  stoneMuted: 'rgba(74,69,64,0.60)',

  // Shadow
  shadow:     'rgba(100,90,70,0.12)',
  shadowDeep: 'rgba(100,90,70,0.20)',

  // Pearlescent glow tones
  glowA:      'rgba(240,216,130,0.22)',  // warm gold
  glowB:      'rgba(220,210,240,0.18)',  // soft lavender
  glowC:      'rgba(190,225,220,0.15)',  // aqua pearl
};

// ─── Shimmer skeleton ───────────────────────────────────────────────────────
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
      style={[
        {
          width: w,
          height: h,
          borderRadius: radius,
          overflow: 'hidden',
        },
        style,
        animStyle,
      ]}
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

// ─── Fade + scale entry wrapper ─────────────────────────────────────────────
function Reveal({ delay = 0, from = 'bottom', children }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(from === 'bottom' ? 32 : from === 'top' ? -20 : 0);
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

// ─── Press card with haptic micro-interaction ────────────────────────────────
function PressCard({ style, onPress, children, haptic = true }) {
  const scale = useSharedValue(1);
  const shadow = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    shadowOpacity: interpolate(scale.value, [0.97, 1], [0.06, 0.14]),
  }));

  const handleIn = () => {
    scale.value  = withSpring(0.975, { damping: 18, stiffness: 200 });
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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

// ─── Parallax glow orbs (gyroscope driven) ──────────────────────────────────
function ParallaxGlow() {
  const gx = useSharedValue(0);
  const gy = useSharedValue(0);
  const sub = useRef(null);

  useEffect(() => {
    Gyroscope.setUpdateInterval(16);
    sub.current = Gyroscope.addListener(({ x, y }) => {
      gx.value = withTiming(gx.value + y * 6, { duration: 120 });
      gy.value = withTiming(gy.value + x * 6, { duration: 120 });
      // Clamp drift
      if (Math.abs(gx.value) > 40) gx.value = 40 * Math.sign(gx.value);
      if (Math.abs(gy.value) > 40) gy.value = 40 * Math.sign(gy.value);
    });
    return () => sub.current?.remove();
  }, []);

  const orbA = useAnimatedStyle(() => ({
    transform: [{ translateX: gx.value * 0.9 }, { translateY: gy.value * 0.7 }],
  }));
  const orbB = useAnimatedStyle(() => ({
    transform: [{ translateX: -gx.value * 0.6 }, { translateY: -gy.value * 0.8 }],
  }));
  const orbC = useAnimatedStyle(() => ({
    transform: [{ translateX: gx.value * 0.4 }, { translateY: gy.value * 1.0 }],
  }));

  return (
    <>
      <Animated.View style={[gls.orb, gls.orbA, orbA]} pointerEvents="none" />
      <Animated.View style={[gls.orb, gls.orbB, orbB]} pointerEvents="none" />
      <Animated.View style={[gls.orb, gls.orbC, orbC]} pointerEvents="none" />
    </>
  );
}

const gls = StyleSheet.create({
  orb: { position: 'absolute', borderRadius: 999 },
  orbA: { width: 320, height: 320, top: -80, right: -80, backgroundColor: T.glowA },
  orbB: { width: 260, height: 260, top: 220, left: -100, backgroundColor: T.glowB },
  orbC: { width: 200, height: 200, top: 480, right: -40, backgroundColor: T.glowC },
});

// ─── Service pill (horizontal scroll) ───────────────────────────────────────
const SERVICES = [
  { id: 1, icon: 'sparkles-outline',     label: 'Инъекции',    tint: '#D4AF37' },
  { id: 2, icon: 'flower-outline',       label: 'Уход',        tint: '#C8A4A4' },
  { id: 3, icon: 'sunny-outline',        label: 'Лазер',       tint: '#B8C4D0' },
  { id: 4, icon: 'water-outline',        label: 'Гидратация',  tint: '#9AC4C4' },
  { id: 5, icon: 'ribbon-outline',       label: 'Контуры',     tint: '#C4A4C4' },
];

function ServicePill({ icon, label, tint, delay, onPress }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Reveal delay={delay}>
      <Animated.View style={animStyle}>
        <TouchableOpacity
          style={[sp.pill, { borderColor: tint + '55' }]}
          onPress={() => {
            scale.value = withSequence(withSpring(0.92), withSpring(1));
            Haptics.selectionAsync();
            onPress?.();
          }}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={[tint + '22', tint + '08']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          <View style={[sp.iconWrap, { backgroundColor: tint + '25' }]}>
            <Ionicons name={icon} size={18} color={tint} />
          </View>
          <Text style={sp.label}>{label}</Text>
        </TouchableOpacity>
      </Animated.View>
    </Reveal>
  );
}

const sp = StyleSheet.create({
  pill: {
    width: 88, minHeight: 96,
    borderRadius: 20, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, paddingHorizontal: 8,
    marginRight: 12,
    overflow: 'hidden',
    backgroundColor: T.glass,
    shadowColor: T.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 3,
  },
  iconWrap: { width: 36, height: 36, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  label: { fontSize: 11, color: T.stoneMid, fontFamily: undefined, letterSpacing: 0.4, textAlign: 'center' },
});

// ─── HomeScreen ──────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const user         = useAuthStore((st) => st.user);
  const profile      = useClientStore((st) => st.profile);
  const bonuses      = useClientStore((st) => st.bonuses);
  const bookings     = useClientStore((st) => st.bookings);
  const profileLoading   = useClientStore((st) => st.profileLoading);
  const bonusLoading     = useClientStore((st) => st.bonusLoading);
  const bookingsLoading  = useClientStore((st) => st.bookingsLoading);
  const fetchProfile  = useClientStore((st) => st.fetchProfile);
  const fetchBonuses  = useClientStore((st) => st.fetchBonuses);
  const fetchBookings = useClientStore((st) => st.fetchBookings);

  const loadData = useCallback(() =>
    Promise.all([fetchProfile(), fetchBonuses(), fetchBookings('upcoming')]),
  [fetchProfile, fetchBonuses, fetchBookings]);

  useEffect(() => { loadData(); }, [loadData]);

  const isLoading   = profileLoading || bonusLoading || bookingsLoading;
  const nextBooking = bookings?.length > 0 ? bookings[0] : null;
  const name        = profile?.name || user?.name || 'Клиент';
  const firstName   = name.split(' ')[0];

  const hour     = new Date().getHours();
  const greeting = hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  // Book button fill animation
  const btnFill = useSharedValue(0);
  const btnStyle = useAnimatedStyle(() => ({
    opacity: interpolate(btnFill.value, [0, 1], [0.9, 1]),
    transform: [{ scale: interpolate(btnFill.value, [0, 1], [1, 1.03]) }],
  }));

  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      {/* Parallax ambient orbs */}
      <ParallaxGlow />

      {/* Sticky blur header that content scrolls under */}
      <Animated.View style={[s.stickyHeader, { paddingTop: insets.top }]} pointerEvents="none">
        <BlurView intensity={60} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={[T.pearl + 'EE', T.pearl + '00']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
        />
      </Animated.View>

      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 72 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Hero greeting ─────────────────────────────── */}
        <Reveal delay={0} from="top">
          <View style={s.hero}>
            <Text style={s.heroSub}>{greeting}</Text>
            <Text style={s.heroName}>{firstName}</Text>
            <View style={s.heroDivider} />
          </View>
        </Reveal>

        {/* ── Booking card ──────────────────────────────── */}
        <Reveal delay={100}>
          {isLoading ? (
            <View style={s.skeletonCard}>
              <Skeleton width={120} height={12} radius={6} style={{ marginBottom: 16 }} />
              <Skeleton width={width - 80} height={20} radius={8} style={{ marginBottom: 10 }} />
              <Skeleton width={160} height={14} radius={6} />
            </View>
          ) : nextBooking ? (
            <PressCard style={s.bookingCard} onPress={() => navigation.navigate('Bookings')}>
              {/* Gold border glow */}
              <LinearGradient
                colors={[T.champagne + '60', T.champLight + '20', 'transparent']}
                style={[StyleSheet.absoluteFill, { borderRadius: 24 }]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
              <View style={s.bookingCardInner}>
                <View style={s.bookingTop}>
                  <View style={s.bookingBadge}>
                    <View style={s.bookingDot} />
                    <Text style={s.bookingBadgeText}>Следующий визит</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={T.champagne} />
                </View>
                <Text style={s.bookingDate}>
                  {safeFmt(nextBooking.dateTime, "d MMMM, EEEE", { locale: ru })}
                </Text>
                <Text style={s.bookingTime}>
                  {safeFmt(nextBooking.dateTime, "HH:mm")}
                </Text>
                <View style={s.bookingDividerLine} />
                <View style={s.bookingMeta}>
                  <Text style={s.bookingService}>{nextBooking.serviceName}</Text>
                  <Text style={s.bookingSpec}>{nextBooking.specialistName}</Text>
                </View>
              </View>
            </PressCard>
          ) : (
            <PressCard style={s.emptyCard} onPress={() => navigation.navigate('Bookings')}>
              <LinearGradient
                colors={[T.champagne + '30', 'transparent']}
                style={[StyleSheet.absoluteFill, { borderRadius: 24 }]}
              />
              <Text style={s.emptyCardTitle}>Записей нет</Text>
              <Text style={s.emptyCardSub}>Запишитесь к нашим{'\n'}специалистам сегодня</Text>
              <Animated.View style={btnStyle}>
                <TouchableOpacity
                  style={s.bookNowBtn}
                  onPressIn={() => { btnFill.value = withSpring(1); }}
                  onPressOut={() => { btnFill.value = withSpring(0); }}
                  onPress={() => navigation.navigate('Bookings')}
                  activeOpacity={1}
                >
                  <LinearGradient
                    colors={[T.champagne, T.champDark]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <Text style={s.bookNowText}>Записаться</Text>
                  <Ionicons name="arrow-forward" size={15} color="#fff" style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              </Animated.View>
            </PressCard>
          )}
        </Reveal>

        {/* ── Bonuses row ───────────────────────────────── */}
        <Reveal delay={180}>
          {isLoading ? (
            <Skeleton width="100%" height={80} radius={20} style={{ marginBottom: 24 }} />
          ) : (
            <PressCard style={s.bonusRow} onPress={() => navigation.navigate('Bonuses')}>
              <LinearGradient
                colors={[T.champGlow, 'transparent']}
                style={[StyleSheet.absoluteFill, { borderRadius: 20 }]}
              />
              <View style={s.bonusLeft}>
                <Ionicons name="diamond-outline" size={18} color={T.champagne} />
                <View style={{ marginLeft: 12 }}>
                  <Text style={s.bonusLabel}>Бонусный баланс</Text>
                  <Text style={s.bonusValue}>{bonuses?.balance ?? 0} ₽</Text>
                </View>
              </View>
              <View style={s.bonusRight}>
                <Text style={s.bonusLevel}>{bonuses?.level || 'Новичок'}</Text>
                <Ionicons name="chevron-forward" size={14} color={T.champagne} />
              </View>
            </PressCard>
          )}
        </Reveal>

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

        {/* ── Quick links grid ──────────────────────────── */}
        <Reveal delay={500}>
          <Text style={[s.sectionTitle, { marginBottom: 16 }]}>Кабинет</Text>
        </Reveal>
        <View style={s.quickGrid}>
          {[
            { icon: 'calendar-outline',       label: 'История',     nav: 'Bookings',      delay: 540 },
            { icon: 'person-outline',          label: 'Профиль',     nav: 'Profile',       delay: 580 },
            { icon: 'notifications-outline',   label: 'Уведомления', nav: 'Notifications', delay: 620 },
            { icon: 'gift-outline',            label: 'Бонусы',      nav: 'Bonuses',       delay: 660 },
          ].map(({ icon, label, nav, delay }) => (
            <Reveal key={label} delay={delay}>
              <PressCard style={s.quickCard} onPress={() => navigation.navigate(nav)}>
                <View style={s.quickIconWrap}>
                  <Ionicons name={icon} size={20} color={T.champagne} />
                </View>
                <Text style={s.quickLabel}>{label}</Text>
              </PressCard>
            </Reveal>
          ))}
        </View>

        {/* ── Referral banner ───────────────────────────── */}
        <Reveal delay={700}>
          <View style={s.refBanner}>
            <LinearGradient
              colors={[T.champagne + '28', T.champLight + '10']}
              style={[StyleSheet.absoluteFill, { borderRadius: 20 }]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            />
            <View style={s.refLeft}>
              <Text style={s.refTitle}>Пригласите подругу</Text>
              <Text style={s.refSub}>+500 ₽ бонусов вам обеим</Text>
            </View>
            <TouchableOpacity
              style={s.refBtn}
              onPress={() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)}
            >
              <Ionicons name="share-social-outline" size={16} color={T.champagne} />
            </TouchableOpacity>
          </View>
        </Reveal>

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const CARD_RADIUS = 24;
const QUICK_W     = (width - 56) / 2;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },
  scroll: { paddingHorizontal: 20, paddingBottom: 24 },

  // Sticky blur header (visual only — no content)
  stickyHeader: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 110, zIndex: 10, overflow: 'hidden',
  },

  // Hero
  hero: { marginBottom: 28 },
  heroSub: {
    fontSize: 13, color: T.stoneMid,
    fontFamily: undefined, letterSpacing: 1.2,
    textTransform: 'uppercase', marginBottom: 4,
  },
  heroName: {
    fontSize: 36, color: T.stone,
    fontFamily: 'serif',
    letterSpacing: 0.5, lineHeight: 42,
  },
  heroDivider: {
    width: 40, height: 1.5, backgroundColor: T.champagne,
    marginTop: 10, borderRadius: 2,
  },

  // Skeleton card placeholder
  skeletonCard: {
    borderRadius: CARD_RADIUS, backgroundColor: T.glass, padding: 24,
    marginBottom: 16, borderWidth: 1, borderColor: T.glassBorder,
  },

  // Booking card
  bookingCard: {
    borderRadius: CARD_RADIUS, marginBottom: 16, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.champagne + '45',
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18, shadowRadius: 20, elevation: 6,
  },
  bookingCardInner: { padding: 24 },
  bookingTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  bookingBadge: { flexDirection: 'row', alignItems: 'center' },
  bookingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#7BC67A', marginRight: 6 },
  bookingBadgeText: { fontSize: 11, color: T.stoneMid, fontFamily: undefined, letterSpacing: 0.8, textTransform: 'uppercase' },
  bookingDate: { fontSize: 22, color: T.stone, fontFamily: 'serif', marginBottom: 2 },
  bookingTime: { fontSize: 13, color: T.champagne, fontFamily: undefined, letterSpacing: 0.5, marginBottom: 16 },
  bookingDividerLine: { height: 1, backgroundColor: T.champagne + '30', marginBottom: 14 },
  bookingMeta: {},
  bookingService: { fontSize: 15, color: T.stone, fontFamily: undefined, marginBottom: 3 },
  bookingSpec:   { fontSize: 13, color: T.stoneMid, fontFamily: undefined },

  // Empty card
  emptyCard: {
    borderRadius: CARD_RADIUS, padding: 28, marginBottom: 16, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.champagne + '35',
    shadowColor: T.shadow, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12, shadowRadius: 18, elevation: 4,
    alignItems: 'flex-start',
  },
  emptyCardTitle: { fontSize: 20, color: T.stone, fontFamily: 'serif', marginBottom: 6 },
  emptyCardSub:   { fontSize: 13, color: T.stoneMid, fontFamily: undefined, lineHeight: 20, marginBottom: 20 },
  bookNowBtn: {
    flexDirection: 'row', alignItems: 'center',
    overflow: 'hidden', borderRadius: 14,
    paddingHorizontal: 22, paddingVertical: 12,
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35, shadowRadius: 10,
  },
  bookNowText: { fontSize: 14, fontFamily: undefined, color: '#fff', letterSpacing: 0.5 },

  // Bonus row
  bonusRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 20, padding: 18, marginBottom: 28, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.champagne + '40',
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10, shadowRadius: 14, elevation: 3,
  },
  bonusLeft:  { flexDirection: 'row', alignItems: 'center' },
  bonusLabel: { fontSize: 11, color: T.stoneMid, fontFamily: undefined, letterSpacing: 0.5, marginBottom: 2 },
  bonusValue: { fontSize: 18, color: T.stone, fontFamily: 'serif' },
  bonusRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bonusLevel: { fontSize: 12, color: T.champagne, fontFamily: undefined, letterSpacing: 0.5 },

  // Section
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 },
  sectionTitle: { fontSize: 16, color: T.stone, fontFamily: 'serif', letterSpacing: 0.3 },
  sectionLink:  { fontSize: 12, color: T.champagne, fontFamily: undefined, letterSpacing: 0.5 },

  // Services scroll
  servicesScroll: { paddingLeft: 0, paddingRight: 20, marginBottom: 28 },

  // Quick grid
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
  quickCard: {
    width: QUICK_W, borderRadius: 20, padding: 18,
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    shadowColor: T.shadow, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 2,
    overflow: 'hidden',
  },
  quickIconWrap: {
    width: 40, height: 40, borderRadius: 13,
    backgroundColor: T.champGlow, borderWidth: 1, borderColor: T.champagne + '30',
    justifyContent: 'center', alignItems: 'center', marginBottom: 10,
  },
  quickLabel: { fontSize: 13, color: T.stone, fontFamily: undefined, letterSpacing: 0.3 },

  // Referral
  refBanner: {
    borderRadius: 20, padding: 20, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.champagne + '35',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  refLeft: {},
  refTitle: { fontSize: 15, color: T.stone, fontFamily: 'serif', marginBottom: 3 },
  refSub:   { fontSize: 12, color: T.stoneMid, fontFamily: undefined },
  refBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: T.champGlow, borderWidth: 1, borderColor: T.champagne + '40',
    justifyContent: 'center', alignItems: 'center',
  },
});
