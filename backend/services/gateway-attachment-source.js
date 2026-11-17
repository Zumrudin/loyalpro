'use strict';

const { Readable } = require('stream');

// Total transfer safety deadline for the private SSH relay. This is stricter
// than nginx's idle timeout and intentionally bounds every remote download.
const DEFAULT_TIMEOUT_MS = 60000;

function remoteAttachmentUrl(origin, fileUrl, accountId) {
  if (origin !== 'http://127.0.0.1:3103') return null;
  const account = String(accountId);
  if (!/^[1-9]\d*$/.test(account)) return null;
  const prefix = `/uploads/gateway/${account}/`;
  const value = String(fileUrl || '');
  if (!value.startsWith(prefix)) return null;
  const name = value.slice(prefix.length);
  // Gateway-generated names are ASCII. Excluding URL metacharacters and
  // percent escapes prevents nginx/URL normalization from changing the path
  // that was authorized against the persisted account directory.
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(name) || name === '.' || name === '..') return null;
  return `${origin}${prefix}${name}`;
}

async function openRemoteAttachment(origin, fileUrl, accountId, options = {}) {
  const url = remoteAttachmentUrl(origin, fileUrl, accountId);
  if (!url) return { status: 'missing' };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const upstream = await (options.fetchImpl || fetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
    if (upstream.status !== 200 || !upstream.body) {
      clearTimeout(timer);
      try { await upstream.body?.cancel(); } catch (_) { /* best effort */ }
      return { status: upstream.status === 404 ? 'missing' : 'unavailable' };
    }
    return {
      status: 'ok',
      stream: Readable.fromWeb(upstream.body),
      close: () => {
        clearTimeout(timer);
        controller.abort();
      },
    };
  } catch (error) {
    clearTimeout(timer);
    return { status: 'unavailable', error };
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, remoteAttachmentUrl, openRemoteAttachment };
