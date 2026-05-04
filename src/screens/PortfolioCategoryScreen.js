/**
 * PortfolioCategoryScreen — 3-per-row grid of works inside one category.
 * Tap an item → PortfolioItemViewer modal.
 */
import React, { useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useClientStore } from '../store/clientStore';

const { width: SCREEN_W } = Dimensions.get('window');

const T = {
  pearl:      '#F5F3F0',
  silk:       '#EDE9E3',
  glass:      'rgba(255,252,248,0.72)',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

const GRID_GAP = 8;
const GRID_PADDING = 16;
const TILE_W = (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * 2) / 3;

export default function PortfolioCategoryScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { id, title } = route.params;

  const items = useClientStore((s) => s.portfolioItemsByCategory[id]) || [];
  const loading = useClientStore((s) => s.portfolioItemsLoading[id]) || false;
  const error = useClientStore((s) => s.error);
  const fetchPortfolioCategory = useClientStore((s) => s.fetchPortfolioCategory);

  const load = useCallback(() => fetchPortfolioCategory(id), [fetchPortfolioCategory, id]);

  useEffect(() => {
    if (items.length === 0) load();
  }, []);

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.tile}
      activeOpacity={0.85}
      onPress={() => {
        Haptics.selectionAsync();
        navigation.navigate('PortfolioItemViewer', { item });
      }}
    >
      <Image
        source={{ uri: item.photoAfterUrl }}
        style={styles.tileImage}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={T.stone} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.champagne} />
        </View>
      ) : error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Не удалось загрузить</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>В этой категории пока нет работ</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          numColumns={3}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: GRID_PADDING, gap: GRID_GAP, paddingBottom: 24 }}
          columnWrapperStyle={{ gap: GRID_GAP }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={load} tintColor={T.champagne} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: T.pearl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 26,
    alignItems: 'flex-start',
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: T.stone,
    textAlign: 'center',
  },
  tile: {
    width: TILE_W,
    height: TILE_W,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: T.silk,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorText: {
    fontSize: 15,
    color: T.stoneMid,
    marginBottom: 16,
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: T.champagne,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 15,
    color: T.stoneFaint,
    textAlign: 'center',
  },
});
