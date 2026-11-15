'use strict';

// История складского документа. Журнал содержит только технические поля;
// известные даты старых документов добавляются из фактических колонок и
// помечаются known=true — прошлые изменения по ним не реконструируются.
const { db } = require('../../db');
const { fail } = require('./model');

const CAP = 200;
const DOCUMENT_SQL = `SELECT id, origin, kind, status, created_by, created_at, posted_at, cancelled_at
  FROM stock_documents WHERE salon_id = $1 AND id = $2`;
const EVENTS_SQL = `SELECT id, occurred_at, action, actor_user_id, source, changes,
    MIN(occurred_at) OVER () AS history_since
  FROM stock_document_events
  WHERE salon_id = $1 AND document_id = $2
  ORDER BY occurred_at DESC, id DESC LIMIT ${CAP + 1}`;

const time = value => value == null ? null : new Date(value).toISOString();
const actorLabel = id => Number.isSafeInteger(Number(id)) && Number(id) > 0 ? `Пользователь #${Number(id)}` : null;
const known = (occurredAt, action, source, changes, actorUserId = null) => ({
  id: null, occurred_at: time(occurredAt), action, actor_name: actorLabel(actorUserId),
  source, changes, known: true,
});

function mergeKnownEvents(document, rows) {
  const out = (rows || []).map(r => ({
    id: r.id,
    occurred_at: time(r.occurred_at),
    action: r.action,
    actor_name: actorLabel(r.actor_user_id),
    source: r.source,
    changes: r.changes && typeof r.changes === 'object' ? r.changes : {},
  }));
  const actions = new Set(out.map(e => e.action));
  if (!actions.has('document_created') && document.created_at) {
    // Для старого документа достоверны сам факт и дата создания. Текущие
    // kind/status могли меняться до установки аудита — не приписываем их прошлому.
    out.push(known(document.created_at, 'document_created_known', document.origin, {}, document.created_by));
  }
  if (!actions.has('document_posted') && document.posted_at &&
      (!document.created_at || new Date(document.posted_at).getTime() !== new Date(document.created_at).getTime())) {
    out.push(known(document.posted_at, 'document_posted_known', document.origin,
      { status: { from: null, to: 'posted' } }));
  }
  if (!actions.has('document_cancelled') && document.cancelled_at) {
    out.push(known(document.cancelled_at, 'document_cancelled_known', document.origin,
      { status: { from: null, to: 'cancelled' } }));
  }
  return out.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || Number(b.id || 0) - Number(a.id || 0)).slice(0, CAP);
}

async function load(salonId, documentId, query = db) {
  const doc = await query.oneOrNone(DOCUMENT_SQL, [salonId, documentId]);
  if (!doc) fail('Документ не найден.', 404, 'not_found');
  const rows = await query.any(EVENTS_SQL, [salonId, documentId]);
  return {
    events: mergeKnownEvents(doc, rows),
    history_since: rows.length && rows[0].history_since ? time(rows[0].history_since) : null,
    truncated: rows.length > CAP,
  };
}

module.exports = { CAP, DOCUMENT_SQL, EVENTS_SQL, mergeKnownEvents, load };
