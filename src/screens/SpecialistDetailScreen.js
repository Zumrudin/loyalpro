import React, { useEffect, useMemo, useCallback } from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';

const { width } = Dimensions.get('window');

// ─── Design tokens (match HomeScreen) ──────────────────────────────────────
const T = {
  pearl:      '#F5F3F0',
  glass:      'rgba(255,252,248,0.72)',
  glassBorder:'rgba(255,255,255,0.85)',
  champagne:  '#D4AF37',
  champLight: '#F0D882',
  champDark:  '#A8881C',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  glowA:      'rgba(240,216,130,0.22)',
  glowB:      'rgba(220,210,240,0.18)',
};

const PHOTO_W = width;
const PHOTO_H = width * 1.25; // 4:5

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function SpecialistDetailScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const id = route.params?.id;

  const specialists = useClientStore((s) => s.specialists);
  const fetchSpecialists = useClientStore((s) => s.fetchSpecialists);

  const specialist = useMemo(
    () => specialists.find((sp) => sp.id === Number(id)) || null,
    [specialists, id]
  );

  // Defensive fallback: if list isn't in the store (e.g. deep link), fetch it
  useEffect(() => {
    if (!specialist && specialists.length === 0) {
      fetchSpecialists();
    }
  }, [specialist, specialists.length]);

  // Switch status bar to light while photo is at the top, restore on blur
  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle('light-content', true);
      return () => StatusBar.setBarStyle('dark-content', true);
    }, [])
  );

  if (!specialist) {
    // Either still loading or genuinely missing — keep this minimal
    return (
      <View style={s.root}>
        <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />
        <View style={[s.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtnPlain} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={22} color={T.stone} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const hasPhoto = !!specialist.photoUrl;
  const hasBio = !!(specialist.bio && specialist.bio.trim());

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Photo (extends under status bar) */}
        <View style={s.photoWrap}>
          {hasPhoto ? (
            <Image
              source={{ uri: specialist.photoUrl }}
              style={s.photo}
              resizeMode="cover"
            />
          ) : (
            <View style={s.photo}>
              <LinearGradient
                colors={[T.glowA, T.glowB]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={s.initialsCenter}>
                <Text style={s.initialsText}>{getInitials(specialist.name)}</Text>
              </View>
            </View>
          )}
          {/* Subtle dark gradient at top so the back button is readable on bright photos */}
          <LinearGradient
            colors={['rgba(0,0,0,0.35)', 'transparent']}
            style={s.photoTopShade}
          />
        </View>

        {/* Body */}
        <View style={s.body}>
          <Text style={s.name}>{specialist.name}</Text>
          {!!specialist.specialization && (
            <Text style={s.spec}>{specialist.specialization}</Text>
          )}
          <View style={s.divider} />

          {hasBio ? (
            <Text style={s.bio}>{specialist.bio}</Text>
          ) : (
            <Text style={s.bioPlaceholder}>Подробная информация скоро появится</Text>
          )}
        </View>
      </ScrollView>

      {/* Floating back button over photo */}
      <View style={[s.backWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.85}>
          <BlurView intensity={50} tint="dark" style={s.backBlur}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </BlurView>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backBtnPlain: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    justifyContent: 'center', alignItems: 'center',
  },

  photoWrap: {
    width: PHOTO_W,
    height: PHOTO_H,
    overflow: 'hidden',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  photo: { width: PHOTO_W, height: PHOTO_H, justifyContent: 'center', alignItems: 'center' },
  photoTopShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 120 },
  initialsCenter: { justifyContent: 'center', alignItems: 'center' },
  initialsText: { fontSize: 80, color: T.champDark, fontFamily: 'serif' },

  backWrap: {
    position: 'absolute',
    left: 16,
  },
  backBlur: {
    width: 40, height: 40, borderRadius: 20,
    overflow: 'hidden',
    justifyContent: 'center', alignItems: 'center',
  },

  body: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  name: { fontSize: 26, color: T.stone, fontFamily: 'serif', letterSpacing: 0.3 },
  spec: { fontSize: 14, color: T.stoneMid, marginTop: 6, letterSpacing: 0.3, lineHeight: 20 },
  divider: {
    width: 48, height: 1.5, backgroundColor: T.champagne,
    marginTop: 18, marginBottom: 18, borderRadius: 2,
  },
  bio: { fontSize: 15, color: T.stone, lineHeight: 24 },
  bioPlaceholder: { fontSize: 14, color: T.stoneFaint, fontStyle: 'italic' },
});
