# Loyalty Ring Animation — Design Spec
Date: 2026-04-16

## Goal
Add a premium animated loyalty progress ring to the bonuses tab and home screen bonus card. The animation reflects the beauty/cosmetology aesthetic of Aura Aesthetics and conveys the premium status of each loyalty tier.

## Selected Design: B·1 — Diamond Ring with Gold Glow
- Circular arc fills proportionally to progress toward next level
- 💎 emoji in the center pulses with warm golden glow (scale + drop-shadow)
- Serif font (Georgia) for level name and stats
- Fill animation plays on mount: cubic-bezier ease, ~2.6s
- Two sizes: full (BonusesScreen) and compact (HomeScreen card)

## Data Flow

### Backend change — `/mobile/client/bonuses` (mobile-client.js)
Currently returns: `{ balance, level }`
After change returns:
```json
{
  "balance": 1840,
  "level": "gold",
  "totalSpent": 8400,
  "levels": [
    { "key": "beginner", "name": "Новичок", "minSpent": 0, "cashback": 3 },
    { "key": "silver",   "name": "Серебро",  "minSpent": 3000, "cashback": 5 },
    { "key": "gold",     "name": "Золото",   "minSpent": 7000, "cashback": 7 },
    { "key": "platinum", "name": "Платина",  "minSpent": 15000, "cashback": 10 }
  ],
  "nextLevel": { "key": "platinum", "name": "Платина", "minSpent": 15000, "cashback": 10 },
  "amountToNext": 6600
}
```
Levels come from `loyalty_settings.levels` joined via salon_id.
`totalSpent` comes from `clients.total_spent`.
If client is at max level, `nextLevel` is null and `amountToNext` is 0.

### Store change — clientStore.js
`fetchBonuses` stores all new fields in the `bonuses` object.

### New component — `src/components/LoyaltyRing.js`
Props:
- `totalSpent` (number)
- `levels` (array)
- `currentLevel` (object)
- `nextLevel` (object | null)
- `compact` (bool, default false)

Internal logic:
- Sorts levels by minSpent ascending
- Finds current level's minSpent and next level's minSpent
- Progress = (totalSpent - currentLevel.minSpent) / (nextLevel.minSpent - currentLevel.minSpent)
- Clamps to [0, 1]
- At max level: progress = 1, shows "Максимальный уровень"

SVG ring:
- viewBox="0 0 100 100", r=42 → circumference ≈ 264
- Background track: rgba(212,175,55,0.13), stroke-width 7
- Progress arc: gold linear gradient, stroke-linecap round, drop-shadow
- Arc animates from dashoffset=264 to dashoffset = 264 * (1 - progress) via Reanimated useSharedValue

Center:
- 💎 emoji, font-size scales with compact prop
- Pulses via Animated.loop: scale 1→1.14, drop-shadow 3px→10px, period 2.8s
- Percentage text below in Georgia serif

Below ring:
- Level name (Georgia serif, champagne gold)
- "До [NextLevel]: X ₽" in sans-serif stone-mid color

### BonusesScreen.js
Replace current `levelRow` (simple text row) with `<LoyaltyRing>` (full size) inside the balance card.

### HomeScreen.js
Replace the level text `bonusLevel` in the bonus card with `<LoyaltyRing compact />`.

## Files to change
1. `/root/loyalpro/backend/routes/mobile-client.js` — extend `/bonuses` route
2. `/root/mobile/src/store/clientStore.js` — store new fields
3. `/root/mobile/src/components/LoyaltyRing.js` — new component (create)
4. `/root/mobile/src/screens/BonusesScreen.js` — use LoyaltyRing
5. `/root/mobile/src/screens/HomeScreen.js` — use LoyaltyRing compact
