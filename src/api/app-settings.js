import apiClient from './client';

export const appSettingsAPI = {
  getAppSettings: async () => {
    const res = await apiClient.get('/app-settings');
    return res.data;
  },
};
