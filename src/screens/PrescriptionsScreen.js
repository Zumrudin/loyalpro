/**
 * PrescriptionsScreen — список назначений клиента
 * Aura Aesthetics Premium Clinic — "Liquid Glass & Silk"
 */
import React, { useEffect, useCallback } from 'react';
import {
  View, ScrollView, Text, StyleSheet,
  TouchableOpacity, RefreshControl, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withTiming, withDelay, withSpring, Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

function parseDate(v) {
  if (!v) return new Date(NaN);
  if (typeof v === 'string') return new Date(v.replace(' ', 'T'));
  return new Date(v);
}
function safeFmt(v, fmt, opts) {
  const d = parseDate(v);
  if (isNaN(d.getTime())) return '—';
  return format(d, fmt, opts);
}

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  shadow:     'rgba(100,90,70,0.12)',
};

function Reveal({ delay = 0, children }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) }));
    ty.value = withDelay(delay, withSpring(0, { damping: 22, stiffness: 130 }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function PrescriptionCard({ item, onPress, index }) {
  const roleLabel = item.specialistRole === 'specialist' ? 'Специалист' : (item.specialistRole || '');
  return (
    <Reveal delay={index * 60}>
      <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.82}>
        <BlurView intensity={28} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,252,248,0.55)', 'rgba(237,233,227,0.35)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.cardInner}>
          <View style={s.cardTop}>
            <View style={s.dateBadge}>
              <Text style={s.dateDay}>{safeFmt(item.createdAt, 'd')}</Text>
              <Text style={s.dateMon}>{safeFmt(item.createdAt, 'MMM', { locale: ru })}</Text>
            </View>
            <View style={s.cardMeta}>
              <Text style={s.specialistName}>{item.specialistName || '—'}</Text>
              {!!roleLabel && <Text style={s.specialistRole}>{roleLabel}</Text>}
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.champagne} />
          </View>
          {item.itemsCount > 0 && (
            <View style={s.countBadge}>
              <Text style={s.countText}>{item.itemsCount} назначений</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Reveal>
  );
}

export default function PrescriptionsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const prescriptions = useClientStore(st => st.prescriptions);
  const loading = useClientStore(st => st.prescriptionsLoading);
  const fetchPrescriptions = useClientStore(st => st.fetchPrescriptions);

  useEffect(() => { fetchPrescriptions(); }, []);

  const onRefresh = useCallback(() => { fetchPrescriptions(); }, [fetchPrescriptions]);

  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" />
      <LinearGradient colors={[T.pearl, T.silk, T.pearl]} style={StyleSheet.absoluteFill} />

      <View style={[s.header, { paddingTop: insets.top + 10 }]}>
        <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={T.champagne} />
          <Text style={s.backText}>Назад</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Назначения</Text>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.champagne} />}
      >
        {!loading && prescriptions.length === 0 && (
          <Reveal delay={100}>
            <View style={s.empty}>
              <Ionicons name="document-text-outline" size={44} color={T.stoneFaint} />
              <Text style={s.emptyText}>Назначений пока нет</Text>
            </View>
          </Reveal>
        )}
        {prescriptions.map((item, i) => (
          <PrescriptionCard
            key={item.id}
            item={item}
            index={i}
            onPress={() => navigation.navigate('PrescriptionDetail', { prescriptionId: item.id })}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: T.pearl },
  header: {
    paddingHorizontal: 20, paddingBottom: 14,
    zIndex: 10, overflow: 'hidden',
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.18)',
  },
  backBtn:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  backText: { fontSize: 14, color: T.champagne, marginLeft: 2 },
  headerTitle: { fontSize: 26, color: T.stone, fontFamily: 'serif' },
  scroll: { flex: 1 },
  list:   { padding: 12, gap: 10 },
  card: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: T.shadow, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12, elevation: 4,
  },
  cardInner:   { padding: 16 },
  cardTop:     { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dateBadge: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: T.champGlow,
    justifyContent: 'center', alignItems: 'center',
  },
  dateDay: { fontSize: 18, fontWeight: '700', color: T.champagne, lineHeight: 20 },
  dateMon: { fontSize: 10, color: T.champagne, textTransform: 'uppercase', letterSpacing: 0.5 },
  cardMeta: { flex: 1 },
  specialistName: { fontSize: 15, fontWeight: '600', color: T.stone },
  specialistRole: { fontSize: 12, color: T.stoneMid, marginTop: 2 },
  countBadge: {
    marginTop: 10, alignSelf: 'flex-start',
    backgroundColor: 'rgba(212,175,55,0.12)',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3,
  },
  countText: { fontSize: 12, color: T.champagne, fontWeight: '500' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 15, color: T.stoneFaint },
});
