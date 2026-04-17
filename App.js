import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View, StyleSheet, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAuthStore } from './src/store/authStore';

// Screens
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import BookingsScreen from './src/screens/BookingsScreen';
import BonusesScreen from './src/screens/BonusesScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import BookingDetailScreen from './src/screens/BookingDetailScreen';
import PrescriptionsScreen from './src/screens/PrescriptionsScreen';
import PrescriptionDetailScreen from './src/screens/PrescriptionDetailScreen';

const RootStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

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
        component={HomeScreen}
        options={{
          tabBarLabel: 'Главная',
          tabBarIcon: ({ color }) => (
            <Ionicons name="home-outline" size={22} color={color} strokeWidth={1.5} />
          ),
        }}
      />
      <Tab.Screen
        name="Bookings"
        component={BookingsScreen}
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
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarLabel: 'Уведомления',
          tabBarIcon: ({ color }) => (
            <Ionicons name="notifications-outline" size={22} color={color} />
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
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="Tabs" component={TabNavigator} />
      <RootStack.Screen
        name="BookingDetail"
        component={BookingDetailScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <RootStack.Screen
        name="Prescriptions"
        component={PrescriptionsScreen}
        options={{ headerShown: false }}
      />
      <RootStack.Screen
        name="PrescriptionDetail"
        component={PrescriptionDetailScreen}
        options={{ headerShown: false }}
      />
    </RootStack.Navigator>
  );
}

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const token = useAuthStore((state) => state.token);
  const restoreToken = useAuthStore((state) => state.restoreToken);

  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        // Restore token from secure storage
        await restoreToken();
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
        <NavigationContainer>
          {token ? <MainNavigator /> : <AuthNavigator />}
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
