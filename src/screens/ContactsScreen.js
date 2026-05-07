import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useAppSettingsStore } from '../store/appSettingsStore';

const T = {
  pearl:      '#F5F3F0',
  glass:      'rgba(255,252,248,0.72)',
  glassBorder:'rgba(255,255,255,0.85)',
  champagne:  '#D4AF37',
  champGlow:  'rgba(212,175,55,0.18)',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  shadow:     'rgba(100,90,70,0.12)',
};

function ContactRow({ icon, label, value, onPress }) {
  if (!value) return null;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={20} color={T.champagne} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={T.champagne} />
    </TouchableOpacity>
  );
}

export default function ContactsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { clinicName, phone, whatsapp, telegram, instagram, email } = useAppSettingsStore();

  const open = (url) => Linking.openURL(url).catch(() => {});

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <BlurView intensity={60} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(245,243,240,0.96)', 'rgba(237,233,227,0.88)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(212,175,55,0.25)' }} />
        <Text style={styles.headerTitle}>Контакты</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {!!clinicName && (
          <View style={styles.clinicCard}>
            <LinearGradient
              colors={[T.champGlow, 'transparent']}
              style={[StyleSheet.absoluteFill, { borderRadius: 20 }]}
            />
            <Ionicons name="business-outline" size={28} color={T.champagne} style={{ marginBottom: 10 }} />
            <Text style={styles.clinicName}>{clinicName}</Text>
          </View>
        )}

        <View style={styles.card}>
          <ContactRow
            icon="call-outline"
            label="Телефон"
            value={phone}
            onPress={() => open(`tel:${phone}`)}
          />
          <ContactRow
            icon="logo-whatsapp"
            label="WhatsApp"
            value={whatsapp}
            onPress={() => {
              const num = whatsapp.replace(/\D/g, '');
              open(`https://wa.me/${num}`);
            }}
          />
          <ContactRow
            icon="paper-plane-outline"
            label="Telegram"
            value={telegram}
            onPress={() => {
              const handle = telegram.startsWith('@') ? telegram.slice(1) : telegram;
              open(`https://t.me/${handle}`);
            }}
          />
          <ContactRow
            icon="logo-instagram"
            label="Instagram"
            value={instagram}
            onPress={() => {
              const handle = instagram.startsWith('@') ? instagram.slice(1) : instagram;
              open(`https://instagram.com/${handle}`);
            }}
          />
          <ContactRow
            icon="map-outline"
            label="Как добраться"
            value="Построить маршрут"
            onPress={() => navigation.navigate('RouteToClinic')}
          />
          <ContactRow
            icon="mail-outline"
            label="Email"
            value={email}
            onPress={() => open(`mailto:${email}`)}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },
  header: {
    overflow: 'hidden',
    paddingBottom: 16,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17, fontWeight: '600', color: T.stone, letterSpacing: 0.3,
  },
  content: { paddingTop: 24, paddingHorizontal: 20 },
  clinicCard: {
    borderRadius: 20, padding: 24, marginBottom: 20, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.champagne + '40',
    alignItems: 'center',
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10, shadowRadius: 14, elevation: 3,
  },
  clinicName: { fontSize: 20, color: T.stone, fontFamily: 'serif', textAlign: 'center' },
  card: {
    borderRadius: 20, overflow: 'hidden',
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    shadowColor: T.shadow, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.12)',
  },
  rowIcon: {
    width: 40, height: 40, borderRadius: 13,
    backgroundColor: T.champGlow, borderWidth: 1, borderColor: T.champagne + '30',
    justifyContent: 'center', alignItems: 'center', marginRight: 14,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 11, color: T.stoneMid, letterSpacing: 0.5, marginBottom: 2, textTransform: 'uppercase' },
  rowValue: { fontSize: 15, color: T.stone },
});
