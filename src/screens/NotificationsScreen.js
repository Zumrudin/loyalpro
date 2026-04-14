import React, { useEffect } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClientStore } from '../store/clientStore';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

export default function NotificationsScreen({ navigation }) {
  const insets = useSafeAreaInsets();

  const notifications = useClientStore((state) => state.notifications);
  const notificationsLoading = useClientStore((state) => state.notificationsLoading);
  const fetchNotifications = useClientStore((state) => state.fetchNotifications);
  const markNotificationRead = useClientStore(
    (state) => state.markNotificationRead
  );

  useEffect(() => {
    loadNotifications();
  }, []);

  const loadNotifications = async () => {
    await fetchNotifications();
  };

  const handleNotificationPress = async (notification) => {
    if (!notification.read) {
      await markNotificationRead(notification.id);
    }
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'booking':
        return '📅';
      case 'reminder':
        return '🔔';
      case 'promo':
        return '🎁';
      case 'bonus':
        return '💰';
      case 'offer':
        return '✨';
      default:
        return '📬';
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backButton}>← Назад</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Уведомления</Text>
      </View>

      {/* Content */}
      {notificationsLoading && notifications.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : notifications.length === 0 ? (
        <ScrollView
          style={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={notificationsLoading}
              onRefresh={loadNotifications}
            />
          }
        >
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>У вас нет уведомлений</Text>
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          style={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={notificationsLoading}
              onRefresh={loadNotifications}
            />
          }
        >
          {notifications.map((notification) => (
            <TouchableOpacity
              key={notification.id}
              style={[
                styles.notificationCard,
                !notification.read && styles.notificationUnread,
              ]}
              onPress={() => handleNotificationPress(notification)}
            >
              <View style={styles.notificationIcon}>
                <Text style={styles.iconText}>
                  {getNotificationIcon(notification.type)}
                </Text>
              </View>

              <View style={styles.notificationContent}>
                <Text style={styles.notificationTitle} numberOfLines={2}>
                  {notification.title}
                </Text>
                <Text
                  style={styles.notificationBody}
                  numberOfLines={2}
                >
                  {notification.message}
                </Text>
                <Text style={styles.notificationTime}>
                  {format(new Date(notification.createdAt), 'd MMM в HH:mm', {
                    locale: ru,
                  })}
                </Text>
              </View>

              {!notification.read && <View style={styles.unreadBadge} />}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
    marginRight: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#000',
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 15,
  },
  emptyText: {
    fontSize: 16,
    color: '#999',
  },
  notificationCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  notificationUnread: {
    backgroundColor: '#f0f7ff',
    borderColor: '#007AFF',
    borderWidth: 1.5,
  },
  notificationIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  iconText: {
    fontSize: 24,
  },
  notificationContent: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#000',
    marginBottom: 4,
  },
  notificationBody: {
    fontSize: 13,
    color: '#555',
    marginBottom: 6,
    lineHeight: 18,
  },
  notificationTime: {
    fontSize: 12,
    color: '#999',
  },
  unreadBadge: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#007AFF',
    marginLeft: 8,
    alignSelf: 'center',
  },
});
