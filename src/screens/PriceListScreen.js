/**
 * PriceListScreen — 4 фиксированные категории прайса
 * Aura Aesthetics Premium Clinic — "Liquid Glass & Silk"
 */
import React, { useEffect, useCallback, useState } from 'react';
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
import { clientDataAPI } from '../api/client-data';

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  champLight: '#F0D882',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  shadow:     'rgba(100,90,70,0.12)',
  shadowDeep: 'rgba(100,90,70,0.20)',
};

// Маппинг section id → иконка и цвет акцента
const CATEGORIES = [
  {
    sectionId: 'consultation',
    label: 'Консультации',
    sublabel: 'и диагностика',
    icon: 'clipboard-outline',
    gradient: ['rgba(140,180,160,0.22)', 'rgba(140,180,160,0.06)'],
  },
  {
    sectionId: 'hardware-cosmetology',
    label: 'Аппаратная',
    sublabel: 'косметология',
    icon: 'radio-outline',
    gradient: ['rgba(212,175,55,0.22)', 'rgba(212,175,55,0.06)'],
  },
  {
    sectionId: 'injection-cosmetology',
    label: 'Инъекционная',
    sublabel: 'косметология',
    icon: 'medkit-outline',
    gradient: ['rgba(180,160,200,0.22)', 'rgba(180,160,200,0.06)'],
  },
  {
    sectionId: 'aesthetic-cosmetology',
    label: 'Эстетическая',
    sublabel: 'косметология',
    icon: 'sparkles-outline',
    gradient: ['rgba(200,180,160,0.22)', 'rgba(200,180,160,0.06)'],
  },
  {
    sectionId: 'iv-therapy-category',
    label: 'IV терапия',
    sublabel: 'капельницы',
    icon: 'water-outline',
    gradient: ['rgba(100,180,200,0.22)', 'rgba(100,180,200,0.06)'],
  },
];

// IV терапия живёт внутри injection-cosmetology как подкатегория
const IV_SUBCATEGORY_ID = 'iv-therapy';

function Reveal({ delay = 0, children }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(24);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 480, easing: Easing.out(Easing.cubic) }));
    ty.value = withDelay(delay, withSpring(0, { damping: 22, stiffness: 130 }));
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: ty.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function CategoryCard({ cat, onPress, index, disabled }) {
  return (
    <Reveal delay={index * 90}>
      <TouchableOpacity
        style={s.card}
        onPress={() => onPress(cat)}
        activeOpacity={0.82}
        disabled={disabled}
      >
        <BlurView intensity={30} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient colors={cat.gradient} style={StyleSheet.absoluteFill} />
        <View style={s.cardContent}>
          <View style={s.iconWrap}>
            <LinearGradient
              colors={[T.champagne, T.champLight]}
              style={s.iconGradient}
            >
              <Ionicons name={cat.icon} size={26} color="#fff" />
            </LinearGradient>
          </View>
          <View style={s.cardText}>
            <Text style={s.cardLabel}>{cat.label}</Text>
            <Text style={s.cardSublabel}>{cat.sublabel}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={T.champagne} />
        </View>
      </TouchableOpacity>
    </Reveal>
  );
}

export default function PriceListScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    try {
      isRefresh ? setRefreshing(true) : setLoading(true);
      setError(null);
      const data = await clientDataAPI.getPriceList();
      setSections(data.sections || []);
    } catch (e) {
      setError('Не удалось загрузить прайс-лист');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePress = useCallback((cat) => {
    let subcategories = [];

    if (cat.sectionId === 'iv-therapy-category') {
      // IV терапия — отдельная подкатегория внутри injection
      const injSection = sections.find(s => s.id === 'injection-cosmetology');
      const ivSub = injSection?.subcategories?.find(sc => sc.id === IV_SUBCATEGORY_ID);
      subcategories = ivSub ? [ivSub] : [];
    } else {
      const section = sections.find(s => s.id === cat.sectionId);
      // Для injection — исключаем IV терапию (она идёт отдельной карточкой)
      subcategories = (section?.subcategories || []).filter(sc => sc.id !== IV_SUBCATEGORY_ID);
    }

    navigation.navigate('PriceListDetail', {
      title: `${cat.label} ${cat.sublabel}`,
      subcategories,
    });
  }, [sections, navigation]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />
      <LinearGradient colors={[T.pearl, T.silk]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <Reveal delay={0}>
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={s.backBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={22} color={T.champagne} />
          </TouchableOpacity>
          <View style={s.headerTextWrap}>
            <Text style={s.headerTitle}>Прайс-лист</Text>
            <Text style={s.headerSub}>Услуги и стоимость</Text>
          </View>
        </View>
      </Reveal>

      <ScrollView
        contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={T.champagne} />
        }
      >
        {error ? (
          <Reveal delay={100}>
            <View style={s.errorBox}>
              <Ionicons name="alert-circle-outline" size={28} color={T.stoneMid} />
              <Text style={s.errorText}>{error}</Text>
            </View>
          </Reveal>
        ) : loading ? (
          <View style={s.loadingBox}>
            <Text style={s.loadingText}>Загрузка...</Text>
          </View>
        ) : (
          CATEGORIES.map((cat, i) => (
            <CategoryCard
              key={cat.sectionId}
              cat={cat}
              index={i}
              onPress={handlePress}
              disabled={sections.length === 0}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 10,
  },
  backBtn: {
    width: 38, height: 38,
    borderRadius: 12,
    backgroundColor: T.champGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: { flex: 1 },
  headerTitle: {
    fontSize: 24, fontWeight: '700', color: T.stone,
    letterSpacing: 0.3,
  },
  headerSub: {
    fontSize: 12, color: T.stoneMid, marginTop: 2, letterSpacing: 0.3,
  },
  scroll: { paddingHorizontal: 16, paddingTop: 16, gap: 14 },
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: T.shadowDeep,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 4,
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    gap: 14,
  },
  iconWrap: { borderRadius: 14, overflow: 'hidden' },
  iconGradient: {
    width: 52, height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { flex: 1 },
  cardLabel: {
    fontSize: 17, fontWeight: '700', color: T.stone, letterSpacing: 0.2,
  },
  cardSublabel: {
    fontSize: 12, color: T.stoneMid, marginTop: 2, letterSpacing: 0.3,
  },
  errorBox: { alignItems: 'center', paddingTop: 60, gap: 12 },
  errorText: { color: T.stoneMid, fontSize: 14, textAlign: 'center' },
  loadingBox: { alignItems: 'center', paddingTop: 80 },
  loadingText: { color: T.stoneMid, fontSize: 14 },
});
