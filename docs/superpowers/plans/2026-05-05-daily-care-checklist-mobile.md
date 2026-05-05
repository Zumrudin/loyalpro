# Daily Care Checklist — Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `/root/mobile/docs/superpowers/specs/2026-05-05-daily-care-checklist-design.md`

**ВАЖНО — зависимость:** этот план **полностью зависит от бэкенд-плана** `/root/loyalpro/docs/superpowers/plans/2026-05-05-daily-care-checklist-backend.md`. До его выполнения мобильный код будет получать 404/500 на новых эндпоинтах. Бэкенд-план должен быть выполнен и его сервис на проде/деве доступен (`pm2 status loyalpro` → online), прежде чем приступать к этому плану.

**Goal:** Реализовать в моб. приложении ежедневный чек-лист уходовых процедур: баннер на главной с прогрессом, экран `TodayChecklist` с галочками, экран `AdherenceCalendar` с heatmap-календарём, и расширения экрана `PrescriptionDetail` (даты курса, точки дней недели, мини-heatmap).

**Architecture:** Поверх существующего Zustand-стора `clientStore` добавляются `todayChecklist` / `adherenceData` и три экшна (`fetchTodayChecklist`, `toggleItemCompletion` с optimistic update, `fetchAdherence`). API клиент `client-data.js` пополняется четырьмя методами. Создаются два новых экрана в `src/screens/`, изменяются `HomeScreen` (баннер + кнопка кабинета) и `PrescriptionDetailScreen` (3 расширения). Оба новых экрана регистрируются в HomeStack в `App.js` (per-tab stack — обязательно, чтобы блюр-плашка bottom-tab сохранилась — см. CLAUDE.md).

**Tech Stack:** React Native + Expo SDK 54, Zustand (стор), Axios (`apiClient`), reanimated 4 + worklets, expo-linear-gradient, expo-blur, expo-haptics, date-fns + ru locale, Ionicons. Тестов нет (см. CLAUDE.md «There is no test suite») — проверки через UI smoke-test на физическом устройстве/эмуляторе и проверки API через `console.log('[API] …')` (стиль уже установлен).

---

## File Map

- Modify: `/root/mobile/src/api/client-data.js` — 4 новых метода в `clientDataAPI`
- Modify: `/root/mobile/src/store/clientStore.js` — поля `todayChecklist`, `adherenceData` + 3 экшна
- Create: `/root/mobile/src/screens/TodayChecklistScreen.js` — экран с галочками
- Create: `/root/mobile/src/screens/AdherenceCalendarScreen.js` — календарь heatmap для пациента
- Modify: `/root/mobile/src/screens/PrescriptionDetailScreen.js` — даты курса, точки дней, мини-heatmap
- Modify: `/root/mobile/src/screens/HomeScreen.js` — баннер «Уход сегодня» + кнопка в кабинете
- Modify: `/root/mobile/App.js` — регистрация двух новых экранов в HomeStack

---

## Pre-Flight: проверки

- [ ] **Step 1: Убедиться, что бэкенд-план выполнен**

```bash
# Проверка, что новые мобильные эндпоинты доступны (нужен мобильный JWT)
MOBILE_TOKEN="<paste mobile token from server logs>"
API_URL="${EXPO_PUBLIC_API_URL:-http://10.0.2.2:3000}"

curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" \
  "$API_URL/api/mobile/client/today-checklist" | head -c 300
```

Ожидаемо: JSON с `success:true`, `date`, `sections.morning/evening/additional`, `summary`. Если получаешь 404 / Cannot GET — бэкенд-план не выполнен, остановись.

- [ ] **Step 2: Убедиться, что Metro и зависимости в порядке**

```bash
cd /root/mobile && ls node_modules/expo-haptics 2>/dev/null && echo "expo-haptics OK"
ls node_modules/expo-blur node_modules/expo-linear-gradient node_modules/date-fns 2>/dev/null
```

Ожидаемо: все четыре пакета присутствуют (они уже используются другими экранами). Если `expo-haptics` отсутствует — установить: `npx expo install expo-haptics`.

- [ ] **Step 3: Запустить Metro в отдельном терминале (для всех последующих smoke-тестов)**

```bash
cd /root/mobile && npx expo start --clear
```

Дальнейшие шаги предполагают, что Expo dev-сервер запущен и приложение открыто на эмуляторе/устройстве. Каждый smoke-тест — это нажать `r` для перезагрузки приложения, открыть нужный экран и проверить визуально.

---

## Task 1: API клиент — 4 новых метода

**Files:**
- Modify: `/root/mobile/src/api/client-data.js`

- [ ] **Step 1: Открыть файл и найти `clientDataAPI`**

Файл экспортирует объект `clientDataAPI` с методами вида `getPrescriptions`, `getPrescriptionDetail` и т.д. Новые методы добавляются перед закрывающей `};` объекта.

- [ ] **Step 2: Добавить методы**

Перед закрывающей `};` объекта `clientDataAPI` вставить:

```js
  // Daily Care Checklist
  getTodayChecklist: async () => {
    const res = await apiClient.get('/mobile/client/today-checklist');
    return res.data;
  },

  markItemCompleted: async (itemId) => {
    const res = await apiClient.post(`/mobile/client/today-checklist/items/${itemId}/complete`);
    return res.data;
  },

  unmarkItemCompleted: async (itemId) => {
    const res = await apiClient.delete(`/mobile/client/today-checklist/items/${itemId}/complete`);
    return res.data;
  },

  getPrescriptionAdherence: async (id) => {
    const res = await apiClient.get(`/mobile/client/prescriptions/${id}/adherence`);
    return res.data;
  },
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/api/client-data.js
git commit -m "feat(api): add daily care checklist endpoints

getTodayChecklist, markItemCompleted, unmarkItemCompleted,
getPrescriptionAdherence — wrap the four new mobile API endpoints
introduced in the loyalpro backend plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: clientStore — состояние и экшны

**Files:**
- Modify: `/root/mobile/src/store/clientStore.js`

- [ ] **Step 1: Добавить новые поля state**

Найти секцию определения state (рядом с `prescriptions: []`, `prescriptionsLoading: false`). После блока prescriptions добавить:

```js
  // Daily Care Checklist
  todayChecklist: null,           // { date, sections: { morning, evening, additional }, summary }
  todayChecklistLoading: false,

  adherenceData: null,            // { prescription, days[] }
  adherenceLoading: false,
```

- [ ] **Step 2: Добавить `fetchTodayChecklist`**

В конец стора (перед закрывающей `}));`) добавить:

```js
  fetchTodayChecklist: async () => {
    set({ todayChecklistLoading: true });
    try {
      const response = await clientDataAPI.getTodayChecklist();
      set({
        todayChecklist: {
          date: response.date,
          sections: response.sections || { morning: [], evening: [], additional: [] },
          summary: response.summary || { total: 0, completed: 0 },
        },
        error: null,
      });
    } catch (error) {
      console.log('[API] fetchTodayChecklist error:', error?.message);
      set({ error: error?.message || 'Не удалось загрузить чек-лист' });
    } finally {
      set({ todayChecklistLoading: false });
    }
  },
```

- [ ] **Step 3: Добавить `toggleItemCompletion` (с optimistic update)**

Сразу после `fetchTodayChecklist` добавить:

```js
  toggleItemCompletion: async (itemId, currentlyCompleted) => {
    // 1. Optimistic flip в локальном state
    const prev = get().todayChecklist;
    if (!prev) return;

    const flipItem = (item) =>
      item.id === itemId ? { ...item, completed: !currentlyCompleted } : item;

    const nextSections = {
      morning:    prev.sections.morning.map(flipItem),
      evening:    prev.sections.evening.map(flipItem),
      additional: prev.sections.additional.map(flipItem),
    };
    const delta = currentlyCompleted ? -1 : +1;
    const nextSummary = {
      total:     prev.summary.total,
      completed: prev.summary.completed + delta,
    };
    set({ todayChecklist: { ...prev, sections: nextSections, summary: nextSummary } });

    // 2. Сетевой вызов
    try {
      if (currentlyCompleted) {
        await clientDataAPI.unmarkItemCompleted(itemId);
      } else {
        await clientDataAPI.markItemCompleted(itemId);
      }
    } catch (error) {
      // 3. Откат при ошибке
      console.log('[API] toggleItemCompletion error:', error?.message);
      set({
        todayChecklist: prev,
        error: error?.response?.data?.error || error?.message || 'Не удалось сохранить отметку',
      });
      throw error;
    }
  },
```

- [ ] **Step 4: Добавить `fetchAdherence`**

После `toggleItemCompletion`:

```js
  fetchAdherence: async (prescriptionId) => {
    set({ adherenceLoading: true, adherenceData: null });
    try {
      const response = await clientDataAPI.getPrescriptionAdherence(prescriptionId);
      set({
        adherenceData: {
          prescription: response.prescription,
          days: response.days || [],
        },
        error: null,
      });
    } catch (error) {
      console.log('[API] fetchAdherence error:', error?.message);
      set({ error: error?.message || 'Не удалось загрузить данные выполнения' });
    } finally {
      set({ adherenceLoading: false });
    }
  },
```

- [ ] **Step 5: Убедиться, что `get` доступен в стора**

Если в текущем `clientStore.js` декларация выглядит как `create((set) => ({ ... }))`, заменить на `create((set, get) => ({ ... }))`. Это нужно для `toggleItemCompletion`, который читает `get().todayChecklist` перед optimistic-обновлением.

- [ ] **Step 6: Commit**

```bash
cd /root/mobile && git add src/store/clientStore.js
git commit -m "feat(store): today checklist state with optimistic toggle

Adds todayChecklist + adherenceData state and three actions.
toggleItemCompletion does optimistic flip and rolls back on error,
so the home banner counter stays in sync with the checklist screen.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: TodayChecklistScreen — основной экран

**Files:**
- Create: `/root/mobile/src/screens/TodayChecklistScreen.js`

- [ ] **Step 1: Создать файл целиком**

```js
/**
 * TodayChecklistScreen — ежедневный чек-лист ухода
 * Aura Aesthetics Premium Clinic — "Liquid Glass & Silk"
 */
import React, { useEffect, useCallback } from 'react';
import {
  View, ScrollView, Text, StyleSheet, TouchableOpacity,
  RefreshControl, StatusBar, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withTiming, withDelay, withSpring, Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.88)',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  champStrong:'rgba(212,175,55,0.55)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  successBg:  'rgba(190,224,191,0.45)',
};

function parseDate(v) {
  if (!v) return new Date(NaN);
  if (typeof v === 'string') return new Date(v.replace(' ', 'T'));
  return new Date(v);
}

function currentTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 6 && h < 12)  return 'morning';
  if (h >= 18 || h < 5)  return 'evening';
  return null;
}

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

function Checkbox({ completed, onToggle }) {
  const scale = useSharedValue(1);
  const onPress = () => {
    scale.value = withSpring(0.85, { damping: 12, stiffness: 220 }, () => {
      scale.value = withSpring(1, { damping: 12, stiffness: 220 });
    });
    Haptics.selectionAsync().catch(() => {});
    onToggle();
  };
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <TouchableOpacity onPress={onPress} hitSlop={8}>
      <Animated.View
        style={[
          s.checkbox,
          completed && s.checkboxOn,
          style,
        ]}
      >
        {completed && <Ionicons name="checkmark" size={18} color="#fff" />}
      </Animated.View>
    </TouchableOpacity>
  );
}

function ItemRow({ item, onToggle, isLast }) {
  return (
    <View style={[s.itemRow, !isLast && s.itemRowBorder]}>
      <Checkbox completed={item.completed} onToggle={onToggle} />
      <TouchableOpacity style={s.itemContent} onPress={onToggle} activeOpacity={0.7}>
        <Text style={[s.itemName, item.completed && s.itemNameDone]}>{item.productName}</Text>
        {!!item.instructions && (
          <Text style={[s.itemInstr, item.completed && s.itemInstrDone]}>{item.instructions}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const SECTION_LABELS = {
  morning:    { label: 'Утро',          icon: 'sunny-outline' },
  evening:    { label: 'Вечер',         icon: 'moon-outline' },
  additional: { label: 'Дополнительно', icon: 'sparkles-outline' },
};

function Section({ id, items, onToggle, isCurrent, delay = 0 }) {
  if (!items || items.length === 0) return null;
  const meta = SECTION_LABELS[id];
  return (
    <Reveal delay={delay}>
      <View style={[s.sectionCard, isCurrent && s.sectionCardCurrent]}>
        <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,252,248,0.55)', 'rgba(237,233,227,0.30)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.sectionInner}>
          <View style={s.sectionHeader}>
            <Ionicons name={meta.icon} size={18} color={T.champagne} />
            <Text style={s.sectionTitle}>{meta.label}</Text>
            {isCurrent && (
              <View style={s.nowBadge}>
                <Text style={s.nowBadgeText}>Сейчас</Text>
              </View>
            )}
          </View>
          {items.map((item, i) => (
            <ItemRow
              key={item.id}
              item={item}
              isLast={i === items.length - 1}
              onToggle={() => onToggle(item)}
            />
          ))}
        </View>
      </View>
    </Reveal>
  );
}

export default function TodayChecklistScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const data       = useClientStore(st => st.todayChecklist);
  const loading    = useClientStore(st => st.todayChecklistLoading);
  const fetchToday = useClientStore(st => st.fetchTodayChecklist);
  const toggleItem = useClientStore(st => st.toggleItemCompletion);

  useEffect(() => { fetchToday(); }, []);
  useFocusEffect(useCallback(() => { fetchToday(); }, [fetchToday]));

  const onRefresh = useCallback(() => { fetchToday(); }, [fetchToday]);

  const onToggleItem = async (item) => {
    try {
      await toggleItem(item.id, item.completed);
    } catch (e) {
      Alert.alert('Не удалось сохранить', 'Попробуйте ещё раз');
    }
  };

  const total     = data?.summary?.total ?? 0;
  const completed = data?.summary?.completed ?? 0;
  const pct       = total === 0 ? 0 : Math.round((100 * completed) / total);
  const allDone   = total > 0 && completed === total;
  const cur       = currentTimeOfDay();

  const dateStr = data?.date
    ? format(parseDate(data.date), "d MMMM, EEEE", { locale: ru })
    : '';

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
        <Text style={s.headerTitle}>Уход сегодня</Text>
        {!!dateStr && <Text style={s.headerDate}>{dateStr}</Text>}
        {total > 0 && (
          <View style={s.progressWrap}>
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${pct}%` }]} />
            </View>
            <Text style={s.progressText}>{completed} / {total}</Text>
          </View>
        )}
        {allDone && <Text style={s.allDone}>Сегодня всё выполнено · так держать</Text>}
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.champagne} />}
      >
        {!loading && total === 0 && (
          <Reveal delay={100}>
            <View style={s.empty}>
              <Ionicons name="leaf-outline" size={48} color={T.stoneFaint} />
              <Text style={s.emptyTitle}>На сегодня нет уходовых процедур</Text>
              <Text style={s.emptyText}>Загляните завтра — назначения ждут вас по расписанию</Text>
            </View>
          </Reveal>
        )}

        {data && (
          <>
            <Section
              id="morning"
              items={data.sections.morning}
              onToggle={onToggleItem}
              isCurrent={cur === 'morning'}
              delay={60}
            />
            <Section
              id="evening"
              items={data.sections.evening}
              onToggle={onToggleItem}
              isCurrent={cur === 'evening'}
              delay={120}
            />
            <Section
              id="additional"
              items={data.sections.additional}
              onToggle={onToggleItem}
              isCurrent={false}
              delay={180}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: T.pearl },
  header: {
    paddingHorizontal: 20, paddingBottom: 16,
    zIndex: 10, overflow: 'hidden',
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.18)',
  },
  backBtn:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  backText: { fontSize: 14, color: T.champagne, marginLeft: 2 },
  headerTitle: { fontSize: 26, color: T.stone, fontFamily: 'serif' },
  headerDate:  { fontSize: 13, color: T.stoneMid, marginTop: 2 },

  progressWrap: {
    marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  progressTrack: {
    flex: 1, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(212,175,55,0.18)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: T.champagne },
  progressText: { fontSize: 13, color: T.stoneMid, fontWeight: '600' },

  allDone: {
    marginTop: 8, fontSize: 13, color: T.champagne,
    fontStyle: 'italic',
  },

  scroll: { flex: 1 },
  list:   { padding: 12, gap: 10 },

  sectionCard: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: 'rgba(100,90,70,0.12)', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12, elevation: 4,
  },
  sectionCardCurrent: { borderColor: T.champStrong, borderWidth: 1.5 },
  sectionInner:   { padding: 16 },
  sectionHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle:   { fontSize: 15, fontWeight: '700', color: T.stone, flex: 1 },
  nowBadge: {
    backgroundColor: T.champGlow,
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2,
  },
  nowBadgeText: { fontSize: 10, color: T.champagne, fontWeight: '700', letterSpacing: 0.4 },

  itemRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: 10, gap: 12,
  },
  itemRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(74,69,64,0.08)' },
  itemContent:   { flex: 1 },
  itemName:      { fontSize: 15, color: T.stone, fontWeight: '500' },
  itemNameDone:  { color: T.stoneFaint, textDecorationLine: 'line-through' },
  itemInstr:     { fontSize: 12, color: T.stoneMid, marginTop: 3, lineHeight: 17 },
  itemInstrDone: { color: T.stoneFaint },

  checkbox: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 2, borderColor: T.champGlow,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'transparent',
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: T.champagne, borderColor: T.champagne },

  empty: { alignItems: 'center', paddingTop: 80, gap: 10, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16, color: T.stone, fontWeight: '600', textAlign: 'center' },
  emptyText:  { fontSize: 13, color: T.stoneMid, textAlign: 'center' },
});
```

- [ ] **Step 2: Зарегистрировать экран в `App.js`**

В `App.js` найти `import PrescriptionDetailScreen from './src/screens/PrescriptionDetailScreen';` и добавить ниже:

```js
import TodayChecklistScreen   from './src/screens/TodayChecklistScreen';
```

(Регистрация в навигаторе — отдельный Task 7. На этом шаге — только импорт, чтобы не блокировать smoke-тест через прямой `navigation.navigate('TodayChecklist')` с другого экрана. Если хочешь чистоты — пропусти Step 2 и Step 3, дойди до Task 7. Smoke-тест экрана отложится туда же.)

- [ ] **Step 3: Smoke-тест (после Task 7 регистрации)**

Открыть приложение, на эмуляторе/устройстве перейти на экран TodayChecklist (через баннер на главной — Task 6 — или прямой вызов из консоли). Проверить:
- Шапка показывает дату прописью и счётчик (если есть items на сегодня).
- Видны секции «Утро/Вечер/Дополнительно» (только те, в которых есть items).
- Тап по чекбоксу: моментальная заливка champagne, лёгкая haptic, через сек ответ от бэка приходит и состояние не откатывается.
- Тап ещё раз — снимает галочку (DELETE на бэк).
- Pull-to-refresh обновляет данные.
- Текущая по времени секция (утро/вечер) имеет более яркий бордер и бейдж «Сейчас».
- При 100% выполнения — под прогресс-баром появляется надпись «Сегодня всё выполнено · так держать».
- Если на сегодня ничего нет — пустое состояние с иконкой и текстом.

- [ ] **Step 4: Commit**

```bash
cd /root/mobile && git add src/screens/TodayChecklistScreen.js App.js
git commit -m "feat(screens): add TodayChecklistScreen with section cards and checkboxes

Renders three sections (morning/evening/additional), highlights the
current-time section with a stronger border + 'Сейчас' badge.
Optimistic toggle via store, haptic on tap, rolls back on API error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AdherenceCalendarScreen — heatmap-календарь для пациента

**Files:**
- Create: `/root/mobile/src/screens/AdherenceCalendarScreen.js`

- [ ] **Step 1: Создать файл**

```js
/**
 * AdherenceCalendarScreen — месячный календарь выполнения для пациента
 * Принимает route.params.prescriptionId
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, ScrollView, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

const T = {
  pearl:     '#F5F3F0',
  silk:      '#EDE9E3',
  champagne: '#D4AF37',
  champGlow: 'rgba(212,175,55,0.18)',
  stone:     '#4A4540',
  stoneMid:  '#7A736B',
  stoneFaint:'rgba(74,69,64,0.40)',
  cellEmpty: '#e6e2dc',
  cell0:     '#f4d4d4',
  cellLow:   '#f4e4b6',
  cellMid:   '#f0c98a',
  cellFull:  '#bee0bf',
};

function parseDate(v) { return new Date(String(v).slice(0, 10) + 'T00:00:00'); }
function ymd(d)       { return d.toISOString().slice(0, 10); }
function startOfMonth(d){ const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
function addMonths(d, n){ const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function isoDow(d)     { return (d.getDay() + 6) % 7; }   // 0=Пн..6=Вс

function cellColor(cell) {
  if (!cell) return 'transparent';
  if (cell.expected === 0) return T.cellEmpty;
  const r = cell.completed / cell.expected;
  if (r === 0)  return T.cell0;
  if (r < 0.5)  return T.cellLow;
  if (r < 1)    return T.cellMid;
  return T.cellFull;
}

export default function AdherenceCalendarScreen({ route, navigation }) {
  const { prescriptionId } = route.params;
  const insets = useSafeAreaInsets();
  const data    = useClientStore(st => st.adherenceData);
  const loading = useClientStore(st => st.adherenceLoading);
  const fetch_  = useClientStore(st => st.fetchAdherence);

  useEffect(() => { fetch_(prescriptionId); }, [prescriptionId]);

  const startDate = data?.prescription?.startDate ? parseDate(data.prescription.startDate) : null;
  const endDate   = data?.prescription?.endDate   ? parseDate(data.prescription.endDate)   : null;
  const today     = new Date(); today.setHours(0,0,0,0);
  const lastDay   = endDate && endDate < today ? endDate : today;

  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));

  // При получении данных — выставляем месяц последней активности
  useEffect(() => {
    if (lastDay) setViewMonth(startOfMonth(lastDay));
  }, [data]);

  const dayMap = useMemo(() => {
    const m = {};
    (data?.days || []).forEach(d => { m[d.date] = d; });
    return m;
  }, [data]);

  const weeks = useMemo(() => {
    if (!startDate) return [];
    const monthStart = startOfMonth(viewMonth);
    const monthEnd   = addMonths(monthStart, 1); monthEnd.setDate(0); monthEnd.setHours(0,0,0,0);
    const gridStart  = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - isoDow(monthStart));
    const result = [];
    let cur = new Date(gridStart);
    while (cur <= monthEnd) {
      const w = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(cur);
        const inMonth  = d.getMonth() === monthStart.getMonth();
        const inCourse = d >= startDate && d <= lastDay;
        w.push({ date: ymd(d), inMonth, inCourse, cell: dayMap[ymd(d)] });
        cur.setDate(cur.getDate() + 1);
      }
      result.push(w);
    }
    return result;
  }, [viewMonth, dayMap, startDate, lastDay]);

  const canPrev = startDate && startOfMonth(viewMonth) > startOfMonth(startDate);
  const canNext = lastDay && startOfMonth(viewMonth) < startOfMonth(lastDay);

  const adherencePct = data?.prescription?.adherencePct;
  const totals = useMemo(() => {
    const exp = (data?.days || []).reduce((a, d) => a + d.expected, 0);
    const dn  = (data?.days || []).reduce((a, d) => a + d.completed, 0);
    return { expected: exp, completed: dn };
  }, [data]);

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
        <Text style={s.headerTitle}>Календарь выполнения</Text>
      </View>

      {loading && !data ? (
        <View style={s.loader}><ActivityIndicator color={T.champagne} /></View>
      ) : !data ? (
        <View style={s.loader}><Text style={{ color: T.stoneMid }}>Не удалось загрузить</Text></View>
      ) : (
        <ScrollView
          contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 96 }]}
        >
          <View style={s.summaryCard}>
            <Text style={s.summaryPct}>{adherencePct === null || adherencePct === undefined ? '—' : `${adherencePct}%`}</Text>
            <Text style={s.summarySub}>
              Выполнено {totals.completed} из {totals.expected}
            </Text>
            {!!startDate && (
              <Text style={s.summarySub}>
                Курс: {format(startDate, 'd MMM yyyy', { locale: ru })}
                {endDate ? ` → ${format(endDate, 'd MMM yyyy', { locale: ru })}` : ' · бессрочно'}
              </Text>
            )}
          </View>

          <View style={s.monthNav}>
            <TouchableOpacity onPress={() => canPrev && setViewMonth(addMonths(viewMonth, -1))}
                              disabled={!canPrev} style={s.navBtn}>
              <Ionicons name="chevron-back" size={20}
                        color={canPrev ? T.champagne : T.stoneFaint} />
            </TouchableOpacity>
            <Text style={s.monthTitle}>
              {format(viewMonth, 'LLLL yyyy', { locale: ru })}
            </Text>
            <TouchableOpacity onPress={() => canNext && setViewMonth(addMonths(viewMonth, +1))}
                              disabled={!canNext} style={s.navBtn}>
              <Ionicons name="chevron-forward" size={20}
                        color={canNext ? T.champagne : T.stoneFaint} />
            </TouchableOpacity>
          </View>

          <View style={s.weekHeader}>
            {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => (
              <Text key={d} style={s.weekDay}>{d}</Text>
            ))}
          </View>

          <View style={s.calendar}>
            {weeks.map((w, wi) => (
              <View key={wi} style={s.week}>
                {w.map((cell, i) => (
                  <View key={i} style={s.dayWrap}>
                    {cell.inMonth && cell.inCourse ? (
                      <View
                        style={[s.dayCell, { backgroundColor: cellColor(cell.cell || { expected: 0, completed: 0 }) }]}
                      >
                        <Text style={[
                          s.dayNumber,
                          (cell.cell?.expected || 0) === 0 && { color: T.stoneFaint },
                        ]}>
                          {parseInt(cell.date.slice(8, 10), 10)}
                        </Text>
                      </View>
                    ) : (
                      <View style={s.dayEmpty}>
                        {cell.inMonth && (
                          <Text style={s.dayNumberOff}>
                            {parseInt(cell.date.slice(8, 10), 10)}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            ))}
          </View>

          <View style={s.legend}>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: T.cellEmpty }]} />
              <Text style={s.legendText}>нет назначений</Text>
            </View>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: T.cell0 }]} />
              <Text style={s.legendText}>0%</Text>
            </View>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: T.cellLow }]} />
              <Text style={s.legendText}>&lt;50%</Text>
            </View>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: T.cellMid }]} />
              <Text style={s.legendText}>&lt;100%</Text>
            </View>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: T.cellFull }]} />
              <Text style={s.legendText}>100%</Text>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },
  header: {
    paddingHorizontal: 20, paddingBottom: 14,
    overflow: 'hidden', zIndex: 10,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.18)',
  },
  backBtn:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  backText: { fontSize: 14, color: T.champagne, marginLeft: 2 },
  headerTitle: { fontSize: 22, color: T.stone, fontFamily: 'serif' },

  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body:   { padding: 16, gap: 14 },

  summaryCard: {
    backgroundColor: 'rgba(255,252,248,0.7)',
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
  },
  summaryPct: { fontSize: 32, fontWeight: '700', color: T.champagne, fontFamily: 'serif' },
  summarySub: { fontSize: 13, color: T.stoneMid, marginTop: 4 },

  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 4,
  },
  monthTitle: { fontSize: 16, color: T.stone, fontWeight: '600', textTransform: 'capitalize' },
  navBtn:    { padding: 8 },

  weekHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  weekDay:    { flex: 1, textAlign: 'center', fontSize: 11, color: T.stoneMid, textTransform: 'uppercase' },

  calendar: { gap: 4 },
  week:     { flexDirection: 'row', gap: 4 },
  dayWrap:  { flex: 1, aspectRatio: 1 },
  dayCell:  { flex: 1, borderRadius: 6, justifyContent: 'center', alignItems: 'center' },
  dayEmpty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  dayNumber:    { fontSize: 12, color: T.stone, fontWeight: '600' },
  dayNumberOff: { fontSize: 12, color: T.stoneFaint },

  legend: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 },
  legendRow:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot:  { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: 11, color: T.stoneMid },
});
```

- [ ] **Step 2: Импорт в `App.js`**

В `App.js` рядом с уже добавленным импортом `TodayChecklistScreen`:

```js
import AdherenceCalendarScreen from './src/screens/AdherenceCalendarScreen';
```

- [ ] **Step 3: Commit**

```bash
cd /root/mobile && git add src/screens/AdherenceCalendarScreen.js App.js
git commit -m "feat(screens): add AdherenceCalendarScreen for patient

Monthly grid Mon-start, 5 color levels by completed/expected ratio,
month navigation clamped to course start_date / min(end_date, today).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PrescriptionDetailScreen — даты курса, точки дней, мини-heatmap

**Files:**
- Modify: `/root/mobile/src/screens/PrescriptionDetailScreen.js`

- [ ] **Step 1: Открыть файл и сориентироваться**

Текущий `PrescriptionDetailScreen.js` (создан в плане prescriptions, см. `2026-04-16-prescriptions.md` Task 6) содержит:
- константу `SECTION_MAP`;
- компонент `Reveal` (анимация);
- компонент `ItemRow` рендерит `productName + instructions`;
- компонент `SectionCard` / `SubSection`;
- `useClientStore(st => st.prescriptionDetail)`.

Нужно: (1) добавить в state экрана adherence-данные, (2) показать строку периода курса в шапке, (3) показать точки дней недели в `ItemRow` для homecare-секции, (4) добавить блок «adherence + мини-heatmap» над секцией «Домашний уход».

- [ ] **Step 2: Подтянуть adherence в экран**

В функции `PrescriptionDetailScreen` рядом с уже существующими селекторами добавить:

```js
const adherence       = useClientStore(st => st.adherenceData);
const adherenceLoading= useClientStore(st => st.adherenceLoading);
const fetchAdherence  = useClientStore(st => st.fetchAdherence);

// fetch adherence когда экран получает prescriptionId (после fetchPrescriptionDetail)
useEffect(() => {
  if (prescriptionId) fetchAdherence(prescriptionId);
}, [prescriptionId]);
```

(Если в текущем коде уже есть `useEffect(() => { fetchPrescriptionDetail(prescriptionId); }, [prescriptionId]);` — добавить вторым useEffect рядом.)

- [ ] **Step 3: Хелперы для дат и расчёта окна heatmap**

Добавить в начале файла (после импортов):

```js
function parseISODate(v) { return new Date(String(v).slice(0, 10) + 'T00:00:00'); }
function fmtDate(d, opts) { return format(d, opts.fmt, { locale: ru }); }

// Окно мини-heatmap: до 30 дней, заканчивающихся на min(endDate, today), не раньше startDate
function takeLast30(days) {
  if (!days || days.length === 0) return [];
  return days.slice(-30);
}

const RU_DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
```

- [ ] **Step 4: Шапка с периодом курса**

В рендере экрана найти текущий блок шапки (после `<BlurView intensity={40} tint="light" .../>` в `<View style={s.header}>`). Под `<Text style={s.headerTitle}>Назначение</Text>` и текущей датой добавить:

```jsx
{!!prescription?.startDate && (
  <View style={s.coursePill}>
    <Ionicons name="calendar-outline" size={12} color={T.champagne} />
    <Text style={s.coursePillText}>
      {(() => {
        const sd = parseISODate(prescription.startDate);
        const today = new Date(); today.setHours(0,0,0,0);
        const ed = prescription.endDate ? parseISODate(prescription.endDate) : null;
        const leftStr = format(sd, 'd MMM', { locale: ru });
        const rightStr = ed ? format(ed, 'd MMM yyyy', { locale: ru }) : 'бессрочно';
        let suffix = '';
        if (sd > today) {
          const diff = Math.ceil((sd - today) / 86400000);
          suffix = ` · Старт через ${diff} дн.`;
        } else if (ed && ed < today) {
          suffix = ' · Курс завершён';
        }
        return `Курс: ${leftStr} → ${rightStr}${suffix}`;
      })()}
    </Text>
  </View>
)}
```

В стайлы (`const s = StyleSheet.create(...)`) добавить:

```js
coursePill: {
  marginTop: 8, alignSelf: 'flex-start',
  flexDirection: 'row', alignItems: 'center', gap: 6,
  backgroundColor: T.champGlow,
  borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
},
coursePillText: { fontSize: 12, color: T.champagne, fontWeight: '600' },
```

- [ ] **Step 5: Блок adherence + мини-heatmap над секцией «Домашний уход»**

Перед `{/* Домашний уход */}` (там, где сейчас рендерится `<SectionCard title="Домашний уход" ...>`) вставить:

```jsx
{adherence?.prescription?.adherencePct !== undefined &&
 adherence?.prescription?.adherencePct !== null && (
  <Reveal delay={40}>
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => navigation.navigate('AdherenceCalendar', { prescriptionId })}
      style={s.adhCard}
    >
      <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
      <View style={s.adhInner}>
        <View style={s.adhLeft}>
          <Text style={s.adhPct}>{adherence.prescription.adherencePct}%</Text>
          <Text style={s.adhLabel}>выполнено</Text>
        </View>
        <View style={s.adhStrip}>
          {takeLast30(adherence.days).map((d, i) => {
            let bg = T.heatEmpty;
            if (d.expected > 0) {
              const r = d.completed / d.expected;
              if (r === 0)        bg = T.heat0;
              else if (r < 0.5)   bg = T.heatLow;
              else if (r < 1)     bg = T.heatMid;
              else                bg = T.heatFull;
            }
            return <View key={i} style={[s.adhCell, { backgroundColor: bg }]} />;
          })}
        </View>
        <Ionicons name="chevron-forward" size={18} color={T.champagne} />
      </View>
    </TouchableOpacity>
  </Reveal>
)}
```

Добавить к T:

```js
const T = {
  // ... существующие ключи ...
  heatEmpty: '#e6e2dc',
  heat0:     '#f4d4d4',
  heatLow:   '#f4e4b6',
  heatMid:   '#f0c98a',
  heatFull:  '#bee0bf',
};
```

В стайлы:

```js
adhCard: {
  borderRadius: 16, overflow: 'hidden', marginBottom: 10,
  borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
  shadowColor: 'rgba(100,90,70,0.10)', shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 1, shadowRadius: 8, elevation: 3,
  backgroundColor: 'rgba(255,252,248,0.6)',
},
adhInner: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
adhLeft:  { alignItems: 'center', minWidth: 60 },
adhPct:   { fontSize: 22, fontWeight: '700', color: T.champagne, fontFamily: 'serif' },
adhLabel: { fontSize: 10, color: T.stoneMid, textTransform: 'uppercase', letterSpacing: 0.4 },
adhStrip: {
  flex: 1, flexDirection: 'row', justifyContent: 'flex-end',
  alignItems: 'center', gap: 2,
},
adhCell:  { width: 7, height: 24, borderRadius: 1.5 },
```

(Полоса выровнена по правому краю — последние 30 дней «упираются» в стрелку, как и предусмотрено спекой 4.4.)

- [ ] **Step 6: Точки дней недели в ItemRow для homecare**

В компоненте `ItemRow` найти текущий jsx и расширить его. Если сигнатура была `function ItemRow({ item, isLast })` — менять на:

```js
function ItemRow({ item, isLast, isHomecare }) {
  const days = isHomecare ? item.daysOfWeek : null;
  const showDots = Array.isArray(days) && days.length > 0 && days.length < 7;

  return (
    <View style={[s.itemRow, !isLast && s.itemRowBorder]}>
      <View style={s.itemDot} />
      <View style={s.itemContent}>
        <View style={s.itemNameWrap}>
          <Text style={s.itemName}>{item.productName}</Text>
          {showDots && (
            <View style={s.dowWrap}>
              {RU_DOW.map((label, idx) => (
                <View key={idx} style={[
                  s.dowDot,
                  days.includes(idx) ? s.dowDotOn : s.dowDotOff,
                ]} />
              ))}
            </View>
          )}
        </View>
        {!!item.instructions && (
          <Text style={s.itemInstr}>{item.instructions}</Text>
        )}
      </View>
    </View>
  );
}
```

В `SubSection`-вызовы `ItemRow` пробросить `isHomecare` через пропсы (`isHomecare={section === 'homecare'}` где section определяется по SECTION_MAP).

В стайлы:

```js
itemNameWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
dowWrap:      { flexDirection: 'row', gap: 2.5, marginLeft: 'auto' },
dowDot:       { width: 5, height: 5, borderRadius: 2.5 },
dowDotOn:     { backgroundColor: T.champagne },
dowDotOff:    { backgroundColor: 'rgba(74,69,64,0.18)' },
```

- [ ] **Step 7: Smoke-тест**

В приложении: открыть существующее назначение домашнего ухода с расписанием.
- В шапке экрана видна пилюля «Курс: 5 мая → 4 июня».
- Над секцией «Домашний уход» — карточка с цифрой % и полоской из квадратиков; тап → переход на `AdherenceCalendarScreen`.
- В каждом item-строке секции «Домашний уход» — справа от названия 7 точек, активные дни champagne, остальные серые.

Если расписание ежедневное (`days_of_week = null`) — точки не отображаются (`showDots === false`). Это ожидаемо.

- [ ] **Step 8: Commit**

```bash
cd /root/mobile && git add src/screens/PrescriptionDetailScreen.js
git commit -m "feat(prescription-detail): course period pill, adherence card, days-of-week dots

Header now shows 'Курс: …' with status suffix when applicable.
A new tappable adherence card sits above 'Домашний уход' showing
adherencePct + last-30-days mini-heatmap → AdherenceCalendarScreen.
Item rows in homecare section show 7 weekday dots (only when
daysOfWeek is a partial subset).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: HomeScreen — баннер «Уход сегодня» + кнопка кабинета

**Files:**
- Modify: `/root/mobile/src/screens/HomeScreen.js`

- [ ] **Step 1: Подтянуть данные чек-листа на экран**

В `HomeScreen.js` рядом с существующими селекторами `useClientStore` добавить:

```js
const todayChecklist  = useClientStore(st => st.todayChecklist);
const fetchToday      = useClientStore(st => st.fetchTodayChecklist);
```

Найти существующие `useEffect` для `fetchProfile`/`fetchBookings`/etc. Добавить рядом:

```js
useEffect(() => { fetchToday(); }, []);
```

Если есть `useFocusEffect` для перезагрузки на возвращении на главную — добавить туда `fetchToday()` тоже.

- [ ] **Step 2: Импорты, если не было**

```js
import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';
```

И:

```js
useFocusEffect(useCallback(() => { fetchToday(); }, [fetchToday]));
```

- [ ] **Step 3: Рендер баннера**

В JSX `HomeScreen` найти место выше всех существующих секций (но ниже шапки приветствия). Добавить:

```jsx
{!!todayChecklist && todayChecklist.summary?.total > 0 && (
  <Reveal delay={40}>
    <TouchableOpacity
      style={[
        s.todayBanner,
        todayChecklist.summary.completed === todayChecklist.summary.total && s.todayBannerDone,
      ]}
      activeOpacity={0.85}
      onPress={() => navigation.navigate('TodayChecklist')}
    >
      <BlurView intensity={26} tint="light" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={
          todayChecklist.summary.completed === todayChecklist.summary.total
            ? ['rgba(190,224,191,0.50)', 'rgba(190,224,191,0.30)']
            : ['rgba(255,252,248,0.55)', 'rgba(212,175,55,0.10)']
        }
        style={StyleSheet.absoluteFill}
      />
      <View style={s.todayInner}>
        <View style={s.todayIconWrap}>
          <Ionicons
            name={todayChecklist.summary.completed === todayChecklist.summary.total
              ? 'checkmark-circle' : 'leaf-outline'}
            size={22}
            color={T.champagne}
          />
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.todayTopRow}>
            <Text style={s.todayTitle}>
              {todayChecklist.summary.completed === todayChecklist.summary.total
                ? 'Сегодня всё выполнено'
                : 'Уход сегодня'}
            </Text>
            <Text style={s.todayCount}>
              {todayChecklist.summary.completed} / {todayChecklist.summary.total}
            </Text>
          </View>
          <View style={s.todayProgressTrack}>
            <View
              style={[
                s.todayProgressFill,
                {
                  width: `${Math.round(
                    (100 * todayChecklist.summary.completed) /
                    Math.max(todayChecklist.summary.total, 1)
                  )}%`,
                },
              ]}
            />
          </View>
          <Text style={s.todaySub}>
            {[
              todayChecklist.sections.morning?.length
                ? `Утро ${
                    todayChecklist.sections.morning.filter(i => i.completed).length
                  }/${todayChecklist.sections.morning.length}`
                : null,
              todayChecklist.sections.evening?.length
                ? `Вечер ${
                    todayChecklist.sections.evening.filter(i => i.completed).length
                  }/${todayChecklist.sections.evening.length}`
                : null,
              todayChecklist.sections.additional?.length
                ? `Доп ${
                    todayChecklist.sections.additional.filter(i => i.completed).length
                  }/${todayChecklist.sections.additional.length}`
                : null,
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={T.champagne} />
      </View>
    </TouchableOpacity>
  </Reveal>
)}
```

(Если в HomeScreen уже есть локальный `Reveal` / `T` — используй их. Иначе импортируй из общего стиля или скопируй мини-версии аналогично TodayChecklistScreen.)

- [ ] **Step 4: Стили баннера**

```js
todayBanner: {
  marginHorizontal: 16, marginTop: 8, marginBottom: 12,
  borderRadius: 18, overflow: 'hidden',
  borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
  shadowColor: 'rgba(100,90,70,0.12)', shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 1, shadowRadius: 12, elevation: 4,
},
todayBannerDone: { borderColor: 'rgba(190,224,191,0.7)' },
todayInner: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
todayIconWrap: {
  width: 38, height: 38, borderRadius: 19,
  backgroundColor: 'rgba(212,175,55,0.18)',
  justifyContent: 'center', alignItems: 'center',
},
todayTopRow:    { flexDirection: 'row', alignItems: 'baseline' },
todayTitle:     { flex: 1, fontSize: 15, fontWeight: '600', color: '#4A4540' },
todayCount:     { fontSize: 13, color: '#D4AF37', fontWeight: '700' },
todayProgressTrack: {
  marginTop: 6, height: 4, borderRadius: 2,
  backgroundColor: 'rgba(212,175,55,0.16)', overflow: 'hidden',
},
todayProgressFill: { height: '100%', backgroundColor: '#D4AF37' },
todaySub: { marginTop: 6, fontSize: 11, color: '#7A736B' },
```

- [ ] **Step 5: Кнопка «Уход сегодня» в кабинете**

Найти массив `cabinetItems` (есть, например, элемент `{ icon: 'gift-outline', label: 'Бонусы', nav: 'Bonuses', delay: 660 }`). Добавить после кнопки «Назначения»:

```js
{ icon: 'checkmark-done-outline', label: 'Уход сегодня', nav: 'TodayChecklist', delay: 740 }
```

- [ ] **Step 6: Smoke-тест**

В приложении на главной:
- Если есть назначение, попадающее на сегодня — баннер виден сразу под шапкой; счётчик `0 / N`, тап → TodayChecklist.
- После отметки галочки и возвращения назад — счётчик в баннере обновляется (через `useFocusEffect`).
- Если все галочки = `total` — баннер становится зеленоватым, заголовок «Сегодня всё выполнено», иконка `checkmark-circle`.
- Если назначений на сегодня нет — баннер не показывается (главная как до изменений).
- В блоке «Кабинет» появилась плитка «Уход сегодня», тап → TodayChecklist.

- [ ] **Step 7: Commit**

```bash
cd /root/mobile && git add src/screens/HomeScreen.js
git commit -m "feat(home): add 'Уход сегодня' banner and cabinet button

Banner appears only when summary.total > 0. Greenish state when
completed === total. Cabinet now has a permanent 'Уход сегодня'
shortcut so the screen is reachable even when no items today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: App.js — регистрация экранов в HomeStack

**Files:**
- Modify: `/root/mobile/App.js`

- [ ] **Step 1: Найти HomeStack**

В `App.js` есть несколько inline-стэков (по одному на таб: HomeStack, BookingsStack, BonusesStack, ContactsStack, ProfileStack — см. CLAUDE.md «бottom tab navigator with per-tab native stacks»). Найти `HomeStack` (он содержит `Home` как initialRouteName и уже регистрирует `Prescriptions`, `PrescriptionDetail`, `BookingDetail`).

- [ ] **Step 2: Добавить регистрации экранов**

Внутри JSX `<HomeStack.Navigator>` после существующих `<HomeStack.Screen name="PrescriptionDetail" .../>` и `<HomeStack.Screen name="Prescriptions" .../>` добавить:

```jsx
<HomeStack.Screen
  name="TodayChecklist"
  component={TodayChecklistScreen}
  options={{ headerShown: false }}
/>
<HomeStack.Screen
  name="AdherenceCalendar"
  component={AdherenceCalendarScreen}
  options={{ headerShown: false }}
/>
```

Регистрация ОБЯЗАТЕЛЬНО внутри HomeStack (а не в RootStack или другом табе) — иначе bottom tab bar с blur-плашкой исчезнет на этих экранах. Это явное требование из `CLAUDE.md` про per-tab stacks.

- [ ] **Step 3: Финальный smoke-тест**

Полный сценарий пациента:
1. Открыть приложение → главная показывает баннер «Уход сегодня · 0 / N» (при наличии активных назначений на сегодня).
2. Тап по баннеру → TodayChecklist открывается, виден прогресс-бар, секции, чекбоксы.
3. Отметить пару пунктов → счётчик и прогресс обновляются мгновенно.
4. Назад на главную → баннер показывает обновлённый счётчик.
5. Открыть «Назначения» → тап на любом prescription с homecare → видна шапка с периодом курса, точки дней недели в item-строках, карточка adherence над секцией.
6. Тап по карточке adherence → открывается AdherenceCalendarScreen с месячным календарём.
7. На обоих новых экранах нижняя tab-bar плашка с блюром остаётся видимой (как на BookingDetail).
8. В кабинете на главной — кнопка «Уход сегодня», тап → TodayChecklist даже если на сегодня ничего нет (тогда экран показывает пустое состояние).

Проверить по логам Expo, что нет красного экрана и нет необработанных ошибок Promise.

- [ ] **Step 4: Commit**

```bash
cd /root/mobile && git add App.js
git commit -m "feat(nav): register TodayChecklist and AdherenceCalendar in HomeStack

Both screens registered in HomeStack (not RootStack) so the bottom
tab blur bar stays visible on detail screens, per CLAUDE.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (от секции 7 «Критерии приёмки» в дизайн-доке):**

- ✅ Пациент видит баннер «Уход сегодня» на главной — Task 6 (баннер только при `summary.total > 0`)
- ✅ Тап открывает экран с галочками — Task 3 (TodayChecklistScreen) + Task 7 (регистрация в HomeStack)
- ✅ Галочки сохраняются на бэке — Task 2 (toggleItemCompletion → POST/DELETE)
- ✅ Optimistic update + откат при ошибке — Task 2 Step 3 (try/catch + Alert)
- ✅ После 00:00 нельзя — реализовано на бэке (план backend Task 7), мобильный UI просто не получит item за вчера в `today-checklist`
- ✅ В деталях назначения видна полоска adherence + мини-heatmap — Task 5 Step 5
- ✅ Точки дней недели на item-строках — Task 5 Step 6
- ✅ Период курса в шапке — Task 5 Step 4
- ✅ Полный месячный календарь по тапу — Task 4 (AdherenceCalendarScreen)
- ✅ Кнопка кабинета «Уход сегодня» — Task 6 Step 5

**Spec coverage (по разделу 4 спеки «Мобильное приложение»):**

- ✅ 4.1 TodayChecklistScreen со всеми деталями (haptic, animation, isCurrent, allDone) — Task 3
- ✅ 4.2 баннер на HomeScreen (условный показ, цветовые состояния) — Task 6
- ✅ 4.3 кнопка «Уход сегодня» в кабинете — Task 6 Step 5
- ✅ 4.4 PrescriptionDetailScreen расширения (3 пункта) — Task 5
- ✅ 4.5 AdherenceCalendarScreen — Task 4
- ✅ 4.6 store расширения (todayChecklist + adherenceData + 3 экшна) — Task 2
- ✅ 4.7 API клиент 4 метода — Task 1
- ✅ 4.8 навигация в HomeStack — Task 7

**Placeholder scan:** Нет TBD/TODO. Каждый шаг содержит либо полный код модуля, либо точечную диффовку с конкретными старыми и новыми строками. Команды проверки конкретны.

**Type/contract consistency:**

- `getTodayChecklist` (Task 1) → возвращает `{date, sections, summary}` → используется в `fetchTodayChecklist` (Task 2) с тем же набором ключей → читается в `TodayChecklistScreen` (Task 3) через `data?.summary?.total` и `data.sections.morning` ✓
- `markItemCompleted(id)` / `unmarkItemCompleted(id)` (Task 1) → вызываются в `toggleItemCompletion` (Task 2) ✓
- `getPrescriptionAdherence(id)` (Task 1) → возвращает `{prescription, days}` → используется в `fetchAdherence` (Task 2) → читается в `AdherenceCalendarScreen` (Task 4) и `PrescriptionDetailScreen` (Task 5) через `adherence?.prescription?.adherencePct` и `adherence.days` ✓
- `daysOfWeek` (camelCase) — приходит из бэка (план backend Task 9 — `i.days_of_week AS "daysOfWeek"`) → используется в `ItemRow` (Task 5 Step 6) и для расчёта `showDots` ✓
- `startDate` / `endDate` — приходят из бэка (план backend Task 9 — `p.start_date AS "startDate"`) → используются в шапке (Task 5 Step 4) ✓
- `summary.total` / `summary.completed` — устанавливаются в Task 2 Step 2, читаются в Task 3 (для прогресс-бара) и Task 6 (для баннера) ✓
- `0=Пн..6=Вс` индексация — единая в `RU_DOW = ['Пн','Вт',...,'Вс']` (Task 5) и `currentTimeOfDay()` использует `Date#getHours()` (не зависит от индексации DOW). Для AdherenceCalendarScreen `isoDow(d) = (d.getDay() + 6) % 7` — даёт ту же индексацию ✓
