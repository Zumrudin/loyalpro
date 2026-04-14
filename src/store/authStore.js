import { create } from 'zustand';
import { Platform } from 'react-native';
import { authAPI } from '../api/auth';

const storage = {
  async setItem(key, value) {
    try {
      const SecureStore = require('expo-secure-store');
      await SecureStore.setItemAsync(key, value);
    } catch (e) {
      if (Platform.OS !== 'web') {
        console.warn('Token storage failed on native platform:', e);
        return; // Silent fail on native - no localStorage available
      }
      localStorage.setItem(key, value);
    }
  },
  async getItem(key) {
    try {
      const SecureStore = require('expo-secure-store');
      return await SecureStore.getItemAsync(key);
    } catch (e) {
      if (Platform.OS !== 'web') {
        console.warn('Token retrieval failed on native platform:', e);
        return null; // Return null on native platform
      }
      return localStorage.getItem(key);
    }
  },
  async deleteItem(key) {
    try {
      const SecureStore = require('expo-secure-store');
      await SecureStore.deleteItemAsync(key);
    } catch (e) {
      if (Platform.OS !== 'web') {
        console.warn('Token deletion failed on native platform:', e);
        return; // Silent fail on native - no localStorage available
      }
      localStorage.removeItem(key);
    }
  },
};

export const useAuthStore = create((set, get) => ({
  // State
  user: null,
  token: null,
  isLoading: false,
  error: null,
  telegramLink: null,

  // Actions
  setUser: (user) => set({ user }),
  setToken: (token) => set({ token }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  // Login with phone
  login: async (phone) => {
    set({ isLoading: true, error: null });
    try {
      const result = await authAPI.login(phone);
      set({ isLoading: false, telegramLink: result.telegramLink || null });
      return { success: true, message: result.message, telegramLink: result.telegramLink };
    } catch (error) {
      const message = error.response?.data?.error || error.message;
      set({ error: message, isLoading: false });
      return { success: false, message };
    }
  },

  // Verify OTP
  verifyOtp: async (phone, otp) => {
    set({ isLoading: true, error: null });
    try {
      const result = await authAPI.verifyOtp(phone, otp);
      const { token, user } = result;

      // Save token securely
      await storage.setItem('auth_token', token);

      set({
        token,
        user,
        isLoading: false,
        error: null,
      });

      return { success: true };
    } catch (error) {
      const message = error.response?.data?.error || error.message;
      set({ error: message, isLoading: false });
      return { success: false, message };
    }
  },

  // Restore session on app launch
  restoreToken: async () => {
    set({ isLoading: true });
    try {
      const token = await storage.getItem('auth_token');
      if (token) {
        // Use a short timeout for the startup validation request —
        // if the server is unreachable we fall back to the login screen
        // immediately instead of blocking the user for 15 seconds.
        const user = await Promise.race([
          authAPI.getCurrentUser(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Session restore timeout')), 5000)
          ),
        ]);
        set({ token, user, isLoading: false });
        return true;
      }
      set({ isLoading: false });
      return false;
    } catch (error) {
      console.error('Failed to restore token:', error);
      set({ isLoading: false });
      return false;
    }
  },

  // Logout
  logout: async () => {
    set({ isLoading: true });
    try {
      await authAPI.logout();
    } catch (e) {
      console.error('Logout error:', e);
    }
    await storage.deleteItem('auth_token');
    set({
      token: null,
      user: null,
      isLoading: false,
      error: null,
    });
  },
}));
