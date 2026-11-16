// Direct authenticated home-care preview; the opener binds fetched previews.
(function () {
  document.getElementById('hcPrintPreview')?.addEventListener('click', () => window.print());
  document.getElementById('hcClosePreview')?.addEventListener('click', () => window.close());
})();
