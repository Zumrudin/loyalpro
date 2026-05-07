# Loyalty Ring Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a premium animated diamond-ring loyalty progress widget to the bonuses screen and home screen card, pulling real level thresholds from LoyalPro settings.

**Architecture:** Backend `/bonuses` endpoint is extended to return levels array and totalSpent. A new `LoyaltyRing` React Native component renders a Reanimated SVG arc + pulsing 💎 emoji. Both BonusesScreen and HomeScreen consume the component via the existing Zustand store.

**Tech Stack:** Node.js/pg-promise (backend), React Native + Expo, react-native-reanimated, react-native-svg, Zustand

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `/root/loyalpro/backend/routes/mobile-client.js` | Modify | Add totalSpent + levels + nextLevel to /bonuses response |
| `/root/mobile/src/store/clientStore.js` | Modify | Store new bonus fields |
| `/root/mobile/src/components/LoyaltyRing.js` | Create | Animated ring component (full + compact) |
| `/root/mobile/src/screens/BonusesScreen.js` | Modify | Replace levelRow with full LoyaltyRing |
| `/root/mobile/src/screens/HomeScreen.js` | Modify | Replace level text with compact LoyaltyRing |

---

## Task 1: Extend `/bonuses` backend endpoint

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js` lines 190–211

- [ ] **Step 1: Replace the `/bonuses` route handler**

Open `/root/loyalpro/backend/routes/mobile-client.js` and replace the entire `router.get('/bonuses', ...)` block (lines 190–211) with:

```js
// Get bonuses
router.get('/bonuses', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT bonus_balance, loyalty_level, total_spent, salon_id FROM clients WHERE id=$1',
      [req.client.clientId]
    );

    if (!client) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    // Load loyalty levels from settings
    let levels = [];
    try {
      const settings = await db.oneOrNone(
        'SELECT levels FROM loyalty_settings WHERE salon_id=$1',
        [client.salon_id]
      );
      if (settings?.levels) {
        levels = typeof settings.levels === 'string'
          ? JSON.parse(settings.levels)
          : settings.levels;
        // Sort ascending by minSpent
        levels = levels
          .filter(l => l && typeof l.minSpent === 'number')
          .sort((a, b) => a.minSpent - b.minSpent);
      }
    } catch (_) { /* non-critical: levels stays [] */ }

    const totalSpent = parseFloat(client.total_spent || 0);

    // Find current level object and next level object
    let currentLevel = levels.length > 0 ? levels[0] : null;
    let nextLevel = null;
    for (let i = 0; i < levels.length; i++) {
      if (totalSpent >= levels[i].minSpent) {
        currentLevel = levels[i];
        nextLevel = levels[i + 1] || null;
      }
    }

    const amountToNext = nextLevel
      ? Math.max(0, nextLevel.minSpent - totalSpent)
      : 0;

    res.json({
      success: true,
      balance: client.bonus_balance || 0,
      level: client.loyalty_level || 'Новичок',
      totalSpent,
      levels,
      currentLevel,
      nextLevel: nextLevel || null,
      amountToNext,
    });

  } catch (e) {
    console.error('[Get bonuses error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Restart backend and verify response**

```bash
cd /root/loyalpro && pm2 restart all 2>/dev/null || node backend/server.js &
sleep 2
# Get a valid mobile token first (or use curl with existing token from .env/logs)
# The response should now include levels, totalSpent, nextLevel, amountToNext
echo "Backend restarted — check /mobile/client/bonuses response includes levels array"
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/mobile-client.js
git commit -m "feat: extend /bonuses endpoint with levels, totalSpent, nextLevel"
```

---

## Task 2: Update Zustand store to store new fields

**Files:**
- Modify: `/root/mobile/src/store/clientStore.js` lines 125–143

- [ ] **Step 1: Update `fetchBonuses` in the store**

Open `/root/mobile/src/store/clientStore.js`. Find the `fetchBonuses` action (around line 125) and replace it with:

```js
  fetchBonuses: async () => {
    set({ bonusLoading: true });
    try {
      const bonusData = await clientDataAPI.getBonuses();
      const historyData = await clientDataAPI.getBonusHistory();
      set({
        bonuses: {
          balance:      bonusData.balance      || 0,
          level:        bonusData.level        || 'Новичок',
          totalSpent:   bonusData.totalSpent   || 0,
          levels:       bonusData.levels       || [],
          currentLevel: bonusData.currentLevel || null,
          nextLevel:    bonusData.nextLevel     || null,
          amountToNext: bonusData.amountToNext || 0,
        },
        bonusHistory: historyData.transactions || historyData || [],
        error: null,
      });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bonusLoading: false });
    }
  },
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile
git add src/store/clientStore.js
git commit -m "feat: store loyalty levels and totalSpent in bonuses state"
```

---

## Task 3: Create `LoyaltyRing` component

**Files:**
- Create: `/root/mobile/src/components/LoyaltyRing.js`

- [ ] **Step 1: Create the component file**

Create `/root/mobile/src/components/LoyaltyRing.js` with the full contents below.

Key logic:
- `CIRCUMFERENCE = 2 * π * 42 ≈ 263.9` (r=42 in 100×100 viewBox)
- Progress arc dashoffset animates from CIRCUMFERENCE → CIRCUMFERENCE * (1 - progress)
- 💎 pulses: scale 1→1.14, drop-shadow intensifies, period 2.8s, loops forever
- `compact` prop shrinks ring size and hides the "До Х ₽" line

```js
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

export default function LoyaltyRing({ totalSpent = 0, currentLevel = null, nextLevel = null, compact = false }) {
  const progress = computeProgress(totalSpent, currentLevel, nextLevel);
  const pct = Math.round(progress * 100);

  // Arc animation
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
    // React Native doesn't support CSS drop-shadow directly — use shadow props via wrapper
    opacity: interpolate(pulse.value, [0, 1], [0.88, 1]),
  }));

  const glowStyle = useAnimatedStyle(() => ({
    shadowOpacity: interpolate(pulse.value, [0, 1], [0.2, 0.7]),
    shadowRadius:  interpolate(pulse.value, [0, 1], [4, 14]),
  }));

  const ringSize   = compact ? 72 : 110;
  const gemSize    = compact ? 20 : 30;
  const pctSize    = compact ? 10 : 14;
  const levelSize  = compact ? 11 : 14;
  const subSize    = compact ? 10 : 12;

  const levelName = currentLevel?.name || 'Новичок';
  const nextName  = nextLevel?.name;

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {/* Ring */}
      <Animated.View style={[styles.glowWrap, { width: ringSize, height: ringSize }, glowStyle]}>
        <Svg width={ringSize} height={ringSize} viewBox="0 0 100 100"
          style={{ transform: [{ rotate: '-90deg' }] }}>
          <Defs>
            <LinearGradient id="goldArc" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%"   stopColor={T.champagne} />
              <Stop offset="60%"  stopColor={T.champLight} />
              <Stop offset="100%" stopColor={T.champagne} />
            </LinearGradient>
          </Defs>
          {/* Track */}
          <Circle
            cx="50" cy="50" r="42"
            fill="none"
            stroke="rgba(212,175,55,0.13)"
            strokeWidth="7"
          />
          {/* Progress arc */}
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

        {/* Center content */}
        <View style={[styles.center, { width: ringSize, height: ringSize }]}>
          <Animated.Text style={[{ fontSize: gemSize, lineHeight: gemSize + 2 }, gemStyle]}>
            💎
          </Animated.Text>
          <Text style={[styles.pct, { fontSize: pctSize }]}>{pct}%</Text>
        </View>
      </Animated.View>

      {/* Labels */}
      <View style={styles.labels}>
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
          <Text style={[styles.sub, { fontSize: subSize }]}>Максимальный уровень ✦</Text>
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
    shadowColor: T.champagne,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    position: 'relative',
  },
  center: {
    position: 'absolute',
    top: 0, left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: {
    fontFamily: 'serif',
    color: T.champagne,
    letterSpacing: 0.4,
    marginTop: 1,
  },
  labels: {
    alignItems: 'center',
  },
  levelName: {
    fontFamily: 'serif',
    color: T.stone,
    letterSpacing: 0.3,
  },
  sub: {
    color: T.stoneMid,
    marginTop: 3,
    textAlign: 'center',
  },
  subAmount: {
    color: T.champagne,
    fontWeight: '600',
  },
});
```

- [ ] **Step 2: Verify react-native-svg is available**

```bash
cd /root/mobile
grep "react-native-svg" package.json
```

Expected: a line like `"react-native-svg": "^..."`. If missing, run:
```bash
npx expo install react-native-svg
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile
git add src/components/LoyaltyRing.js
git commit -m "feat: add LoyaltyRing animated component"
```

---

## Task 4: Integrate full LoyaltyRing into BonusesScreen

**Files:**
- Modify: `/root/mobile/src/screens/BonusesScreen.js`

- [ ] **Step 1: Add import at the top of BonusesScreen.js**

In `/root/mobile/src/screens/BonusesScreen.js`, after the existing imports (after line 31 `import { ru } from 'date-fns/locale';`), add:

```js
import LoyaltyRing from '../components/LoyaltyRing';
```

- [ ] **Step 2: Replace the levelRow block inside the balance card**

In `BonusesScreen.js`, find the `balanceCard` JSX block. It currently ends with:

```jsx
                  <View style={styles.divider} />
                  <View style={styles.levelRow}>
                    <Text style={styles.levelLabel}>Уровень лояльности</Text>
                    <Text style={styles.levelValue}>{bonuses.level || 'Новичок'}</Text>
                  </View>
```

Replace those last two elements (divider + levelRow) with:

```jsx
                  <View style={styles.divider} />
                  <View style={styles.ringWrap}>
                    <LoyaltyRing
                      totalSpent={bonuses.totalSpent || 0}
                      currentLevel={bonuses.currentLevel}
                      nextLevel={bonuses.nextLevel}
                    />
                  </View>
```

- [ ] **Step 3: Add `ringWrap` to StyleSheet**

In the `StyleSheet.create({...})` block of `BonusesScreen.js`, add after the `divider` style:

```js
  ringWrap: { paddingTop: 16, paddingBottom: 4, alignItems: 'center' },
```

- [ ] **Step 4: Remove now-unused levelRow/levelLabel/levelValue styles**

In the StyleSheet, delete these three entries (they're no longer rendered):
```js
  levelRow:   { ... },
  levelLabel: { ... },
  levelValue: { ... },
```

- [ ] **Step 5: Commit**

```bash
cd /root/mobile
git add src/screens/BonusesScreen.js
git commit -m "feat: replace level text with LoyaltyRing in BonusesScreen"
```

---

## Task 5: Integrate compact LoyaltyRing into HomeScreen bonus card

**Files:**
- Modify: `/root/mobile/src/screens/HomeScreen.js`

- [ ] **Step 1: Add import at the top of HomeScreen.js**

In `/root/mobile/src/screens/HomeScreen.js`, find the existing imports block and add:

```js
import LoyaltyRing from '../components/LoyaltyRing';
```

- [ ] **Step 2: Replace the bonusRight View in the bonus card**

Find the `bonusRight` view (around line 436):

```jsx
              <View style={s.bonusRight}>
                <Text style={s.bonusLevel}>{bonuses?.level || 'Новичок'}</Text>
                <Ionicons name="chevron-forward" size={14} color={T.champagne} />
              </View>
```

Replace with:

```jsx
              <View style={s.bonusRight}>
                <LoyaltyRing
                  totalSpent={bonuses?.totalSpent || 0}
                  currentLevel={bonuses?.currentLevel}
                  nextLevel={bonuses?.nextLevel}
                  compact
                />
                <Ionicons name="chevron-forward" size={14} color={T.champagne} style={{ marginLeft: 6 }} />
              </View>
```

- [ ] **Step 3: Remove now-unused `bonusLevel` style**

In HomeScreen's StyleSheet, delete:
```js
  bonusLevel: { fontSize: 12, color: T.champagne, fontFamily: undefined, letterSpacing: 0.5 },
```

- [ ] **Step 4: Commit**

```bash
cd /root/mobile
git add src/screens/HomeScreen.js
git commit -m "feat: replace level text with compact LoyaltyRing in HomeScreen"
```

---

## Task 6: Smoke-test end-to-end

- [ ] **Step 1: Start the Expo dev server**

```bash
cd /root/mobile
npx expo start --tunnel 2>&1 | head -30
```

- [ ] **Step 2: Verify on device/simulator**

Open the app and check:
1. **Home screen** — bonus card shows compact ring with 💎 pulsing. Balance and chevron still visible.
2. **Bonuses tab** — full ring animates on screen open, level name in serif font, "До Платины: X ₽" shown below.
3. **At max level** — ring is full (100%), shows "Максимальный уровень ✦".
4. **No levels from backend** — ring gracefully renders at 0% with "Новичок" (fallback).

- [ ] **Step 3: Final commit tag**

```bash
cd /root/mobile
git log --oneline -6
```

Expected to see the 5 feature commits from Tasks 1–5.
