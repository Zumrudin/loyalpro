import apiClient from './client';

export const clientDataAPI = {
  // Get client profile
  getProfile: async () => {
    const res = await apiClient.get('/mobile/client/profile');
    return res.data;
  },

  // Get client bookings
  getBookings: async (type = 'all') => {
    // type: 'upcoming' | 'past' | 'all'
    const res = await apiClient.get('/mobile/client/bookings', {
      params: { type },
    });
    return res.data;
  },

  // Get single booking details
  getBooking: async (bookingId) => {
    const res = await apiClient.get(`/mobile/client/bookings/${bookingId}`);
    return res.data;
  },

  // Cancel booking
  cancelBooking: async (bookingId, reason = '') => {
    const res = await apiClient.post(`/mobile/client/bookings/${bookingId}/cancel`, {
      reason,
    });
    return res.data;
  },

  // Reschedule booking
  rescheduleBooking: async (bookingId, newDateTime) => {
    const res = await apiClient.post(
      `/mobile/client/bookings/${bookingId}/reschedule`,
      { newDateTime }
    );
    return res.data;
  },

  // Get bonuses and balance
  getBonuses: async () => {
    const res = await apiClient.get('/mobile/client/bonuses');
    return res.data;
  },

  // Get bonus history
  getBonusHistory: async () => {
    const res = await apiClient.get('/mobile/client/bonus-history');
    return res.data;
  },

  // Get notifications
  getNotifications: async (limit = 20, offset = 0) => {
    const res = await apiClient.get('/mobile/client/notifications', {
      params: { limit, offset },
    });
    return res.data;
  },

  // Mark notification as read
  markNotificationRead: async (notificationId) => {
    const res = await apiClient.post(
      `/mobile/client/notifications/${notificationId}/read`
    );
    return res.data;
  },

  // Get recommended services/specialists
  getRecommendations: async () => {
    const res = await apiClient.get('/mobile/client/recommendations');
    return res.data;
  },

  // Register FCM token for push notifications
  registerFcmToken: async (fcmToken) => {
    const res = await apiClient.post('/mobile/client/fcm-token', { fcmToken });
    return res.data;
  },

  // Get prescriptions list
  getPrescriptions: async () => {
    const res = await apiClient.get('/mobile/client/prescriptions');
    return res.data;
  },

  // Get single prescription detail
  getPrescriptionDetail: async (id) => {
    const res = await apiClient.get(`/mobile/client/prescriptions/${id}`);
    return res.data;
  },

  // Get price list
  getPriceList: async () => {
    const res = await apiClient.get('/mobile/client/price-list');
    return res.data;
  },

  // Get specialists (staff with show_in_app enabled)
  getSpecialists: async () => {
    const res = await apiClient.get('/mobile/client/specialists');
    return res.data;
  },

  // Get portfolio categories (Before/After)
  getPortfolioCategories: async () => {
    const res = await apiClient.get('/mobile/client/portfolio/categories');
    return res.data;
  },

  // Get portfolio items in one category
  getPortfolioCategory: async (id) => {
    const res = await apiClient.get(`/mobile/client/portfolio/categories/${id}`);
    return res.data;
  },
};
