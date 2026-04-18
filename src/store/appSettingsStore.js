import { create } from 'zustand';
import { Platform } from 'react-native';
import { appSettingsAPI } from '../api/app-settings';

const CACHE_KEY = 'app_settings_cache';

const storage = {
  async setItem(key, value) {
    try {
      const SecureStore = require('expo-secure-store');
      await SecureStore.setItemAsync(key, value);
    } catch {
      if (Platform.OS === 'web') localStorage.setItem(key, value);
    }
  },
  async getItem(key) {
    try {
      const SecureStore = require('expo-secure-store');
      return await SecureStore.getItemAsync(key);
    } catch {
      if (Platform.OS === 'web') return localStorage.getItem(key);
      return null;
    }
  },
};

export const useAppSettingsStore = create((set) => ({
  clinicName: '',
  logoUrl:    null,
  phone:      null,
  whatsapp:   null,
  telegram:   null,
  instagram:  null,
  mapsUrl:    null,
  email:      null,
  loaded:     false,

  fetchAppSettings: async () => {
    try {
      const data = await appSettingsAPI.getAppSettings();
      const settings = {
        clinicName: data.clinicName || '',
        logoUrl:    data.logoUrl    || null,
        phone:      data.phone      || null,
        whatsapp:   data.whatsapp   || null,
        telegram:   data.telegram   || null,
        instagram:  data.instagram  || null,
        mapsUrl:    data.mapsUrl    || null,
        email:      data.email      || null,
      };
      set({ ...settings, loaded: true });
      await storage.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch {
      // Offline fallback: load last cached settings
      try {
        const cached = await storage.getItem(CACHE_KEY);
        if (cached) set({ ...JSON.parse(cached), loaded: true });
        else set({ loaded: true });
      } catch {
        set({ loaded: true });
      }
    }
  },
}));
