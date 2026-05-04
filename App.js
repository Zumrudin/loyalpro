import React, { useEffect, useState, useRef } from 'react';
import { ActivityIndicator, View, StyleSheet, StatusBar, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAuthStore } from './src/store/authStore';
import { useClientStore } from './src/store/clientStore';
import { useAppSettingsStore } from './src/store/appSettingsStore';

// Screens
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import BookingsScreen from './src/screens/BookingsScreen';
import BonusesScreen from './src/screens/BonusesScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import ContactsScreen from './src/screens/ContactsScreen';
import BookingDetailScreen from './src/screens/BookingDetailScreen';
import PrescriptionsScreen from './src/screens/PrescriptionsScreen';
import PrescriptionDetailScreen from './src/screens/PrescriptionDetailScreen';
import PriceListScreen from './src/screens/PriceListScreen';
import PriceListDetailScreen from './src/screens/PriceListDetailScreen';
import RouteToClinicScreen from './src/screens/RouteToClinicScreen';
import SpecialistsScreen from './src/screens/SpecialistsScreen';
import SpecialistDetailScreen from './src/screens/SpecialistDetailScreen';
import PortfolioCategoryScreen from './src/screens/PortfolioCategoryScreen';

const HomeStackNav = createNativeStackNavigator();
const BookingsStackNav = createNativeStackNavigator();
const ContactsStackNav = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// Per-tab stacks — keep bottom tab bar visible on nested screens
function HomeStack() {
  return (
    <HomeStackNav.Navigator
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <HomeStackNav.Screen name="HomeRoot" component={HomeScreen} />
      <HomeStackNav.Screen name="PriceList" component={PriceListScreen} />
      <HomeStackNav.Screen name="PriceListDetail" component={PriceListDetailScreen} />
      <HomeStackNav.Screen name="Prescriptions" component={PrescriptionsScreen} />
      <HomeStackNav.Screen name="PrescriptionDetail" component={PrescriptionDetailScreen} />
      <HomeStackNav.Screen name="BookingDetail" component={BookingDetailScreen} />
      <HomeStackNav.Screen name="Notifications" component={NotificationsScreen} />
      <HomeStackNav.Screen name="Specialists" component={SpecialistsScreen} />
      <HomeStackNav.Screen name="SpecialistDetail" component={SpecialistDetailScreen} />
      <HomeStackNav.Screen name="PortfolioCategory" component={PortfolioCategoryScreen} />
    </HomeStackNav.Navigator>
  );
}

function BookingsStack() {
  return (
    <BookingsStackNav.Navigator
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <BookingsStackNav.Screen name="BookingsRoot" component={BookingsScreen} />
      <BookingsStackNav.Screen name="BookingDetail" component={BookingDetailScreen} />
      <BookingsStackNav.Screen name="PrescriptionDetail" component={PrescriptionDetailScreen} />
    </BookingsStackNav.Navigator>
  );
}

function ContactsStack() {
  return (
    <ContactsStackNav.Navigator
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <ContactsStackNav.Screen name="ContactsRoot" component={ContactsScreen} />
      <ContactsStackNav.Screen name="RouteToClinic" component={RouteToClinicScreen} />
    </ContactsStackNav.Navigator>
  );
}

// Tab Navigator
function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#D4AF37',
        tabBarInactiveTintColor: 'rgba(74,69,64,0.40)',
        tabBarStyle: {
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          height: 72,
          paddingBottom: 12,
          paddingTop: 8,
          position: 'absolute',
          elevation: 0,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
          letterSpacing: 0.4,
        },
        tabBarBackground: () => (
          <View style={{ flex: 1, overflow: 'hidden' }}>
            <BlurView intensity={70} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={['rgba(245,243,240,0.92)', 'rgba(237,233,227,0.88)']}
              style={StyleSheet.absoluteFill}
            />
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(212,175,55,0.25)' }} />
          </View>
        ),
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeStack}
        options={{
          tabBarLabel: 'Главная',
          tabBarIcon: ({ color }) => (
            <Ionicons name="home-outline" size={22} color={color} strokeWidth={1.5} />
          ),
        }}
      />
      <Tab.Screen
        name="Bookings"
        component={BookingsStack}
        options={{
          tabBarLabel: 'Записи',
          tabBarIcon: ({ color }) => (
            <Ionicons name="calendar-outline" size={22} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Bonuses"
        component={BonusesScreen}
        options={{
          tabBarLabel: 'Бонусы',
          tabBarIcon: ({ color }) => (
            <Ionicons name="diamond-outline" size={22} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Contacts"
        component={ContactsStack}
        options={{
          tabBarLabel: 'Контакты',
          tabBarIcon: ({ color }) => (
            <Ionicons name="call-outline" size={22} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarLabel: 'Профиль',
          tabBarIcon: ({ color }) => (
            <Ionicons name="person-outline" size={22} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// Auth Stack Navigator
function AuthNavigator() {
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >
      <AuthStack.Screen name="Login" component={LoginScreen} />
    </AuthStack.Navigator>
  );
}

function MainNavigator() {
  return <TabNavigator />;
}

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const token = useAuthStore((state) => state.token);
  const restoreToken = useAuthStore((state) => state.restoreToken);
  const fetchAppSettings = useAppSettingsStore((state) => state.fetchAppSettings);
  const navigationRef = useRef(null);

  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        await restoreToken();
        await fetchAppSettings();
      } catch (e) {
        console.error('Error restoring token:', e);
      } finally {
        setIsLoading(false);
      }
    };
    bootstrapAsync();
  }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F5F3F0' }}>
        <StatusBar barStyle="dark-content" backgroundColor="#F5F3F0" />
        <ActivityIndicator size="large" color="#D4AF37" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          {token ? <MainNavigator /> : <AuthNavigator />}
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
