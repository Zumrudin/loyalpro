import apiClient from './client';

export const authAPI = {
  // Login by phone number
  login: async (phone) => {
    const res = await apiClient.post('/mobile/auth/login', { phone });
    return res.data;
  },

  // Verify OTP
  verifyOtp: async (phone, otp) => {
    const res = await apiClient.post('/mobile/auth/verify-otp', { phone, otp });
    return res.data;
  },

  // Get current user
  getCurrentUser: async () => {
    const res = await apiClient.get('/mobile/auth/me');
    return res.data;
  },

  // Logout
  logout: async () => {
    const res = await apiClient.post('/mobile/auth/logout');
    return res.data;
  },
};
