'use strict';
const { sectionFor, appendSection, assertUnchanged, HEADING } = require('./scripts/kb-import-sales-takes');
const data = require('../docs/content/mila-service-sales-draft-2026-10-10.json');

test('approved takes remain verbatim and the import is idempotent, preserving original bytes', () => {
  const original = '# Procedure\n\nExisting content.  \n';
  for (const id of new Set(data.takes.map(t => t.article_id))) {
    const takes = data.takes.filter(t => t.article_id === id);
    const section = sectionFor(takes);
    const result = appendSection(original, section);
    expect(result.startsWith(original)).toBe(true);
    for (const take of takes) expect(result).toContain(take.text);
    expect(appendSection(result, section)).toBe(result);
    expect(result.split(HEADING)).toHaveLength(2);
  }
});

test('does not silently overwrite an edited or partial sales section', () => {
  expect(() => appendSection('# Article\n' + HEADING + '\nEdited content', sectionFor(data.takes.slice(0,1))))
    .toThrow('differs');
});

test('concurrent edits, publication changes and tenant mismatch block the transaction', () => {
  const before = { id: 5, salon_id: 1, title: 'Lumecca', body: 'Original', is_published: true, internal_only: false };
  expect(() => assertUnchanged({ ...before }, before)).not.toThrow();
  for (const patch of [{ body: 'Edited' }, { title: 'Edited' }, { salon_id: 2 }, { is_published: false }, { internal_only: true }]) {
    expect(() => assertUnchanged({ ...before, ...patch }, before)).toThrow('concurrently');
  }
  expect(() => assertUnchanged(null, before)).toThrow('concurrently');
});
