// Build a client full name in Russian ФИО order: «Фамилия Имя Отчество».
// Source object is a YClients client payload (from /client/{cid}/{id} or any
// webhook that embeds the same shape). YClients itself returns a `display_name`
// in "Имя Отчество Фамилия" order, which is NOT correct ФИО — do not use it
// when separate fields are available.
function buildClientFio(yc, fallback) {
  if (!yc || typeof yc !== 'object') return fallback || 'Клиент';
  const surname    = (yc.surname    || '').trim();
  const name       = (yc.name       || '').trim();
  const patronymic = (yc.patronymic || '').trim();
  const parts = [surname, name, patronymic].filter(Boolean);
  if (parts.length) return parts.join(' ');
  const display = (yc.display_name || '').trim();
  if (display) return display;
  return (yc.phone || fallback || 'Клиент');
}

// True if `currentName` looks like the legacy broken concat
// "Имя Фамилия Отчество". Used by the backfill script as a safety guard so
// we never overwrite a name that an admin manually edited in the UI.
function isLegacyBrokenOrder(yc, currentName) {
  if (!yc || !currentName) return false;
  const name       = (yc.name       || '').trim();
  const surname    = (yc.surname    || '').trim();
  const patronymic = (yc.patronymic || '').trim();
  if (!surname) return false;
  const broken = [name, surname, patronymic].filter(Boolean).join(' ');
  return broken === currentName.trim();
}

module.exports = { buildClientFio, isLegacyBrokenOrder };
