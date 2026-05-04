/**
 * PortfolioItemViewer — modal-style screen with vertically stacked
 * Before/After photos, description, and the doctor who performed the work.
 *
 * Navigation: presented as modal (presentation: 'modal' on the route).
 * Receives the full item object via route.params.item.
 */
import React from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Dimensions,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  pearl:      '#F5F3F0',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  silk:       '#EDE9E3',
};

const PHOTO_W = SCREEN_W - 40;
const PHOTO_H = PHOTO_W * (5 / 4);

export default function PortfolioItemViewer({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const item = route.params?.item;

  if (!item) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.errorText}>Работа не найдена</Text>
      </View>
    );
  }

  const onSpecialistPress = () => {
    if (!item.specialist?.id) return;
    Haptics.selectionAsync();
    // Close the modal first, then push SpecialistDetail on the underlying stack.
    navigation.goBack();
    setTimeout(() => {
      navigation.navigate('SpecialistDetail', { id: item.specialist.id });
    }, 0);
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={{ width: 28 }} />
        <Text style={styles.headerTitle} numberOfLines={1}>До/после</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Ionicons name="close" size={28} color={T.stone} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 32,
        }}
        showsVerticalScrollIndicator={false}
      >
        {item.photoBeforeUrl && (
          <View style={styles.photoBlock}>
            <Text style={styles.photoLabel}>До</Text>
            <Image
              source={{ uri: item.photoBeforeUrl }}
              style={styles.photo}
              resizeMode="cover"
            />
          </View>
        )}

        <View style={styles.photoBlock}>
          <Text style={styles.photoLabel}>После</Text>
          <Image
            source={{ uri: item.photoAfterUrl }}
            style={styles.photo}
            resizeMode="cover"
          />
        </View>

        {!!item.title && (
          <Text style={styles.title}>{item.title}</Text>
        )}

        {!!item.description && (
          <Text style={styles.description}>{item.description}</Text>
        )}

        {item.specialist && (
          <Pressable onPress={onSpecialistPress} style={styles.specRow}>
            {item.specialist.photoUrl ? (
              <Image
                source={{ uri: item.specialist.photoUrl }}
                style={styles.specAvatar}
              />
            ) : (
              <View style={[styles.specAvatar, styles.specAvatarFallback]}>
                <Ionicons name="person" size={20} color={T.stoneMid} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.specCaption}>Выполнил(а)</Text>
              <Text style={styles.specName} numberOfLines={1}>{item.specialist.name}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.stoneFaint} />
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
  },
  photoBlock: {
    marginTop: 8,
    marginBottom: 24,
  },
  photoLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.5,
    color: T.champagne,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  photo: {
    width: PHOTO_W,
    height: PHOTO_H,
    borderRadius: 16,
    backgroundColor: T.silk,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: T.stone,
    marginTop: 8,
  },
  description: {
    fontSize: 14,
    color: T.stoneMid,
    lineHeight: 22,
    marginTop: 8,
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(74,69,64,0.15)',
  },
  specAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: T.silk,
  },
  specAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  specCaption: {
    fontSize: 11,
    color: T.stoneFaint,
    letterSpacing: 0.4,
  },
  specName: {
    fontSize: 15,
    color: T.stone,
    fontWeight: '500',
    marginTop: 2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 15,
    color: T.stoneMid,
  },
});
