import React, { useEffect } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../store/authStore';
import { useClientStore } from '../store/clientStore';

export default function ProfileScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const profile = useClientStore((state) => state.profile);
  const fetchProfile = useClientStore((state) => state.fetchProfile);

  useEffect(() => {
    fetchProfile();
  }, []);

  const handleLogout = () => {
    Alert.alert(
      'Выход из аккаунта',
      'Вы уверены, что хотите выйти?',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Выйти',
          style: 'destructive',
          onPress: async () => {
            await logout();
            navigation.reset({
              index: 0,
              routes: [{ name: 'Login' }],
            });
          },
        },
      ]
    );
  };

  const handleCall = (phone) => {
    Linking.openURL(`tel:${phone}`);
  };

  const handleEmail = (email) => {
    Linking.openURL(`mailto:${email}`);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Profile Section */}
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user?.name?.charAt(0) || '?'}
            </Text>
          </View>
          <Text style={styles.userName}>{user?.name || 'Клиент'}</Text>
          <Text style={styles.userPhone}>{user?.phone || '—'}</Text>
        </View>

        {/* Personal Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Личная информация</Text>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Email</Text>
            <Text style={styles.infoValue}>{profile?.email || 'Не указан'}</Text>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Дата рождения</Text>
            <Text style={styles.infoValue}>
              {profile?.birthDate ? new Date(profile.birthDate).toLocaleDateString('ru-RU') : 'Не указана'}
            </Text>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Пол</Text>
            <Text style={styles.infoValue}>
              {profile?.gender === 'M' ? 'Мужской' : profile?.gender === 'F' ? 'Женский' : 'Не указан'}
            </Text>
          </View>

          <TouchableOpacity style={styles.editButton}>
            <Text style={styles.editButtonText}>Редактировать профиль</Text>
          </TouchableOpacity>
        </View>

        {/* Loyalty Program */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Программа лояльности</Text>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Статус</Text>
            <Text style={styles.infoValue}>{profile?.loyaltyLevel || 'Новичок'}</Text>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Дата регистрации</Text>
            <Text style={styles.infoValue}>
              {profile?.registeredAt ? new Date(profile.registeredAt).toLocaleDateString('ru-RU') : '—'}
            </Text>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Количество посещений</Text>
            <Text style={styles.infoValue}>{profile?.visitsCount || 0}</Text>
          </View>
        </View>

        {/* Clinic Contact */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Контакты клиники</Text>

          {profile?.clinicPhone && (
            <TouchableOpacity
              style={styles.contactCard}
              onPress={() => handleCall(profile.clinicPhone)}
            >
              <Text style={styles.contactIcon}>☎️</Text>
              <View style={styles.contactInfo}>
                <Text style={styles.contactLabel}>Телефон</Text>
                <Text style={styles.contactValue}>{profile.clinicPhone}</Text>
              </View>
              <Text style={styles.contactArrow}>›</Text>
            </TouchableOpacity>
          )}

          {profile?.clinicEmail && (
            <TouchableOpacity
              style={styles.contactCard}
              onPress={() => handleEmail(profile.clinicEmail)}
            >
              <Text style={styles.contactIcon}>✉️</Text>
              <View style={styles.contactInfo}>
                <Text style={styles.contactLabel}>Email</Text>
                <Text style={styles.contactValue}>{profile.clinicEmail}</Text>
              </View>
              <Text style={styles.contactArrow}>›</Text>
            </TouchableOpacity>
          )}

          {profile?.clinicAddress && (
            <View style={styles.contactCard}>
              <Text style={styles.contactIcon}>📍</Text>
              <View style={styles.contactInfo}>
                <Text style={styles.contactLabel}>Адрес</Text>
                <Text style={styles.contactValue}>{profile.clinicAddress}</Text>
              </View>
            </View>
          )}

          {profile?.clinicHours && (
            <View style={styles.contactCard}>
              <Text style={styles.contactIcon}>⏰</Text>
              <View style={styles.contactInfo}>
                <Text style={styles.contactLabel}>Часы работы</Text>
                <Text style={styles.contactValue}>{profile.clinicHours}</Text>
              </View>
            </View>
          )}
        </View>

        {/* Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Настройки</Text>

          <TouchableOpacity style={styles.settingCard}>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel}>🔔 Уведомления</Text>
              <Text style={styles.settingDesc}>Управление уведомлениями</Text>
            </View>
            <Text style={styles.settingArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.settingCard}>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel}>🔒 Приватность</Text>
              <Text style={styles.settingDesc}>Управление данными</Text>
            </View>
            <Text style={styles.settingArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.settingCard}>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel}>ℹ️ О приложении</Text>
              <Text style={styles.settingDesc}>Версия 1.0.0</Text>
            </View>
            <Text style={styles.settingArrow}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Logout Button */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
        >
          <Text style={styles.logoutButtonText}>Выйти из аккаунта</Text>
        </TouchableOpacity>

        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    flex: 1,
  },
  profileSection: {
    alignItems: 'center',
    paddingVertical: 30,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
  },
  userName: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#000',
    marginBottom: 4,
  },
  userPhone: {
    fontSize: 14,
    color: '#666',
  },
  section: {
    marginTop: 15,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#666',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoCard: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  infoLabel: {
    fontSize: 12,
    color: '#999',
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 16,
    color: '#000',
    fontWeight: '500',
  },
  editButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  editButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  contactCard: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  contactIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  contactInfo: {
    flex: 1,
  },
  contactLabel: {
    fontSize: 12,
    color: '#999',
    marginBottom: 2,
  },
  contactValue: {
    fontSize: 14,
    color: '#000',
    fontWeight: '500',
  },
  contactArrow: {
    fontSize: 18,
    color: '#ccc',
  },
  settingCard: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 14,
    color: '#000',
    fontWeight: '600',
    marginBottom: 2,
  },
  settingDesc: {
    fontSize: 12,
    color: '#999',
  },
  settingArrow: {
    fontSize: 18,
    color: '#ccc',
  },
  logoutButton: {
    marginHorizontal: 20,
    marginVertical: 20,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ff3b30',
    alignItems: 'center',
  },
  logoutButtonText: {
    color: '#ff3b30',
    fontSize: 14,
    fontWeight: '600',
  },
});
