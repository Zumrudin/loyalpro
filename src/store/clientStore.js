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

  // Prescriptions
  prescriptions: [],
  prescriptionsLoading: false,
  prescriptionDetail: null,
  prescriptionDetailLoading: false,

  // Daily Care Checklist
  todayChecklist: null,           // { date, sections: { morning, evening, additional }, summary }
  todayChecklistLoading: false,

  adherenceData: null,            // { prescription, days[] }
  adherenceLoading: false,

  // Specialists
  specialists: [],
  specialistsLoading: false,

  // Portfolio (Before/After)
  portfolioCategories: [],            // [{id, title, coverPhotoUrl, itemsCount}]
  portfolioCategoriesLoading: false,
  portfolioItemsByCategory: {},       // { [categoryId]: items[] }
  portfolioItemsLoading: {},          // { [categoryId]: bool }

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

  fetchPrescriptions: async () => {
    set({ prescriptionsLoading: true });
    try {
      const response = await clientDataAPI.getPrescriptions();
      set({ prescriptions: response.prescriptions || [], error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ prescriptionsLoading: false });
    }
  },

  fetchPrescriptionDetail: async (id) => {
    set({ prescriptionDetailLoading: true, prescriptionDetail: null });
    try {
      const response = await clientDataAPI.getPrescriptionDetail(id);
      set({ prescriptionDetail: response.prescription || null, error: null });
    } catch (error) {
      set({ error: error.message });
    } finally {
      set({ prescriptionDetailLoading: false });
    }
  },

  fetchSpecialists: async () => {
    set({ specialistsLoading: true });
    try {
      const response = await clientDataAPI.getSpecialists();
      console.log('[API] specialists →', (response.specialists || []).length);
      set({ specialists: response.specialists || response || [], error: null });
    } catch (error) {
      console.error('[API] specialists error:', error.message);
      set({ error: error.message });
    } finally {
      set({ specialistsLoading: false });
    }
  },

  fetchPortfolioCategories: async () => {
    set({ portfolioCategoriesLoading: true });
    try {
      const response = await clientDataAPI.getPortfolioCategories();
      set({
        portfolioCategories: response.categories || [],
        error: null,
      });
    } catch (error) {
      console.log('[API] portfolio categories failed:', error.message);
      set({ error: error.message });
    } finally {
      set({ portfolioCategoriesLoading: false });
    }
  },

  fetchPortfolioCategory: async (id) => {
    set((s) => ({
      portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: true },
    }));
    try {
      const response = await clientDataAPI.getPortfolioCategory(id);
      set((s) => ({
        portfolioItemsByCategory: {
          ...s.portfolioItemsByCategory,
          [id]: response.items || [],
        },
        error: null,
      }));
    } catch (error) {
      console.log('[API] portfolio category failed:', error.message);
      set({ error: error.message });
    } finally {
      set((s) => ({
        portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: false },
      }));
    }
  },

  fetchTodayChecklist: async () => {
    set({ todayChecklistLoading: true });
    try {
      const response = await clientDataAPI.getTodayChecklist();
      set({
        todayChecklist: {
          date: response.date,
          sections: response.sections || { morning: [], evening: [], additional: [] },
          summary: response.summary || { total: 0, completed: 0 },
        },
        error: null,
      });
    } catch (error) {
      console.log('[API] fetchTodayChecklist error:', error?.message);
      set({ error: error?.message || 'Не удалось загрузить чек-лист' });
    } finally {
      set({ todayChecklistLoading: false });
    }
  },

  toggleItemCompletion: async (itemId, currentlyCompleted) => {
    // 1. Optimistic flip в локальном state
    const prev = get().todayChecklist;
    if (!prev) return;

    const flipItem = (item) =>
      item.id === itemId ? { ...item, completed: !currentlyCompleted } : item;

    const nextSections = {
      morning:    prev.sections.morning.map(flipItem),
      evening:    prev.sections.evening.map(flipItem),
      additional: prev.sections.additional.map(flipItem),
    };
    const delta = currentlyCompleted ? -1 : +1;
    const nextSummary = {
      total:     prev.summary.total,
      completed: prev.summary.completed + delta,
    };
    set({ todayChecklist: { ...prev, sections: nextSections, summary: nextSummary } });

    // 2. Сетевой вызов
    try {
      if (currentlyCompleted) {
        await clientDataAPI.unmarkItemCompleted(itemId);
      } else {
        await clientDataAPI.markItemCompleted(itemId);
      }
    } catch (error) {
      // 3. Откат при ошибке
      console.log('[API] toggleItemCompletion error:', error?.message);
      set({
        todayChecklist: prev,
        error: error?.response?.data?.error || error?.message || 'Не удалось сохранить отметку',
      });
      throw error;
    }
  },

  fetchAdherence: async (prescriptionId) => {
    set({ adherenceLoading: true, adherenceData: null });
    try {
      const response = await clientDataAPI.getPrescriptionAdherence(prescriptionId);
      set({
        adherenceData: {
          prescription: response.prescription,
          days: response.days || [],
        },
        error: null,
      });
    } catch (error) {
      console.log('[API] fetchAdherence error:', error?.message);
      set({ error: error?.message || 'Не удалось загрузить данные выполнения' });
    } finally {
      set({ adherenceLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
