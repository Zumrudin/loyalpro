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
