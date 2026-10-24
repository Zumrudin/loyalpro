'use strict';
// Тело POST /paperless-gateway/api/v1/document/withSigners и имена файлов — чистые функции
// (без БД и сети): их же использует живой скрипт scripts/edocs-fdoc-e2e.js.
// Маршрут: клиника подписывает первой и автоматически (operatorAutoSign; КЭП организации —
// qesCertAlias из настроек салона), пациент — вторым, по SMS-ссылке и коду.
const DAY_MS = 24 * 60 * 60 * 1000;

function safeFileName(title) {
  const base = String(title || 'Документ').replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Документ';
  return `${base}.docx`;
}

/** Одинаковые имена в комплекте → «Акт.docx», «Акт (2).docx». */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(/\.docx$/, ` (${c}).docx`);
  });
}

const fioOf = (identity) => [identity.plain.last_name, identity.plain.first_name, identity.plain.middle_name]
  .filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(' ');

function buildSendBody({ packageId, title, clientId, docs, files, identity, settings, now = new Date() }) {
  const unsignDays = Number(settings.unsign_days) > 0 ? Number(settings.unsign_days) : 14;
  const expires = new Date(now.getTime() + unsignDays * DAY_MS).toISOString();
  const corp = { type: 'corp', priority: 1, operatorAutoSign: true };
  if (settings.qes_cert_alias) corp.qesCertAlias = settings.qes_cert_alias;
  if (settings.employee_position) corp.employeePosition = settings.employee_position;
  return {
    documents: docs.map((d, i) => ({ id: d.id, name: d.file_name, file: files[i].toString('base64'), unsignExpiredDate: expires })),
    package: {
      id: packageId,
      name: title,
      objectId: `client:${clientId}`,
      signers: [corp, { type: 'client', priority: 2, id: String(clientId), name: fioOf(identity), phone: `+${identity.plain.phone}` }],
    },
  };
}

module.exports = { buildSendBody, safeFileName, uniqueNames, fioOf };
