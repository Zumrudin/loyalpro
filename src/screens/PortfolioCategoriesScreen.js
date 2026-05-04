/**
 * PortfolioCategoriesScreen — full grid of all portfolio categories (the
 * destination of the "Все" link from HomeScreen).
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useClientStore } from '../store/clientStore';
import { PortfolioCard } from '../components/PortfolioCard';

const T = {
  pearl:      '#F5F3F0',
  champagne:  '#D4AF37',
  stone:      '#4A4540',
  stoneMid:   '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
};

export default function PortfolioCategoriesScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const categories = useClientStore((s) => s.portfolioCategories);
  const loading = useClientStore((s) => s.portfolioCategoriesLoading);
  const fetchPortfolioCategories = useClientStore((s) => s.fetchPortfolioCategories);

  const onRefresh = useCallback(() => fetchPortfolioCategories(), [fetchPortfolioCategories]);

  const renderItem = ({ item }) => (
    <PortfolioCard
      category={item}
      size="grid"
      style={{ marginRight: 0 }}
      onPress={() => navigation.navigate('PortfolioCategory', { id: item.id, title: item.title })}
    />
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={T.pearl} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={T.stone} />
        </TouchableOpacity>
        <Text style={styles.title}>Портфолио работ</Text>
        <View style={{ width: 26 }} />
      </View>

      {categories.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Пока нет работ</Text>
        </View>
      ) : (
        <FlatList
          data={categories}
          numColumns={2}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 32 }}
          columnWrapperStyle={{ gap: 16 }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.champagne} />
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 15,
    color: T.stoneFaint,
    textAlign: 'center',
  },
});
