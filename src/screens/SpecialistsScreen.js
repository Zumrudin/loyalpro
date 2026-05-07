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
    return (
      <Image
        source={{ uri: photoUrl }}
        style={style}
        resizeMode="cover"
      />
    );
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
