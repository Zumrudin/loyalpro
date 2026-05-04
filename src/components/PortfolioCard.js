/**
 * PortfolioCard — cover-photo card with title overlay at the bottom.
 * Used on HomeScreen strip (size="strip") and PortfolioCategoriesScreen grid (size="grid").
 *
 * Sizes:
 *   strip  → fixed 120x150 (4:5)
 *   grid   → width = (screen - 56) / 2, aspect 4:5
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  shadow:     'rgba(100,90,70,0.12)',
};

const STRIP_W = 120;
const STRIP_H = 150;
const GRID_W = (SCREEN_W - 56) / 2;
const GRID_H = GRID_W * (5 / 4);

function getSize(size) {
  return size === 'grid'
    ? { width: GRID_W, height: GRID_H }
    : { width: STRIP_W, height: STRIP_H };
}

export function PortfolioCard({ category, size = 'strip', onPress, style }) {
  const [imgFailed, setImgFailed] = useState(false);
  const { width, height } = getSize(size);

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.card,
        { width, height, opacity: pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {imgFailed || !category.coverPhotoUrl ? (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <Ionicons name="image-outline" size={28} color={T.champagne} />
        </View>
      ) : (
        <Image
          source={{ uri: category.coverPhotoUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      )}

      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.55)']}
        start={{ x: 0, y: 0.4 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <Text style={styles.title} numberOfLines={2}>
        {category.title}
      </Text>
    </Pressable>
  );
}

export function PortfolioCardSkeleton({ size = 'strip', style }) {
  const { width, height } = getSize(size);
  return (
    <View
      style={[
        styles.card,
        { width, height, backgroundColor: T.silk, opacity: 0.7 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: T.glass,
    marginRight: 12,
    shadowColor: T.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 3,
  },
  fallback: {
    backgroundColor: T.silk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
