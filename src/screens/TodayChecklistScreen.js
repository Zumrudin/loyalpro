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
