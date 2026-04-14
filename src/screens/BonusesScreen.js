import React, { useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';

const { width } = Dimensions.get('window');

// Design tokens (matching HomeScreen aesthetic)
const T = {
  pearl: '#F5F3F0',
  silk: '#EDE9E3',
  glass: 'rgba(255,252,248,0.72)',
  glassBorder: 'rgba(255,255,255,0.85)',
  champagne: '#D4AF37',
  champLight: '#F0D882',
  champDark: '#A8881C',
  champGlow: 'rgba(212,175,55,0.18)',
  stone: '#4A4540',
  stoneMid: '#7A736B',
  stoneFaint: 'rgba(74,69,64,0.40)',
  stoneMuted: 'rgba(74,69,64,0.60)',
  shadow: 'rgba(100,90,70,0.12)',
  shadowDeep: 'rgba(100,90,70,0.20)',
};

export default function BonusesScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const bonuses = useClientStore((state) => state.bonuses);
  const bonusHistory = useClientStore((state) => state.bonusHistory);
  const bonusLoading = useClientStore((state) => state.bonusLoading);
  const fetchBonuses = useClientStore((state) => state.fetchBonuses);

  useEffect(() => {
    loadBonuses();
  }, []);

  const loadBonuses = async () => {
    await fetchBonuses();
    setRefreshing(false);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadBonuses();
  };

  const getTransactionColor = (type) => {
    switch (type) {
      case 'earned':
      case 'accrual':
        return T.champagne;
      case 'spent':
      case 'redeemed':
        return T.stone;
      default:
        return T.stoneMid;
    }
  };

  const getTransactionIcon = (type) => {
    switch (type) {
      case 'earned':
      case 'accrual':
        return 'add-circle-outline';
      case 'spent':
      case 'redeemed':
        return 'remove-circle-outline';
      default:
        return 'help-circle-outline';
    }
  };

  const getTransactionLabel = (type) => {
    switch (type) {
      case 'earned':
      case 'accrual':
        return 'Начислено';
      case 'spent':
      case 'redeemed':
        return 'Потрачено';
      default:
        return 'Транзакция';
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={24} color={T.stone} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Бонусы</Text>
        <View style={{ width: 40 }} />
      </View>

      {bonusLoading && !bonuses ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={T.champagne} />
        </View>
      ) : (
        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={T.champagne}
            />
          }
        >
          {/* Balance Card */}
          {bonuses && (
            <View style={styles.balanceCardContainer}>
              <LinearGradient
                colors={[T.champagne + '28', T.champLight + '10']}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
              <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="light" />

              <View style={styles.balanceCard}>
                <View style={styles.balanceTop}>
                  <View style={styles.balanceIconWrap}>
                    <Ionicons name="diamond" size={28} color={T.champagne} />
                  </View>
                  <Text style={styles.balanceLabel}>Бонусный баланс</Text>
                </View>

                <View style={styles.balanceDivider} />

                <View style={styles.balanceBottom}>
                  <Text style={styles.balanceValue}>
                    {bonuses.balance ?? 0}
                  </Text>
                  <Text style={styles.balanceCurrency}>₽</Text>
                </View>

                <View style={styles.balanceMeta}>
                  <View style={styles.metaItem}>
                    <Text style={styles.metaLabel}>Уровень</Text>
                    <Text style={styles.metaValue}>{bonuses.level || 'Новичок'}</Text>
                  </View>
                  {bonuses.nextLevelPoints && (
                    <View style={styles.metaItem}>
                      <Text style={styles.metaLabel}>До следующего уровня</Text>
                      <Text style={styles.metaValue}>{bonuses.nextLevelPoints}</Text>
                    </View>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* History Section */}
          {bonusHistory && bonusHistory.length > 0 ? (
            <View style={styles.historySection}>
              <Text style={styles.historyTitle}>История операций</Text>

              {bonusHistory.map((transaction, index) => (
                <View
                  key={transaction.id || index}
                  style={[
                    styles.transactionCard,
                    index === bonusHistory.length - 1 && { marginBottom: 32 },
                  ]}
                >
                  <View style={styles.transactionLeft}>
                    <View
                      style={[
                        styles.transactionIcon,
                        { backgroundColor: getTransactionColor(transaction.type) + '20' },
                      ]}
                    >
                      <Ionicons
                        name={getTransactionIcon(transaction.type)}
                        size={18}
                        color={getTransactionColor(transaction.type)}
                      />
                    </View>
                    <View style={styles.transactionInfo}>
                      <Text style={styles.transactionLabel}>
                        {transaction.description || getTransactionLabel(transaction.type)}
                      </Text>
                      <Text style={styles.transactionDate}>
                        {transaction.createdAt
                          ? format(new Date(transaction.createdAt), 'd MMM, HH:mm', {
                              locale: ru,
                            })
                          : '—'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.transactionRight}>
                    <Text
                      style={[
                        styles.transactionAmount,
                        { color: getTransactionColor(transaction.type) },
                      ]}
                    >
                      {transaction.type === 'spent' || transaction.type === 'redeemed'
                        ? '−'
                        : '+'}
                      {transaction.amount}
                    </Text>
                    <Text style={styles.transactionCurrency}>₽</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.emptyHistoryContainer}>
              <Ionicons name="document-text-outline" size={48} color={T.stoneFaint} />
              <Text style={styles.emptyHistoryText}>История операций пуста</Text>
              <Text style={styles.emptyHistorySub}>
                Бонусы будут начисляться за ваши покупки
              </Text>
            </View>
          )}
        </ScrollView>
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
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(212,175,55,0.15)',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: T.stone,
    letterSpacing: 0.5,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  balanceCardContainer: {
    marginTop: 24,
    marginBottom: 32,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: T.glass,
    borderWidth: 1,
    borderColor: T.glassBorder,
    shadowColor: T.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 4,
  },
  balanceCard: {
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  balanceTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  balanceIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: T.champGlow,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  balanceLabel: {
    fontSize: 13,
    color: T.stoneMid,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
  balanceDivider: {
    height: 1,
    backgroundColor: 'rgba(212,175,55,0.2)',
    marginVertical: 16,
  },
  balanceBottom: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 20,
  },
  balanceValue: {
    fontSize: 40,
    fontWeight: '700',
    color: T.champagne,
    letterSpacing: -1,
  },
  balanceCurrency: {
    fontSize: 18,
    fontWeight: '600',
    color: T.champagne,
    marginLeft: 8,
  },
  balanceMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 16,
  },
  metaItem: {
    flex: 1,
  },
  metaLabel: {
    fontSize: 11,
    color: T.stoneFaint,
    fontWeight: '500',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  metaValue: {
    fontSize: 14,
    color: T.stone,
    fontWeight: '600',
  },
  historySection: {
    marginBottom: 32,
  },
  historyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: T.stone,
    marginBottom: 16,
    letterSpacing: 0.4,
  },
  transactionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: T.glass,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.1)',
    shadowColor: T.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  transactionLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  transactionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  transactionInfo: {
    flex: 1,
  },
  transactionLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: T.stone,
    marginBottom: 4,
  },
  transactionDate: {
    fontSize: 11,
    color: T.stoneFaint,
  },
  transactionRight: {
    alignItems: 'flex-end',
    marginLeft: 12,
  },
  transactionAmount: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  transactionCurrency: {
    fontSize: 11,
    color: T.stoneMid,
    fontWeight: '500',
  },
  emptyHistoryContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
  },
  emptyHistoryText: {
    fontSize: 16,
    fontWeight: '600',
    color: T.stone,
    marginTop: 16,
  },
  emptyHistorySub: {
    fontSize: 13,
    color: T.stoneMuted,
    marginTop: 8,
    textAlign: 'center',
  },
});
