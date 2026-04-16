import { create } from 'zustand';
import { clientDataAPI } from '../api/client-data';

export const useClientStore = create((set, get) => ({
  // Profile
  profile: null,
  profileLoading: false,

  // Bookings
  bookings: [],
  bookingsLoading: false,

  // Booking detail
  bookingDetail: null,
  bookingDetailLoading: false,

  // Bonuses
  bonuses: null,
  bonusHistory: [],
  bonusLoading: false,

  // Notifications
  notifications: [],
  notificationsLoading: false,

  // Recommendations
  recommendations: [],
  recommendationsLoading: false,

  // Errors
  error: null,

  // Actions
  fetchProfile: async () => {
    set({ profileLoading: true });
    try {
      const response = await clientDataAPI.getProfile();
      set({ profile: response.profile || response, error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ profileLoading: false });
    }
  },

  fetchBookings: async (type = 'all') => {
    set({ bookingsLoading: true });
    try {
      const response = await clientDataAPI.getBookings(type);
      set({ bookings: response.bookings || response || [], error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bookingsLoading: false });
    }
  },

  fetchBookingDetail: async (bookingId) => {
    set({ bookingDetailLoading: true, bookingDetail: null });
    try {
      const response = await clientDataAPI.getBooking(bookingId);
      set({ bookingDetail: response.booking || response, error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bookingDetailLoading: false });
    }
  },

  fetchBookingDetailGroup: async (ids) => {
    set({ bookingDetailLoading: true, bookingDetail: null });
    try {
      const results = await Promise.all(ids.map((id) => clientDataAPI.getBooking(id)));
      const bookings = results.map((r) => r.booking || r);
      const first = bookings[0];
      // Merge services from all records in the group
      const allServices = bookings.flatMap((b) => {
        if (!b.services) return [];
        if (Array.isArray(b.services)) return b.services;
        try { return JSON.parse(b.services); } catch { return []; }
      });
      const totalPrice   = bookings.reduce((sum, b) => sum + Number(b.price        || 0), 0);
      const totalBonus   = bookings.reduce((sum, b) => sum + Number(b.bonusAccrued || 0), 0);
      set({
        bookingDetail: { ...first, services: allServices, price: totalPrice, bonusAccrued: totalBonus },
        error: null,
      });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bookingDetailLoading: false });
    }
  },

  cancelBooking: async (bookingId, reason) => {
    set({ bookingsLoading: true });
    try {
      await clientDataAPI.cancelBooking(bookingId, reason);
      // Refresh bookings
      await get().fetchBookings();
      return { success: true };
    } catch (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    } finally {
      set({ bookingsLoading: false });
    }
  },

  rescheduleBooking: async (bookingId, newDateTime) => {
    set({ bookingsLoading: true });
    try {
      await clientDataAPI.rescheduleBooking(bookingId, newDateTime);
      // Refresh bookings
      await get().fetchBookings();
      return { success: true };
    } catch (error) {
      set({ error: error.message });
      return { success: false, message: error.message };
    } finally {
      set({ bookingsLoading: false });
    }
  },

  fetchBonuses: async () => {
    set({ bonusLoading: true });
    try {
      const bonusData = await clientDataAPI.getBonuses();
      const historyData = await clientDataAPI.getBonusHistory();
      set({
        bonuses: {
          balance:      bonusData.balance      || 0,
          level:        bonusData.level        || 'Новичок',
          totalSpent:   bonusData.totalSpent   || 0,
          levels:       bonusData.levels       || [],
          currentLevel: bonusData.currentLevel || null,
          nextLevel:    bonusData.nextLevel     || null,
          amountToNext: bonusData.amountToNext || 0,
        },
        bonusHistory: historyData.transactions || historyData || [],
        error: null,
      });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ bonusLoading: false });
    }
  },

  fetchNotifications: async (limit = 20, offset = 0) => {
    set({ notificationsLoading: true });
    try {
      const response = await clientDataAPI.getNotifications(limit, offset);
      set({
        notifications: response.notifications || [],
        error: null,
      });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ notificationsLoading: false });
    }
  },

  markNotificationRead: async (notificationId) => {
    try {
      await clientDataAPI.markNotificationRead(notificationId);
      // Update local state
      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === notificationId ? { ...n, read: true } : n
        ),
      }));
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  },

  fetchRecommendations: async () => {
    set({ recommendationsLoading: true });
    try {
      const response = await clientDataAPI.getRecommendations();
      set({
        recommendations: response.recommendations || [],
        error: null,
      });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ recommendationsLoading: false });
    }
  },

  registerFcmToken: async (fcmToken) => {
    try {
      await clientDataAPI.registerFcmToken(fcmToken);
    } catch (error) {
      console.error('Failed to register FCM token:', error);
    }
  },

  clearError: () => set({ error: null }),
}));
