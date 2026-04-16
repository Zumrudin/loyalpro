/**
 * LoyaltyRing — animated diamond progress ring
 * Aura Aesthetics Premium Clinic
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

const T = {
  champagne:  '#D4AF37',
  champLight: '#F0D060',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
};

const CIRCUMFERENCE = 2 * Math.PI * 42; // ≈ 263.9

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function computeProgress(totalSpent, currentLevel, nextLevel) {
  if (!nextLevel) return 1;
  const span = nextLevel.minSpent - (currentLevel?.minSpent || 0);
  if (span <= 0) return 1;
  const done = totalSpent - (currentLevel?.minSpent || 0);
  return Math.min(1, Math.max(0, done / span));
}

export default function LoyaltyRing({
  totalSpent = 0,
  currentLevel = null,
  nextLevel = null,
  compact = false,
}) {
  const progress = computeProgress(totalSpent, currentLevel, nextLevel);
  const pct = Math.round(progress * 100);

  // Arc fill animation
  const arcProgress = useSharedValue(0);
  useEffect(() => {
    arcProgress.value = withDelay(
      200,
      withTiming(progress, { duration: 2600, easing: Easing.out(Easing.cubic) }),
    );
  }, [progress]);

  const arcProps = useAnimatedProps(() => ({
    strokeDashoffset: CIRCUMFERENCE * (1 - arcProgress.value),
  }));

  // Diamond pulse
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
  }, []);

  const gemStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 1.14]) }],
    opacity: interpolate(pulse.value, [0, 1], [0.88, 1]),
  }));

  const glowStyle = useAnimatedStyle(() => ({
    shadowOpacity: interpolate(pulse.value, [0, 1], [0.2, 0.7]),
    shadowRadius:  interpolate(pulse.value, [0, 1], [4, 14]),
  }));

  const ringSize  = compact ? 72  : 110;
  const gemSize   = compact ? 20  : 30;
  const pctSize   = compact ? 10  : 14;
  const levelSize = compact ? 11  : 14;
  const subSize   = compact ? 10  : 12;

  const levelName = currentLevel?.name || 'Новичок';
  const nextName  = nextLevel?.name;

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {/* Ring */}
      <Animated.View
        style={[
          styles.glowWrap,
          { width: ringSize, height: ringSize },
          glowStyle,
        ]}
      >
        <Svg
          width={ringSize}
          height={ringSize}
          viewBox="0 0 100 100"
          style={{ transform: [{ rotate: '-90deg' }] }}
        >
          <Defs>
            <LinearGradient id="goldArc" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%"   stopColor={T.champagne} />
              <Stop offset="60%"  stopColor={T.champLight} />
              <Stop offset="100%" stopColor={T.champagne} />
            </LinearGradient>
          </Defs>

          {/* Background track */}
          <Circle
            cx="50" cy="50" r="42"
            fill="none"
            stroke="rgba(212,175,55,0.13)"
            strokeWidth="7"
          />

          {/* Animated progress arc */}
          <AnimatedCircle
            cx="50" cy="50" r="42"
            fill="none"
            stroke="url(#goldArc)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            animatedProps={arcProps}
          />
        </Svg>

        {/* Center: gem + percent */}
        <View style={[styles.center, { width: ringSize, height: ringSize }]}>
          <Animated.Text style={[{ fontSize: gemSize, lineHeight: gemSize + 2 }, gemStyle]}>
            💎
          </Animated.Text>
          <Text style={[styles.pct, { fontSize: pctSize }]}>{pct}%</Text>
        </View>
      </Animated.View>

      {/* Labels */}
      <View style={[styles.labels, compact && styles.labelsCompact]}>
        <Text style={[styles.levelName, { fontSize: levelSize }]}>✦ {levelName}</Text>

        {!compact && nextName && (
          <Text style={[styles.sub, { fontSize: subSize }]}>
            До {nextName}:{' '}
            <Text style={styles.subAmount}>
              {Number(nextLevel.minSpent - totalSpent).toLocaleString('ru-RU')} ₽
            </Text>
          </Text>
        )}

        {!compact && !nextName && (
          <Text style={[styles.sub, { fontSize: subSize }]}>
            Максимальный уровень ✦
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: 12,
  },
  wrapCompact: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  glowWrap: {
    shadowColor: '#D4AF37',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    position: 'relative',
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: {
    fontFamily: 'serif',
    color: '#D4AF37',
    letterSpacing: 0.4,
    marginTop: 1,
  },
  labels: {
    alignItems: 'center',
  },
  labelsCompact: {
    alignItems: 'flex-start',
  },
  levelName: {
    fontFamily: 'serif',
    color: '#4A4540',
    letterSpacing: 0.3,
  },
  sub: {
    color: '#7A736B',
    marginTop: 3,
    textAlign: 'center',
  },
  subAmount: {
    color: '#D4AF37',
    fontWeight: '600',
  },
});
