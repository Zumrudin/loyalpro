'use strict';
// Pure: lays queued/failed journal outbox packages over mirrored YClients
// records, so an unsaved change is visible in the journal immediately.
const RECENT_DONE_MS = 5 * 60000;

function syncOf(row) {
  return {
    outboxId: Number(row.id), status: row.status,
    errorText: row.error_text || null, errorCode: row.error_code || null,
    failedStep: row.failed_step ?? null,
    // Manual dispatch: a queued package that was not released waits for the
    // journal's «Отправить в YClients»; released = on its way.
    released: row.released_at != null,
  };
}

const ms = v => Date.parse(v instanceof Date ? v.toISOString() : String(v || '').replace(' ', 'T'));
function visible(row, present, now) {
  if (['queued', 'running', 'failed'].includes(row.status)) return true;
  if (row.status !== 'done') return false;
  const at = ms(row.updated_at);
  if (!Number.isFinite(at) || now - at >= RECENT_DONE_MS) return false;
  if (!(row.yclients_record_id != null && present.has(String(row.yclients_record_id)))) return true;
  // The record is mirrored, but the mirror learns about OUR write only from the
  // YClients webhook, 2–5 s after the package is done. Until the mirrored
  // last_change_date passes the package creation, the card would show the OLD
  // status/time and «jump back» (10.11.2026, record 2134064400).
  const lcd = ms(present.get(String(row.yclients_record_id))?.last_change_date);
  const created = ms(row.created_at);
  return row.overlay?.kind === 'patch' && Object.keys(row.overlay.patch || {}).length > 0 && Number.isFinite(lcd) && Number.isFinite(created) && lcd < created;
}

function synthetic(row, o, sync) {
  return {
    id: row.yclients_record_id ? Number(row.yclients_record_id) : -Number(row.id),
    datetime: `${o.date}T${o.time}:00+03:00`,
    seance_length: Number(o.duration) * 60,
    staff_id: o.staffId,
    services: Array.isArray(o.services) ? o.services.map(s => {
      // Older create packages kept the quantity only in `lines`.
      const line = Array.isArray(o.lines) ? o.lines.find(l => Number(l.serviceId) === Number(s.id)) : null;
      return { amount: Number(line?.quantity) || 1, ...s };
    }) : [],
    client: o.client ? { ...o.client } : {},
    comment: o.comment || '',
    attendance: o.attendance ?? 0,
    deleted: false,
    _sync: sync,
  };
}

function applyOverlay(records, rows, now = Date.now()) {
  const out = (records || []).map(r => ({ ...r }));
  const index = new Map(out.map((r, i) => [String(r.id), i]));
  const present = new Map(out.map(r => [String(r.id), r]));
  const ordered = [...(rows || [])].sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of ordered) {
    if (!visible(row, present, now)) continue;
    const o = row.overlay || {};
    const sync = syncOf(row);
    // A change of a new record not yet in YClients targets its create (-id).
    const key = row.yclients_record_id != null ? String(row.yclients_record_id)
      : row.create_outbox_id != null ? String(-Number(row.create_outbox_id)) : null;
    const at = key != null ? index.get(key) : undefined;
    if (o.kind === 'create') {
      if (at !== undefined) { out[at] = { ...out[at], _sync: sync }; continue; }
      const rec = synthetic(row, o, sync);
      index.set(String(rec.id), out.length);
      out.push(rec);
    } else if (o.kind === 'patch') {
      if (at === undefined) continue;
      const p = o.patch || {}, next = { ...out[at] };
      for (const f of ['datetime', 'staff_id', 'seance_length', 'attendance', 'services']) if (p[f] !== undefined) next[f] = p[f];
      if (p.cancel === true) next.attendance = -1;
      next._sync = sync;
      out[at] = next;
    }
  }
  return out;
}

module.exports = { applyOverlay, RECENT_DONE_MS };
