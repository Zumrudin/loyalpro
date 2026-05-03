'use strict';

const path = require('path');

const ALLOWED_KINDS = new Set(['after', 'before']);

/**
 * Build a uploads filename for portfolio media.
 * @param {'category'|'item'} entity
 * @param {number} entityId
 * @param {'after'|'before'|null} kind  required when entity='item', ignored for 'category'
 * @param {string} originalName  user-supplied filename, used only for extension
 * @param {number} timestamp     Date.now()
 */
function buildPhotoFilename(entity, entityId, kind, originalName, timestamp) {
  const ext = (path.extname(originalName || '').toLowerCase() || '.jpg');
  if (entity === 'category') {
    return `portfolio_cat_${entityId}_${timestamp}${ext}`;
  }
  if (entity === 'item') {
    if (!ALLOWED_KINDS.has(kind)) {
      throw new Error(`Invalid kind for item: ${kind}`);
    }
    return `portfolio_item_${entityId}_${kind}_${timestamp}${ext}`;
  }
  throw new Error(`Unknown entity: ${entity}`);
}

/**
 * Validate a reorder payload: array of {id, display_order} with integer values
 * and unique ids. Used by both categories/reorder and items/reorder.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateReorderPayload(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return { valid: false, error: 'order must be a non-empty array' };
  }
  const seen = new Set();
  for (const entry of order) {
    if (!entry || !Number.isInteger(entry.id) || !Number.isInteger(entry.display_order)) {
      return { valid: false, error: 'each entry needs integer id and display_order' };
    }
    if (seen.has(entry.id)) {
      return { valid: false, error: `duplicate id: ${entry.id}` };
    }
    seen.add(entry.id);
  }
  return { valid: true };
}

/**
 * Convert a relative `/uploads/x.jpg` to an absolute URL using the request base.
 * Already-absolute URLs are passed through unchanged. Empty/null returns null.
 */
function absolutizeUrl(baseUrl, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl}${url}`;
}

module.exports = { buildPhotoFilename, validateReorderPayload, absolutizeUrl };
