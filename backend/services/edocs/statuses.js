'use strict';
// Статусы F.Doc → статусы комплекта у нас (спека §4.4) и разбор ответа
// «статусы в разрезе маршрута подписания» (POST /portal/api/v1/documents/workflow/signing/status).
const MAP = {
  PREPARED: 'sent', CREATED_FROM_TEMPLATE: 'sent', SEND_LINK: 'sent', WAIT_FILL: 'sent', WAIT_SIGN: 'sent', ERROR_SEND: 'sent',
  SIGNED: 'signed',
  CANCELED: 'declined',
  ANNULED: 'annulled',
  SIGNING_EXPIRED: 'expired', DELETED: 'expired',
  SIGNED_PAPER: 'paper',
  ERROR_SIGN: 'error', ERROR_ANNUL: 'error',
};
const FINAL = new Set(['declined', 'annulled', 'expired', 'paper']);
const STATUSES = ['draft', 'sent', 'signed', 'declined', 'annulled', 'expired', 'paper', 'error'];

/** Наш статус по статусу F.Doc или null, если статус незнакомый. */
function mapStatus(fdoc) { return MAP[String(fdoc || '').toUpperCase()] || null; }
function isFinal(status) { return FINAL.has(status); }

function iso(ts) { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function lastSigned(signers) {
  const list = (signers || []).filter((x) => x && x.isSigned).map((x) => iso(x.dateSignOrCancel)).filter(Boolean).sort();
  return list.length ? list[list.length - 1] : null;
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.(docx?|pdf)$/i, '');

// Документ F.Doc для нашего: по id (мы отправляем свои UUID), затем по имени файла,
// затем по порядку — только если количество документов совпадает.
function matchDoc(doc, list, idx, used) {
  const free = (i) => !used.has(i);
  let i = list.findIndex((x, k) => free(k) && x && (x.id === doc.id || (doc.fdoc_document_guid && x.id === doc.fdoc_document_guid)));
  if (i < 0) i = list.findIndex((x, k) => free(k) && x && norm(x.name) && (norm(x.name) === norm(doc.file_name) || norm(x.name) === norm(doc.title)));
  if (i < 0 && free(idx) && list[idx]) i = idx;
  if (i < 0) return null;
  used.add(i);
  return list[i];
}

/**
 * Обновления по ответу F.Doc для одного комплекта.
 * pkg — строка edoc_packages; docs — её edoc_documents (по sort_order);
 * wf — { id, name, status, documents: [{ id, name, status, clientSigners, employeeSigners }] }.
 */
function applyWorkflow(pkg, docs, wf, now = new Date()) {
  const mapped = mapStatus(wf && wf.status);
  const status = mapped || (pkg.status === 'draft' ? 'sent' : pkg.status);   // незнакомый статус: комплект не теряем
  const list = (wf && Array.isArray(wf.documents)) ? wf.documents : [];
  const sameCount = list.length === docs.length;
  const used = new Set();
  const documents = [];
  docs.forEach((d, idx) => {
    const w = matchDoc(d, list, sameCount ? idx : -1, used);
    if (!w) return;
    documents.push({
      id: d.id,
      fdoc_document_guid: w.id && w.id !== d.id ? String(w.id) : (d.fdoc_document_guid || null),
      fdoc_status: w.status || null,
      client_signed_at: lastSigned(w.clientSigners),
      corp_signed_at: lastSigned(w.employeeSigners),
    });
  });
  let signedAt = null;
  if (status === 'signed') {
    const times = documents.map((x) => x.client_signed_at).filter(Boolean).sort();
    signedAt = pkg.signed_at ? new Date(pkg.signed_at).toISOString() : (times.length ? times[times.length - 1] : now.toISOString());
  }
  return {
    package: {
      status,
      fdoc_status: (wf && wf.status) || null,
      fdoc_package_guid: wf && wf.id && wf.id !== pkg.id ? String(wf.id) : (pkg.fdoc_package_guid || null),
      signed_at: signedAt,
      unknownStatus: !mapped,
    },
    documents,
  };
}

module.exports = { STATUSES, mapStatus, isFinal, applyWorkflow };
