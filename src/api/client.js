import axios from 'axios';
import { Platform } from 'react-native';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://89.125.92.223:8001';
console.log('[API] Using base URL:', API_URL);

const apiClient = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 15000,
});

async function getToken() {
  try {
    if (Platform.OS === 'web') return localStorage.getItem('auth_token');
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync('auth_token');
  } catch (e) {
    if (Platform.OS !== 'web') return null;
    return localStorage.getItem('auth_token');
  }
}

async function deleteToken() {
  try {
    if (Platform.OS === 'web') { localStorage.removeItem('auth_token'); return; }
    const SecureStore = require('expo-secure-store');
    await SecureStore.deleteItemAsync('auth_token');
  } catch (e) {
    if (Platform.OS !== 'web') return;
    localStorage.removeItem('auth_token');
  }
}

// Inject token to requests
apiClient.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle errors
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    console.log('[API] Error details:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      url: error.config?.url,
      baseURL: error.config?.baseURL,
    });
    if (error.response?.status === 401) {
      await deleteToken();
    }
    return Promise.reject(error);
  }
);

export default apiClient;
