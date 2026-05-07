/**
 * PriceListDetailScreen — подкатегории и услуги с ценами
 * Aura Aesthetics Premium Clinic — "Liquid Glass & Silk"
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, ScrollView, Text, StyleSheet,
  TouchableOpacity, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withTiming, withDelay, withSpring, Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';

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

function fmt(price) {
  if (price == null) return null;
  return price.toLocaleString('ru-RU') + ' ₽';
}

function Reveal({ delay = 0, children, onLayout }) {
  const opacity = useSharedValue(0);
  const ty = useSharedValue(18);
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) }));
    ty.value = withDelay(delay, withSpring(0, { damping: 22, stiffness: 130 }));
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: ty.value }] }));
  return <Animated.View style={style} onLayout={onLayout}>{children}</Animated.View>;
}

function ServiceRow({ service, hasDual, isLast }) {
  const docPrice = fmt(service.price_doctor);
  const chiefPrice = fmt(service.price_chief);

  return (
    <View style={[s.serviceRow, !isLast && s.serviceRowBorder]}>
      <View style={s.serviceNameWrap}>
        <Text style={s.serviceName}>{service.name}</Text>
        {!!service.note && <Text style={s.serviceNote}>{service.note}</Text>}
      </View>
      {hasDual ? (
        <View style={s.dualPrices}>
          <Text style={s.priceDoctor}>{docPrice ?? '—'}</Text>
          <Text style={s.priceChief}>{chiefPrice ?? '—'}</Text>
        </View>
      ) : (
        <Text style={s.priceSingle}>{docPrice ?? '—'}</Text>
      )}
    </View>
  );
}

function SubcategoryCard({ sub, index, onLayout }) {
  const hasDual = sub.services.some(sv => sv.price_chief != null);

  return (
    <Reveal delay={index * 60} onLayout={onLayout}>
      <View style={s.subCard}>
        <BlurView intensity={25} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,252,248,0.60)', 'rgba(237,233,227,0.30)']}
          style={StyleSheet.absoluteFill}
        />
        {/* Subcategory header */}
        <View style={s.subHeader}>
          <Text style={s.subTitle}>{sub.name}</Text>
          {hasDual && (
            <View style={s.dualHeader}>
              <Text style={s.dualHeaderLabel}>Врач</Text>
              <Text style={s.dualHeaderLabel}>Гл. врач{'\n'}Пери Г.</Text>
            </View>
          )}
        </View>

        {/* Divider */}
        <View style={s.divider} />

        {/* Services */}
        {sub.services.map((sv, i) => (
          <ServiceRow
            key={i}
            service={sv}
            hasDual={hasDual}
            isLast={i === sub.services.length - 1}
          />
        ))}
      </View>
    </Reveal>
  );
}

export default function PriceListDetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { title, subcategories } = route.params;

  const scrollRef = useRef(null);
  const positionsRef = useRef({});
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const onSubLayout = (id) => (e) => {
    positionsRef.current[id] = e.nativeEvent.layout.y;
  };

  const jumpTo = (id) => {
    setDropdownOpen(false);
    const y = positionsRef.current[id];
    if (y != null && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, y - 8), animated: true });
    }
  };

  const showDropdown = subcategories.length > 1;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />
      <LinearGradient colors={[T.pearl, T.silk]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <Reveal delay={0}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={22} color={T.champagne} />
          </TouchableOpacity>
          <View style={s.headerText}>
            <Text style={s.headerTitle}>{title}</Text>
          </View>
        </View>
      </Reveal>

      {/* Subcategory dropdown */}
      {showDropdown && (
        <Reveal delay={40}>
          <View style={s.dropdownWrap}>
            <TouchableOpacity
              style={s.dropdownBtn}
              onPress={() => setDropdownOpen(o => !o)}
              activeOpacity={0.75}
            >
              <Ionicons name="list-outline" size={16} color={T.champagne} />
              <Ionicons
                name={dropdownOpen ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={T.champagne}
              />
            </TouchableOpacity>

            {dropdownOpen && (
              <View style={s.dropdownPanel}>
                <BlurView intensity={30} tint="light" style={StyleSheet.absoluteFill} />
                <LinearGradient
                  colors={['rgba(255,252,248,0.85)', 'rgba(237,233,227,0.70)']}
                  style={StyleSheet.absoluteFill}
                />
                {subcategories.map((sub, i) => (
                  <TouchableOpacity
                    key={sub.id}
                    style={[s.dropdownItem, i < subcategories.length - 1 && s.dropdownItemBorder]}
                    onPress={() => jumpTo(sub.id)}
                    activeOpacity={0.65}
                  >
                    <Text style={s.dropdownItemText}>{sub.name}</Text>
                    <Ionicons name="arrow-down" size={13} color={T.champagne} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </Reveal>
      )}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {subcategories.length === 0 ? (
          <Reveal delay={100}>
            <View style={s.empty}>
              <Text style={s.emptyText}>Нет данных</Text>
            </View>
          </Reveal>
        ) : (
          subcategories.map((sub, i) => (
            <SubcategoryCard
              key={sub.id}
              sub={sub}
              index={i}
              onLayout={onSubLayout(sub.id)}
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
    paddingBottom: 12,
    gap: 8,
  },
  backBtn: {
    width: 38, height: 38,
    borderRadius: 12,
    backgroundColor: T.champGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 20, fontWeight: '700', color: T.stone, letterSpacing: 0.2,
  },

  scroll: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },

  subCard: {
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: T.shadowDeep,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 3,
  },

  subHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  subTitle: {
    flex: 1,
    fontSize: 15, fontWeight: '700', color: T.stone,
    letterSpacing: 0.2,
  },
  dualHeader: {
    flexDirection: 'row',
    gap: 8,
    minWidth: 150,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
  },
  dualHeaderLabel: {
    width: 68,
    textAlign: 'right',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '600',
    color: T.champagne,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  divider: {
    height: 1,
    backgroundColor: 'rgba(212,175,55,0.18)',
    marginHorizontal: 16,
  },

  serviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 8,
  },
  serviceRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(74,69,64,0.07)',
  },
  serviceNameWrap: { flex: 1 },
  serviceName: {
    fontSize: 13, color: T.stone, lineHeight: 18, fontWeight: '500',
  },
  serviceNote: {
    fontSize: 11, color: T.stoneMid, marginTop: 2, fontStyle: 'italic',
  },

  dualPrices: {
    flexDirection: 'row',
    gap: 8,
  },
  priceDoctor: {
    width: 68,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '600',
    color: T.stone,
  },
  priceChief: {
    width: 68,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '600',
    color: T.champagne,
  },
  priceSingle: {
    fontSize: 13,
    fontWeight: '600',
    color: T.stone,
    minWidth: 70,
    textAlign: 'right',
  },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: T.stoneMid, fontSize: 14 },

  dropdownWrap: {
    paddingHorizontal: 16,
    paddingBottom: 6,
    zIndex: 10,
  },
  dropdownBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: T.champGlow,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.28)',
  },
  dropdownBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: T.champagne,
    letterSpacing: 0.3,
  },
  dropdownPanel: {
    marginTop: 8,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: T.shadowDeep,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 4,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  dropdownItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(74,69,64,0.07)',
  },
  dropdownItemText: {
    flex: 1,
    fontSize: 13,
    color: T.stone,
    fontWeight: '500',
  },
});
