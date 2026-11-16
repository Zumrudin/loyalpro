// Авто-высота при встраивании через iframe (Wix Studio Custom Element / iframe-resizer).
    // Шлём фактическую высоту контента родительскому окну при любом изменении размера.
    // Если страница открыта напрямую (не в iframe) — ничего не делаем.
    (function () {
      if (window.parent === window) return;
      function sendHeight() {
        var h = Math.ceil(document.documentElement.scrollHeight);
        window.parent.postMessage({ type: 'cert-form-height', height: h }, '*');
      }
      window.addEventListener('load', sendHeight);
      window.addEventListener('resize', sendHeight);
      if (window.ResizeObserver) {
        new ResizeObserver(sendHeight).observe(document.body);
      } else {
        document.addEventListener('change', function () { setTimeout(sendHeight, 50); });
      }
      sendHeight();
    })();
