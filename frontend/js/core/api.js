// ── API ────────────────────────────────────────────────────────

const API = '';
let TOKEN = localStorage.getItem('lp_tk');

async function api(method, path, body) {
  showLbar(true);
  try {
    const o = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) o.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) o.body = JSON.stringify(body);
    const r = await fetch(API + path, o);

    // Проверяем статус перед парсингом JSON
    if (!r.ok) {
      try {
        const j = await r.json();
        throw new Error(j.error || 'HTTP ' + r.status);
      } catch (e) {
        // Если сервер вернул HTML вместо JSON (ошибка 404, 502 и т.д.)
        if (e instanceof SyntaxError) {
          throw new Error('Ошибка сервера (HTTP ' + r.status + ')');
        }
        throw e;
      }
    }

    // 204 No Content и пустые тела (DELETE-эндпоинты) — JSON.parse тут упадёт.
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } finally { showLbar(false); }
}
