/**
 * BonusesScreen — "Liquid Glass & Silk" redesign
 * Aura Aesthetics Premium Clinic
 */
import React, { useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
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
import { useClientStore } from '../store/clientStore';
import { useAppSettingsStore } from '../store/appSettingsStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import LoyaltyRing from '../components/LoyaltyRing';

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.88)',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
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
  const ty = useSharedValue(24);
  const scale = useSharedValue(0.97);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }));
    ty.value      = withDelay(delay, withSpring(0, { damping: 20, stiffness: 100 }));
    scale.value   = withDelay(delay, withSpring(1, { damping: 20, stiffness: 100 }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }, { scale: scale.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function safeDateFmt(value) {
  try {
    const d = value ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) return '—';
    return format(d, 'd MMM yyyy', { locale: ru });
  } catch {
    return '—';
  }
}

// ─── Transaction row ──────────────────────────────────────────────────────────
function TxnRow({ txn, isLast }) {
  const isAccrual = txn.type === 'accrual' || txn.type === 'earned';
  return (
    <View style={[styles.txnRow, !isLast && styles.txnRowBorder]}>
      <View style={styles.txnLeft}>
        <View style={[styles.txnDot, { backgroundColor: isAccrual ? 'rgba(76,175,80,0.18)' : 'rgba(229,57,53,0.14)' }]}>
          <Text style={{ fontSize: 14 }}>{isAccrual ? '＋' : '－'}</Text>
        </View>
        <View style={styles.txnInfo}>
          <Text style={styles.txnTitle} numberOfLines={2}>{txn.description || (isAccrual ? 'Начисление' : 'Списание')}</Text>
          <Text style={styles.txnDate}>{safeDateFmt(txn.createdAt)}</Text>
        </View>
      </View>
      <Text style={[styles.txnAmount, { color: isAccrual ? '#4CAF50' : '#E53935' }]}>
        {isAccrual ? '+' : '−'}{Number(txn.amount).toLocaleString('ru-RU')} ₽
      </Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function BonusesScreen() {
  const insets = useSafeAreaInsets();

  const bonuses      = useClientStore((s) => s.bonuses);
  const bonusHistory = useClientStore((s) => s.bonusHistory);
  const bonusLoading = useClientStore((s) => s.bonusLoading);
  const fetchBonuses = useClientStore((s) => s.fetchBonuses);
  const clinicName   = useAppSettingsStore((s) => s.clinicName);

  useEffect(() => { fetchBonuses(); }, []);

  const onRefresh = useCallback(() => fetchBonuses(), []);

  return (
    <View style={styles.root}>
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
        <Text style={styles.headerTitle}>Бонусы</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
        refreshControl={
          <RefreshControl refreshing={bonusLoading} onRefresh={onRefresh} tintColor={T.champagne} />
        }
        showsVerticalScrollIndicator={false}
      >
        {bonusLoading && !bonuses ? (
          // Skeleton
          <View style={{ gap: 10, padding: 12 }}>
            <View style={[styles.card, { padding: 20, gap: 14 }]}>
              <Skeleton width="50%" height={12} />
              <Skeleton width="40%" height={38} />
              <Skeleton width="100%" height={1} />
              <Skeleton width="60%" height={12} />
            </View>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.card, { padding: 16, gap: 10 }]}>
                <Skeleton width="70%" height={13} />
                <Skeleton width="40%" height={11} />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.inner}>
            {/* Balance card */}
            {bonuses && (
              <Reveal delay={0}>
                <View style={[styles.card, styles.balanceCard]}>
                  <Text style={styles.balanceLabel}>Бонусный баланс</Text>
                  <View style={styles.balanceRow}>
                    <Text style={styles.balanceValue}>
                      {Number(bonuses.balance ?? 0).toLocaleString('ru-RU')}
                    </Text>
                    <Text style={styles.balanceCur}> ₽</Text>
                  </View>
                  <View style={styles.divider} />
                  <View style={styles.ringWrap}>
                    <LoyaltyRing
                      totalSpent={bonuses.totalSpent || 0}
                      currentLevel={bonuses.currentLevel}
                      nextLevel={bonuses.nextLevel}
                    />
                  </View>
                </View>
              </Reveal>
            )}

            {/* History */}
            {bonusHistory && bonusHistory.length > 0 ? (
              <Reveal delay={80}>
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>История операций</Text>
                  {bonusHistory.map((txn, i) => (
                    <TxnRow key={txn.id ?? i} txn={txn} isLast={i === bonusHistory.length - 1} />
                  ))}
                </View>
              </Reveal>
            ) : (
              !bonusLoading && (
                <View style={styles.empty}>
                  <Text style={styles.emptyIcon}>📋</Text>
                  <Text style={styles.emptyText}>История операций пуста</Text>
                </View>
              )
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: T.pearl },
  header: { paddingHorizontal: 20, paddingBottom: 12, zIndex: 10, overflow: 'hidden' },
  headerBorder: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(212,175,55,0.22)' },
  headerSub:  { fontSize: 11, color: T.stoneMid, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 2 },
  headerTitle:{ fontSize: 26, color: T.stone, fontFamily: 'serif' },

  scroll: { flex: 1 },
  list:   { flexGrow: 1 },
  inner:  { padding: 12, gap: 10 },

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
  balanceCard:  { borderColor: 'rgba(212,175,55,0.45)', shadowOpacity: 0.14 },
  balanceLabel: { fontSize: 11, color: T.stoneMid, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  balanceRow:   { flexDirection: 'row', alignItems: 'baseline', marginBottom: 14 },
  balanceValue: { fontSize: 44, color: T.champagne, fontFamily: 'serif', fontWeight: '600' },
  balanceCur:   { fontSize: 20, color: T.champagne, fontFamily: 'serif' },
  divider:      { height: 1, backgroundColor: 'rgba(212,175,55,0.22)', marginBottom: 12 },
  ringWrap:     { paddingTop: 16, paddingBottom: 4, alignItems: 'center' },

  sectionTitle: { fontSize: 15, color: T.stone, fontFamily: 'serif', marginBottom: 8 },

  txnRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  txnRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.15)' },
  txnLeft:      { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  txnDot:       { width: 34, height: 34, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  txnInfo:      { flex: 1 },
  txnTitle:     { fontSize: 13, color: T.stone, fontWeight: '500', marginBottom: 2 },
  txnDate:      { fontSize: 11, color: T.stoneFaint },
  txnAmount:    { fontSize: 13, fontWeight: '600' },

  empty:     { alignItems: 'center', paddingVertical: 60 },
  emptyIcon: { fontSize: 44, marginBottom: 12 },
  emptyText: { fontSize: 16, color: T.stoneMid },
});
