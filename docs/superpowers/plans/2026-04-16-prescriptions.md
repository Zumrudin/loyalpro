# Prescriptions (Домашний уход) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в мобильное приложение отображение назначений врача (домашний уход, лист назначений, витамины) с кнопкой на главном экране, индикацией в истории записей, и ссылкой из деталей записи.

**Architecture:** Бэкенд получает два новых роута в `mobile-client.js` (список назначений и детали) + миграция `record_id` в `home_care_prescriptions`. На мобильном стороне — два новых экрана (`PrescriptionsScreen`, `PrescriptionDetailScreen`), обновления в store/api, и точечные изменения в трёх существующих экранах.

**Tech Stack:** Node.js/Express/pg-promise (бэкенд), React Native + Expo + react-native-reanimated + expo-linear-gradient + expo-blur (мобильный), Zustand (стор).

---

## File Map

**Бэкенд (LoyalPro):**
- Modify: `/root/loyalpro/backend/migrations.js` — добавить миграцию `record_id`
- Modify: `/root/loyalpro/backend/routes/mobile-client.js` — добавить 2 роута + обновить bookings
- Modify: `/root/loyalpro/backend/routes/home-care.js` — принимать `record_id` при POST/PUT

**Мобильное приложение:**
- Modify: `/root/mobile/src/api/client-data.js` — добавить `getPrescriptions`, `getPrescriptionDetail`
- Modify: `/root/mobile/src/store/clientStore.js` — добавить стейт и экшны
- Create: `/root/mobile/src/screens/PrescriptionsScreen.js`
- Create: `/root/mobile/src/screens/PrescriptionDetailScreen.js`
- Modify: `/root/mobile/src/screens/HomeScreen.js` — кнопка Назначения в Кабинет
- Modify: `/root/mobile/src/screens/BookingsScreen.js` — индикатор has_prescription
- Modify: `/root/mobile/src/screens/BookingDetailScreen.js` — блок назначений после бонусов
- Modify: `/root/mobile/App.js` — регистрация двух новых экранов

---

## Task 1: Миграция БД — добавить record_id

**Files:**
- Modify: `/root/loyalpro/backend/migrations.js`

- [ ] **Step 1: Добавить миграцию в конец функции `runMigrations`**

В файле `/root/loyalpro/backend/migrations.js` перед строкой `}` закрывающей `runMigrations` (перед `module.exports`) добавить:

```js
  // ── Prescriptions: link to records ─────────────────────────
  await client.query(`
    ALTER TABLE home_care_prescriptions
      ADD COLUMN IF NOT EXISTS record_id INTEGER REFERENCES records(id) ON DELETE SET NULL
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_hcp_record_id ON home_care_prescriptions(record_id)
  `).catch(() => {});
```

- [ ] **Step 2: Перезапустить бэкенд чтобы миграция применилась**

```bash
pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 20 --nostream
```

Ожидаемый вывод: сервер стартует без ошибок. Ошибки типа "column already exists" безопасны (`.catch(() => {})`).

- [ ] **Step 3: Проверить что колонка появилась**

```bash
psql -U postgres -c "\d home_care_prescriptions" 2>/dev/null || psql loyalpro -c "\d home_care_prescriptions" 2>/dev/null || node -e "const {db}=require('/root/loyalpro/backend/db'); db.any('SELECT column_name FROM information_schema.columns WHERE table_name=\$1',['home_care_prescriptions']).then(r=>console.log(r.map(c=>c.column_name))).catch(console.error)"
```

Ожидаемый вывод: в списке колонок присутствует `record_id`.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js && git commit -m "feat: add record_id to home_care_prescriptions for mobile linking"
```

---

## Task 2: Бэкенд — обновить home-care.js (принимать record_id)

**Files:**
- Modify: `/root/loyalpro/backend/routes/home-care.js`

- [ ] **Step 1: Обновить POST роут — принимать и сохранять `record_id`**

Найти в `home-care.js` строку:
```js
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [] } = req.body;
    const p = await db.one(
      `INSERT INTO home_care_prescriptions (salon_id,client_id,specialist_id,face_procedures,body_procedures,hair_procedures,vitamins,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.salonId, client_id||null, req.user.userId, face_procedures||null, body_procedures||null, hair_procedures||null, vitamins||null, notes||null]
    );
```

Заменить на:
```js
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [], record_id } = req.body;
    const p = await db.one(
      `INSERT INTO home_care_prescriptions (salon_id,client_id,specialist_id,face_procedures,body_procedures,hair_procedures,vitamins,notes,record_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.salonId, client_id||null, req.user.userId, face_procedures||null, body_procedures||null, hair_procedures||null, vitamins||null, notes||null, record_id||null]
    );
```

- [ ] **Step 2: Обновить PUT роут — принимать и сохранять `record_id`**

Найти в `home-care.js` строку:
```js
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [] } = req.body;
```
(в обработчике `router.put('/:id',...`)

Заменить на:
```js
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [], record_id } = req.body;
```

И найти SQL UPDATE:
```js
    await db.query(
      `UPDATE home_care_prescriptions SET client_id=$1,face_procedures=$2,body_procedures=$3,
       hair_procedures=$4,vitamins=$5,notes=$6,updated_at=NOW() WHERE id=$7`,
      [client_id||null, face_procedures||null, body_procedures||null, hair_procedures||null, vitamins||null, notes||null, req.params.id]
    );
```

Заменить на:
```js
    await db.query(
      `UPDATE home_care_prescriptions SET client_id=$1,face_procedures=$2,body_procedures=$3,
       hair_procedures=$4,vitamins=$5,notes=$6,record_id=$7,updated_at=NOW() WHERE id=$8`,
      [client_id||null, face_procedures||null, body_procedures||null, hair_procedures||null, vitamins||null, notes||null, record_id||null, req.params.id]
    );
```

- [ ] **Step 3: Перезапустить бэкенд**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 10 --nostream
```

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/routes/home-care.js && git commit -m "feat: accept record_id when creating/updating home care prescriptions"
```

---

## Task 3: Бэкенд — новые мобильные роуты для назначений

**Files:**
- Modify: `/root/loyalpro/backend/routes/mobile-client.js`

- [ ] **Step 1: Добавить роут GET /prescriptions — список назначений клиента**

Вставить перед строкой `module.exports = router;` в конце файла:

```js
// Get client prescriptions list
router.get('/prescriptions', mobileAuth, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT
        p.id,
        p.created_at as "createdAt",
        p.notes,
        u.name as "specialistName",
        u.role as "specialistRole",
        COUNT(i.id)::int as "itemsCount"
       FROM home_care_prescriptions p
       LEFT JOIN users u ON u.id = p.specialist_id
       LEFT JOIN home_care_items i ON i.prescription_id = p.id
       WHERE p.client_id = $1
       GROUP BY p.id, u.name, u.role
       ORDER BY p.created_at DESC`,
      [req.client.clientId]
    );
    res.json({ success: true, prescriptions: rows });
  } catch (e) {
    console.error('[Get prescriptions error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get single prescription detail
router.get('/prescriptions/:id', mobileAuth, async (req, res) => {
  try {
    const p = await db.oneOrNone(
      `SELECT
        p.id,
        p.created_at as "createdAt",
        p.notes,
        u.name as "specialistName",
        u.role as "specialistRole"
       FROM home_care_prescriptions p
       LEFT JOIN users u ON u.id = p.specialist_id
       WHERE p.id = $1 AND p.client_id = $2`,
      [req.params.id, req.client.clientId]
    );
    if (!p) return res.status(404).json({ error: 'Назначение не найдено' });

    const items = await db.any(
      `SELECT time_of_day as "timeOfDay", category, product_name as "productName",
              instructions, sort_order as "sortOrder"
       FROM home_care_items
       WHERE prescription_id = $1
       ORDER BY sort_order`,
      [req.params.id]
    );
    res.json({ success: true, prescription: { ...p, items } });
  } catch (e) {
    console.error('[Get prescription detail error]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Обновить роут GET /bookings — добавить флаг has_prescription**

Найти в `mobile-client.js` следующий SQL запрос:
```js
    const bookings = await db.any(
      `SELECT
        id,
        visit_datetime as "dateTime",
        services->0->>'title'  as "serviceName",
        staff->0->>'name'      as "specialistName",
        status,
        amount as price
       FROM records
       WHERE ${whereSql}
       ORDER BY visit_datetime DESC
       LIMIT 50`,
      [req.client.clientId]
    );
```

Заменить на:
```js
    const bookings = await db.any(
      `SELECT
        r.id,
        r.visit_datetime as "dateTime",
        r.services->0->>'title'  as "serviceName",
        r.staff->0->>'name'      as "specialistName",
        r.status,
        r.amount as price,
        CASE WHEN p.id IS NOT NULL THEN true ELSE false END as "hasPrescription",
        p.id as "prescriptionId"
       FROM records r
       LEFT JOIN home_care_prescriptions p
         ON (p.record_id = r.id
             OR (p.record_id IS NULL AND p.client_id = r.client_id
                 AND DATE(p.created_at) = DATE(r.visit_datetime)))
         AND p.client_id = $1
       WHERE r.${whereSql}
       ORDER BY r.visit_datetime DESC
       LIMIT 50`,
      [req.client.clientId]
    );
```

Важно: `whereSql` уже содержит `client_id=$1 AND ...` — нужно исправить чтобы использовать алиас `r.`. Найти определение `whereSql`:
```js
    let whereSql = "client_id=$1 AND status != 'deleted'";
```
Заменить на:
```js
    let whereSql = "r.client_id=$1 AND r.status != 'deleted'";
```
И добавить в конец `if (type === 'upcoming')` и `else if (type === 'past')` префикс `r.`:
```js
    if (type === 'upcoming') {
      whereSql += ' AND r.visit_date > NOW()';
    } else if (type === 'past') {
      whereSql += ' AND r.visit_date <= NOW()';
    }
```

- [ ] **Step 3: Обновить роут GET /bookings/:bookingId — добавить prescription_id**

Найти SQL в `router.get('/bookings/:bookingId'`:
```js
    const booking = await db.oneOrNone(
      `SELECT
        id,
        visit_datetime as "dateTime",
        COALESCE(raw_payload->'services', services)->0->>'title' as "serviceName",
        staff->0->>'name'      as "specialistName",
        status,
        amount as price,
        COALESCE(raw_payload->'services', services) as services,
        staff,
        client_id,
        bonus_accrued as "bonusAccrued"
       FROM records
       WHERE id=$1 AND client_id=$2`,
      [req.params.bookingId, req.client.clientId]
    );
```

Заменить на:
```js
    const booking = await db.oneOrNone(
      `SELECT
        r.id,
        r.visit_datetime as "dateTime",
        COALESCE(r.raw_payload->'services', r.services)->0->>'title' as "serviceName",
        r.staff->0->>'name'      as "specialistName",
        r.status,
        r.amount as price,
        COALESCE(r.raw_payload->'services', r.services) as services,
        r.staff,
        r.client_id,
        r.bonus_accrued as "bonusAccrued",
        p.id as "prescriptionId"
       FROM records r
       LEFT JOIN home_care_prescriptions p
         ON (p.record_id = r.id
             OR (p.record_id IS NULL AND p.client_id = r.client_id
                 AND DATE(p.created_at) = DATE(r.visit_datetime)))
         AND p.client_id = $2
       WHERE r.id=$1 AND r.client_id=$2`,
      [req.params.bookingId, req.client.clientId]
    );
```

- [ ] **Step 4: Перезапустить и проверить**

```bash
pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 15 --nostream
```

Сервер должен стартовать без ошибок.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/routes/mobile-client.js && git commit -m "feat: add prescriptions endpoints and has_prescription flag to mobile API"
```

---

## Task 4: Мобильный API и Store

**Files:**
- Modify: `/root/mobile/src/api/client-data.js`
- Modify: `/root/mobile/src/store/clientStore.js`

- [ ] **Step 1: Добавить методы API в `client-data.js`**

Перед закрывающей `};` в конце объекта `clientDataAPI` добавить:

```js
  // Get prescriptions list
  getPrescriptions: async () => {
    const res = await apiClient.get('/mobile/client/prescriptions');
    return res.data;
  },

  // Get single prescription detail
  getPrescriptionDetail: async (id) => {
    const res = await apiClient.get(`/mobile/client/prescriptions/${id}`);
    return res.data;
  },
```

- [ ] **Step 2: Добавить стейт и экшны в `clientStore.js`**

Найти в `clientStore.js` секцию `// Recommendations`:
```js
  // Recommendations
  recommendations: [],
  recommendationsLoading: false,
```

Добавить после неё:
```js
  // Prescriptions
  prescriptions: [],
  prescriptionsLoading: false,
  prescriptionDetail: null,
  prescriptionDetailLoading: false,
```

Найти в конце стора (перед закрывающей `}));`) последний экшн и добавить после него:

```js
  fetchPrescriptions: async () => {
    set({ prescriptionsLoading: true });
    try {
      const response = await clientDataAPI.getPrescriptions();
      set({ prescriptions: response.prescriptions || [], error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ prescriptionsLoading: false });
    }
  },

  fetchPrescriptionDetail: async (id) => {
    set({ prescriptionDetailLoading: true, prescriptionDetail: null });
    try {
      const response = await clientDataAPI.getPrescriptionDetail(id);
      set({ prescriptionDetail: response.prescription || null, error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ prescriptionDetailLoading: false });
    }
  },
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/api/client-data.js src/store/clientStore.js && git commit -m "feat: add prescriptions API methods and store state"
```

---

## Task 5: PrescriptionsScreen — список назначений

**Files:**
- Create: `/root/mobile/src/screens/PrescriptionsScreen.js`

- [ ] **Step 1: Создать экран**

Создать `/root/mobile/src/screens/PrescriptionsScreen.js`:

```js
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
  glass:      'rgba(255,252,248,0.88)',
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
      <LinearGradient
        colors={[T.pearl, T.silk, T.pearl]}
        style={StyleSheet.absoluteFill}
      />

      {/* Header */}
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
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile && git add src/screens/PrescriptionsScreen.js && git commit -m "feat: add PrescriptionsScreen with list of prescriptions by date"
```

---

## Task 6: PrescriptionDetailScreen — детали назначения

**Files:**
- Create: `/root/mobile/src/screens/PrescriptionDetailScreen.js`

- [ ] **Step 1: Создать экран**

Создать `/root/mobile/src/screens/PrescriptionDetailScreen.js`:

```js
/**
 * PrescriptionDetailScreen — детали назначения врача
 * Секции: Домашний уход / Лист назначения / Витамины
 */
import React, { useEffect } from 'react';
import {
  View, ScrollView, Text, StyleSheet,
  TouchableOpacity, ActivityIndicator, StatusBar,
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
  glass:      'rgba(255,252,248,0.88)',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.15)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

// Маппинг time_of_day → секция
const SECTION_MAP = {
  morning:    { section: 'homecare', label: 'Утро' },
  evening:    { section: 'homecare', label: 'Вечер' },
  additional: { section: 'homecare', label: 'Дополнительный уход' },
  sheet_face: { section: 'sheet',    label: 'Лицо' },
  sheet_body: { section: 'sheet',    label: 'Тело' },
  sheet_hair: { section: 'sheet',    label: 'Волосы' },
  vitamins:   { section: 'vitamins', label: 'Витамины и добавки' },
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

function ItemRow({ item, isLast }) {
  return (
    <View style={[s.itemRow, !isLast && s.itemRowBorder]}>
      <View style={s.itemDot} />
      <View style={s.itemContent}>
        <Text style={s.itemName}>{item.productName}</Text>
        {!!item.instructions && (
          <Text style={s.itemInstr}>{item.instructions}</Text>
        )}
      </View>
    </View>
  );
}

function SectionCard({ title, icon, children, delay = 0 }) {
  return (
    <Reveal delay={delay}>
      <View style={s.sectionCard}>
        <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,252,248,0.55)', 'rgba(237,233,227,0.30)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.sectionCardInner}>
          <View style={s.sectionHeader}>
            <Ionicons name={icon} size={18} color={T.champagne} />
            <Text style={s.sectionTitle}>{title}</Text>
          </View>
          {children}
        </View>
      </View>
    </Reveal>
  );
}

function SubSection({ label, items }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={s.subSection}>
      <Text style={s.subSectionLabel}>{label}</Text>
      {items.map((item, i) => (
        <ItemRow key={i} item={item} isLast={i === items.length - 1} />
      ))}
    </View>
  );
}

export default function PrescriptionDetailScreen({ route, navigation }) {
  const { prescriptionId } = route.params;
  const insets = useSafeAreaInsets();
  const prescription = useClientStore(st => st.prescriptionDetail);
  const loading = useClientStore(st => st.prescriptionDetailLoading);
  const fetchPrescriptionDetail = useClientStore(st => st.fetchPrescriptionDetail);

  useEffect(() => { fetchPrescriptionDetail(prescriptionId); }, [prescriptionId]);

  // Группируем items по секциям и подсекциям
  const grouped = { homecare: {}, sheet: {}, vitamins: {} };
  (prescription?.items || []).forEach(item => {
    const map = SECTION_MAP[item.timeOfDay];
    if (!map) return;
    const sec = grouped[map.section];
    if (!sec[map.label]) sec[map.label] = [];
    sec[map.label].push(item);
  });

  const roleLabel = prescription?.specialistRole === 'specialist'
    ? 'Специалист'
    : (prescription?.specialistRole || '');

  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" />
      <LinearGradient colors={[T.pearl, T.silk, T.pearl]} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 10 }]}>
        <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={22} color={T.champagne} />
          <Text style={s.backText}>Назад</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Назначение</Text>
        {!!prescription && (
          <Text style={s.headerDate}>
            {safeFmt(prescription.createdAt, "d MMMM yyyy", { locale: ru })}
          </Text>
        )}
      </View>

      {loading ? (
        <View style={s.loader}>
          <ActivityIndicator color={T.champagne} />
        </View>
      ) : !prescription ? (
        <View style={s.loader}>
          <Text style={{ color: T.stoneMid }}>Назначение не найдено</Text>
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 24 }]}
        >
          {/* Doctor info */}
          <Reveal delay={0}>
            <View style={s.doctorCard}>
              <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
              <LinearGradient
                colors={['rgba(255,252,248,0.55)', 'rgba(237,233,227,0.30)']}
                style={StyleSheet.absoluteFill}
              />
              <View style={s.doctorCardInner}>
                <View style={s.doctorIcon}>
                  <Ionicons name="person-circle-outline" size={32} color={T.champagne} />
                </View>
                <View>
                  <Text style={s.doctorName}>{prescription.specialistName || '—'}</Text>
                  {!!roleLabel && <Text style={s.doctorRole}>{roleLabel}</Text>}
                </View>
              </View>
            </View>
          </Reveal>

          {/* Домашний уход */}
          {Object.keys(grouped.homecare).length > 0 && (
            <SectionCard title="Домашний уход" icon="home-outline" delay={60}>
              {Object.entries(grouped.homecare).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} />
              ))}
            </SectionCard>
          )}

          {/* Лист назначения */}
          {Object.keys(grouped.sheet).length > 0 && (
            <SectionCard title="Лист назначения" icon="document-text-outline" delay={120}>
              {Object.entries(grouped.sheet).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} />
              ))}
            </SectionCard>
          )}

          {/* Витамины */}
          {Object.keys(grouped.vitamins).length > 0 && (
            <SectionCard title="Витамины и добавки" icon="leaf-outline" delay={180}>
              {Object.entries(grouped.vitamins).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} />
              ))}
            </SectionCard>
          )}

          {/* Заметки врача */}
          {!!prescription.notes && (
            <Reveal delay={240}>
              <View style={s.notesCard}>
                <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
                <View style={s.notesCardInner}>
                  <Text style={s.notesLabel}>Заметки врача</Text>
                  <Text style={s.notesText}>{prescription.notes}</Text>
                </View>
              </View>
            </Reveal>
          )}
        </ScrollView>
      )}
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
  backBtn:    { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  backText:   { fontSize: 14, color: T.champagne, marginLeft: 2 },
  headerTitle: { fontSize: 26, color: T.stone, fontFamily: 'serif' },
  headerDate:  { fontSize: 13, color: T.stoneMid, marginTop: 2 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flex: 1 },
  list:   { padding: 12, gap: 10 },

  doctorCard: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: 'rgba(100,90,70,0.12)', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12, elevation: 4,
  },
  doctorCardInner: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  doctorIcon: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: T.champGlow, justifyContent: 'center', alignItems: 'center',
  },
  doctorName: { fontSize: 16, fontWeight: '600', color: T.stone },
  doctorRole: { fontSize: 13, color: T.stoneMid, marginTop: 2 },

  sectionCard: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: 'rgba(100,90,70,0.12)', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12, elevation: 4,
  },
  sectionCardInner: { padding: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: T.stone },

  subSection: { marginBottom: 12 },
  subSectionLabel: {
    fontSize: 12, fontWeight: '600', color: T.champagne,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8,
  },

  itemRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8, gap: 10 },
  itemRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(74,69,64,0.08)' },
  itemDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: T.champagne, marginTop: 6,
  },
  itemContent: { flex: 1 },
  itemName:  { fontSize: 14, color: T.stone, fontWeight: '500' },
  itemInstr: { fontSize: 12, color: T.stoneMid, marginTop: 3, lineHeight: 17 },

  notesCard: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)',
  },
  notesCardInner: { padding: 16 },
  notesLabel: { fontSize: 12, color: T.champagne, fontWeight: '600', marginBottom: 6 },
  notesText:  { fontSize: 14, color: T.stone, lineHeight: 20 },
});
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile && git add src/screens/PrescriptionDetailScreen.js && git commit -m "feat: add PrescriptionDetailScreen with homecare/sheet/vitamins sections"
```

---

## Task 7: HomeScreen — кнопка Назначения в Кабинет

**Files:**
- Modify: `/root/mobile/src/screens/HomeScreen.js`

- [ ] **Step 1: Добавить элемент Назначения в cabinetItems**

Найти в `HomeScreen.js`:
```js
            { icon: 'gift-outline',            label: 'Бонусы',      nav: 'Bonuses',       delay: 660 },
```

Заменить на:
```js
            { icon: 'gift-outline',            label: 'Бонусы',      nav: 'Bonuses',       delay: 660 },
            { icon: 'medical-outline',         label: 'Назначения',  nav: 'Prescriptions', delay: 700 },
```

- [ ] **Step 2: Commit**

```bash
cd /root/mobile && git add src/screens/HomeScreen.js && git commit -m "feat: add Prescriptions button to HomeScreen cabinet section"
```

---

## Task 8: BookingsScreen — индикатор has_prescription

**Files:**
- Modify: `/root/mobile/src/screens/BookingsScreen.js`

- [ ] **Step 1: Найти место рендера карточки записи**

Открыть `/root/mobile/src/screens/BookingsScreen.js`. Найти место где рендерится карточка бронирования — обычно содержит `booking.serviceName` или `booking.dateTime`.

- [ ] **Step 2: Добавить индикатор назначения**

Найти в рендере карточки строку, которая показывает статус записи или дату. Нужно найти контейнер верхней части карточки (обычно `bookingTop` или аналог).

Найти в `BookingsScreen.js` место где отображается статус или бейдж (например `StatusBadge` или аналогичный компонент). Добавить рядом с ним условный золотой бейдж:

```js
{booking.hasPrescription && (
  <View style={{
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
    marginLeft: 6,
  }}>
    <Text style={{ fontSize: 10, color: '#D4AF37', fontWeight: '600' }}>
      Назначения
    </Text>
  </View>
)}
```

Добавить его после компонента статуса или в строку с датой/временем — в зависимости от структуры карточки в файле.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/screens/BookingsScreen.js && git commit -m "feat: show prescription indicator badge on booking cards"
```

---

## Task 9: BookingDetailScreen — блок назначений после бонусов

**Files:**
- Modify: `/root/mobile/src/screens/BookingDetailScreen.js`

- [ ] **Step 1: Добавить блок назначений после секции бонусов**

Найти в `BookingDetailScreen.js` строку закрывающую секцию бонусов:
```js
          })()}
        </ScrollView>
```

Заменить на:
```js
          })()}

          {/* Prescription card */}
          {booking.prescriptionId && (
            <Reveal delay={200}>
              <TouchableOpacity
                style={[styles.card, { borderColor: 'rgba(212,175,55,0.35)' }]}
                activeOpacity={0.82}
                onPress={() => navigation.navigate('PrescriptionDetail', { prescriptionId: booking.prescriptionId })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{
                      width: 36, height: 36, borderRadius: 18,
                      backgroundColor: 'rgba(212,175,55,0.15)',
                      justifyContent: 'center', alignItems: 'center',
                    }}>
                      <Text style={{ fontSize: 18 }}>💊</Text>
                    </View>
                    <View>
                      <Text style={[styles.sectionTitle, { marginBottom: 2 }]}>Назначения по визиту</Text>
                      <Text style={{ fontSize: 12, color: T.stoneMid }}>Домашний уход · Витамины</Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 20, color: T.champagne }}>›</Text>
                </View>
              </TouchableOpacity>
            </Reveal>
          )}
        </ScrollView>
```

- [ ] **Step 2: Добавить импорт TouchableOpacity если его нет**

Проверить импорт в верхней части файла — `TouchableOpacity` уже импортирован. Если нет — добавить в список импортов из `react-native`.

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/screens/BookingDetailScreen.js && git commit -m "feat: add prescription link block in BookingDetailScreen after bonuses"
```

---

## Task 10: App.js — регистрация новых экранов

**Files:**
- Modify: `/root/mobile/App.js`

- [ ] **Step 1: Добавить импорты новых экранов**

Найти в `App.js`:
```js
import BookingDetailScreen from './src/screens/BookingDetailScreen';
```

Добавить после:
```js
import PrescriptionsScreen from './src/screens/PrescriptionsScreen';
import PrescriptionDetailScreen from './src/screens/PrescriptionDetailScreen';
```

- [ ] **Step 2: Зарегистрировать экраны в RootStack**

Найти в `App.js`:
```js
      <RootStack.Screen
        name="BookingDetail"
        component={BookingDetailScreen}
```

(или аналогичную регистрацию BookingDetailScreen). Добавить после блока `BookingDetailScreen`:

```js
      <RootStack.Screen
        name="Prescriptions"
        component={PrescriptionsScreen}
        options={{ headerShown: false }}
      />
      <RootStack.Screen
        name="PrescriptionDetail"
        component={PrescriptionDetailScreen}
        options={{ headerShown: false }}
      />
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add App.js && git commit -m "feat: register Prescriptions and PrescriptionDetail screens in navigator"
```

---

## Self-Review

**Spec coverage:**
- ✅ Кнопка Назначения в Кабинет на HomeScreen — Task 7
- ✅ Список назначений по датам — Task 5 (PrescriptionsScreen)
- ✅ Детальный экран с тремя секциями — Task 6 (PrescriptionDetailScreen)
- ✅ ФИО и должность врача — Task 6 (doctorCard), Task 3 (specialist_role в API)
- ✅ Косметика/процедура + комментарий врача — Task 6 (ItemRow с productName + instructions)
- ✅ Индикатор назначений в истории записей — Task 8
- ✅ Блок назначений в деталях записи — Task 9
- ✅ Связь назначение↔запись (record_id + fallback по дате) — Task 1, Task 3
- ✅ Миграция БД — Task 1
- ✅ API эндпоинты — Task 3
- ✅ Store и API клиент — Task 4
- ✅ Навигация — Task 10

**Placeholder scan:** Нет TBD или пустых шагов. Все SQL-запросы, компоненты и команды полные.

**Type consistency:**
- `prescriptionId` — используется везде единообразно
- `hasPrescription` (boolean) / `prescriptionId` (number|null) — из API в store
- `timeOfDay` (camelCase из API) — совпадает с маппингом в `SECTION_MAP`
- `productName`, `instructions` (camelCase) — совпадает с `ItemRow` props
