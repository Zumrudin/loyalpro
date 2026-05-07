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

function parseISODate(v) { return new Date(String(v).slice(0, 10) + 'T00:00:00'); }

const RU_DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.15)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
};

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

function SubSection({ label, items, isHomecare }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={s.subSection}>
      <Text style={s.subSectionLabel}>{label}</Text>
      {items.map((item, i) => (
        <ItemRow key={i} item={item} isLast={i === items.length - 1} isHomecare={isHomecare} />
      ))}
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

export default function PrescriptionDetailScreen({ route, navigation }) {
  const { prescriptionId } = route.params;
  const insets = useSafeAreaInsets();
  const prescription = useClientStore(st => st.prescriptionDetail);
  const loading = useClientStore(st => st.prescriptionDetailLoading);
  const fetchPrescriptionDetail = useClientStore(st => st.fetchPrescriptionDetail);

  useEffect(() => { fetchPrescriptionDetail(prescriptionId); }, [prescriptionId]);

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

          {Object.keys(grouped.homecare).length > 0 && (
            <SectionCard title="Домашний уход" icon="home-outline" delay={60}>
              {Object.entries(grouped.homecare).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} isHomecare />
              ))}
            </SectionCard>
          )}

          {Object.keys(grouped.sheet).length > 0 && (
            <SectionCard title="Лист назначения" icon="document-text-outline" delay={120}>
              {Object.entries(grouped.sheet).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} />
              ))}
            </SectionCard>
          )}

          {Object.keys(grouped.vitamins).length > 0 && (
            <SectionCard title="Витамины и добавки" icon="leaf-outline" delay={180}>
              {Object.entries(grouped.vitamins).map(([label, items]) => (
                <SubSection key={label} label={label} items={items} />
              ))}
            </SectionCard>
          )}

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

  coursePill: {
    marginTop: 8, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: T.champGlow,
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
  },
  coursePillText: { fontSize: 12, color: T.champagne, fontWeight: '600' },

  itemNameWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  dowWrap:      { flexDirection: 'row', gap: 2.5, marginLeft: 'auto' },
  dowDot:       { width: 5, height: 5, borderRadius: 2.5 },
  dowDotOn:     { backgroundColor: T.champagne },
  dowDotOff:    { backgroundColor: 'rgba(74,69,64,0.18)' },
});
