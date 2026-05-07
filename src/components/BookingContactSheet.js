import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Linking,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useAppSettingsStore } from '../store/appSettingsStore';

// ─── Design tokens (mirrors HomeScreen palette) ────────────────
const T = {
  pearl:      '#F5F3F0',
  champagne:  '#D4AF37',
  champDark:  '#A8881C',
  stone:      '#4A4540',
  stoneMuted: 'rgba(74,69,64,0.60)',
  shadow:     'rgba(100,90,70,0.20)',
};

// ─── URL builders ──────────────────────────────────────────────
function buildPhoneUrl(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `tel:${digits}` : null;
}

function buildTelegramUrl(handle) {
  const raw = String(handle || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  const clean = raw.replace(/^@/, '');
  return clean ? `https://t.me/${encodeURIComponent(clean)}` : null;
}

function buildWhatsappUrl(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

function buildMaxUrl(handle) {
  const raw = String(handle || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  const clean = raw.replace(/^@/, '');
  return clean ? `https://max.ru/${encodeURIComponent(clean)}` : null;
}

// ─── Single channel button ─────────────────────────────────────
function ChannelButton({ icon, label, url, onClose }) {
  const handlePress = async () => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Не удалось открыть приложение');
    } finally {
      onClose();
    }
  };

  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.btn} onPress={handlePress}>
      <LinearGradient
        colors={[T.champagne, T.champDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <Ionicons name={icon} size={22} color="#fff" style={styles.btnIcon} />
      <Text style={styles.btnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Main sheet ────────────────────────────────────────────────
export default function BookingContactSheet({ visible, onClose }) {
  const phone    = useAppSettingsStore((s) => s.phone);
  const telegram = useAppSettingsStore((s) => s.telegram);
  const whatsapp = useAppSettingsStore((s) => s.whatsapp);
  const max      = useAppSettingsStore((s) => s.max);

  const phoneUrl    = buildPhoneUrl(phone);
  const telegramUrl = buildTelegramUrl(telegram);
  const whatsappUrl = buildWhatsappUrl(whatsapp);
  const maxUrl      = buildMaxUrl(max);

  const hasAny = phoneUrl || telegramUrl || whatsappUrl || maxUrl;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
      </Pressable>

      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Связаться с клиникой</Text>

        {!hasAny ? (
          <Text style={styles.empty}>Контакты клиники не настроены</Text>
        ) : (
          <View style={styles.btnList}>
            {phoneUrl && (
              <ChannelButton
                icon="call"
                label="Позвонить в клинику"
                url={phoneUrl}
                onClose={onClose}
              />
            )}
            {telegramUrl && (
              <ChannelButton
                icon="paper-plane"
                label="Telegram"
                url={telegramUrl}
                onClose={onClose}
              />
            )}
            {whatsappUrl && (
              <ChannelButton
                icon="logo-whatsapp"
                label="WhatsApp"
                url={whatsappUrl}
                onClose={onClose}
              />
            )}
            {maxUrl && (
              <ChannelButton
                icon="chatbubbles"
                label="MAX"
                url={maxUrl}
                onClose={onClose}
              />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: T.pearl,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    shadowColor: T.shadow,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: T.stoneMuted,
    marginBottom: 14,
    opacity: 0.4,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
    marginBottom: 18,
  },
  empty: {
    fontSize: 14,
    color: T.stoneMuted,
    textAlign: 'center',
    paddingVertical: 28,
  },
  btnList: {
    gap: 12,
  },
  btn: {
    height: 56,
    borderRadius: 16,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  btnIcon: {
    marginRight: 14,
  },
  btnLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
