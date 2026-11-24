'use strict';
// Route authorization and response privacy are separate: opening the calendar
// must never implicitly grant writes, client search, dispatch or payment APIs.
const EDITORS = new Set(['owner', 'admin', 'admin_cashier']);
const READERS = new Set([...EDITORS, 'specialist']);
const VIEW_PATHS = new Set(['/day', '/day-summary', '/week', '/month']);
const canEdit = role => EDITORS.has(role);
const canViewPhones = role => EDITORS.has(role);
function capabilities(role) {
  return { canEdit: canEdit(role), canViewPhones: canViewPhones(role),
    canUseClientTools: EDITORS.has(role), canManageSchedule: ['owner','admin'].includes(role) };
}
function allowed(role, method, path) {
  if (!READERS.has(role)) return false;
  if (canEdit(role)) return true;
  if (method !== 'GET') return false;
  const p = String(path || '').split('?')[0].replace(/\/$/, '');
  return VIEW_PATHS.has(p) || /^\/records\/-?[1-9]\d*(?:\/history)?$/.test(p);
}
// Explicit phone fields never leave the server. Phone-like text can also be in
// comments, sync errors, labels or a fallback patient name: redact there too.
// Dates/times have structural keys and are kept intact; no phone fields allowed
// even under those objects. Do not mutate shared cached YClients/mirror DTOs.
const PHONE_KEY = /phone|telephone|(?:^|_)tel(?:$|_|Number)|mobile|^contactNumber$/i;
const PHONE_TEXT = /(?<!\d)\+?\d(?:[\s().-]*\d){9,14}(?!\d)/gu;
const DATE_KEY = /^(?:date|datetime|from|to|time|fetchedAt|updatedAt|createdAt|at|timestamp)$/;
function clean(value, key = '') {
  if (typeof value === 'string') {
    // Only a syntactically valid timestamp/date is exempted, not arbitrary text
    // put in an audit 'from' or 'to' field.
    if (DATE_KEY.test(key) && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return value;
    return value.replace(PHONE_TEXT, '[телефон скрыт]');
  }
  if (Array.isArray(value)) return value.map(v => clean(v));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !PHONE_KEY.test(k)).map(([k,v]) => [k,clean(v,k)]));
}
function present(data, role) {
  const result = canViewPhones(role) ? data : clean(data);
  if (!result || typeof result !== 'object' || Array.isArray(result) || result instanceof Date) return result;
  return { ...result, capabilities: capabilities(role) };
}
module.exports = { canEdit, canViewPhones, capabilities, allowed, present };
