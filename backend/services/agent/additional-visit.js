'use strict';

// Shared vocabulary for dialog routing and the write guard. This only identifies
// an additional visit; refusals, questions, slots and consent are checked by the
// caller before any write. Keep both gates consistent for «отдельный новый визит».
function mentionsAdditionalVisit(text) {
  const s = String(text || '').toLowerCase().replace(/\*/g, '');
  return /дополнительн[а-яё]*\s+(?:запис|визит|при[её]м)|ещ[её]\s+одн[а-яё]*\s+(?:отдельн[а-яё]*\s+)?(?:запис|визит|при[её]м)|отдельн[а-яё]*\s+(?:нов[а-яё]*\s+)?(?:запис|визит|при[её]м)|прежн[а-яё]*\s+(?:запис[а-яё]*\s+)?остав/iu.test(s);
}

module.exports = { mentionsAdditionalVisit };
