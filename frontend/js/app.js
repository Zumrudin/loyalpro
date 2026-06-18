// ── APP ENTRY POINT ────────────────────────────────────────────
// Порядок загрузки важен: core/* должны быть подключены до app.js
// core/utils.js  → esc, notify, showLbar, animateCount, animateCards
// core/api.js    → api(), TOKEN
// core/auth.js   → ME, doLogin, doRegister, doLogout, doChangePw
// core/nav.js    → nav, applyRoleNav, navStg, launchApp, showLogin
// core/theme.js  → initDarkMode, toggleDarkMode

// Запуск приложения при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
  initFavicon();
  if (TOKEN) {
    try { await launchApp(); } catch { showLogin(); }
  }
});
