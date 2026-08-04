'use strict';

// ── Словарь имён, собранный по клиентской базе самого салона ────────────────
//
// Базовый список (utils/given-names.js) полным быть не может, а состав базы у
// каждой клиники свой. Зато в самой базе имя часто стоит в позиции, доказанной
// отчеством («Абулаева Гульназ Ахмедовна») — такие слова заведомо имена, и они
// разрешают обратиться к тем, кто записан одним словом («Гульназ») или как
// «Фамилия Имя», где базовый словарь пасует.
// На боевой базе PERI это +46 карточек к 3705, покрытие 85.9% → 87.7%.
//
// В словарь попадают ТОЛЬКО позиционно доказанные имена (splitFio.proven):
// брать слова из карточек, разобранных тем же словарём, — это самоподтверждение,
// одна ошибка расползлась бы по всей базе.

const { db } = require('../db');
const { splitFio, normalizeName } = require('./person-name');

const TTL_MS = 6 * 60 * 60 * 1000;      // база клиентов меняется медленно
const cache = new Map();                 // salonId → { names: Set, expires: number }

const EMPTY = new Set();

/**
 * Набор нормализованных имён салона. Никогда не бросает: без словаря работает
 * базовый список, это деградация, а не отказ.
 * @returns {Promise<Set<string>>}
 */
async function load(salonId, opts = {}) {
  if (!salonId) return EMPTY;
  const now = opts.nowMs || Date.now();
  const hit = cache.get(salonId);
  if (hit && hit.expires > now) return hit.names;

  let names = EMPTY;
  try {
    const rows = await db.any(
      `SELECT name FROM clients WHERE salon_id = $1 AND name IS NOT NULL AND name <> ''`,
      [salonId]);
    const set = new Set();
    for (const r of rows) {
      const { given, proven } = splitFio(r.name);
      if (proven && given) set.add(normalizeName(given));
    }
    names = set;
  } catch (e) {
    // Логгер здесь намеренно не подключаем (utils не тянет services): вызывающая
    // сторона знает контекст. Пустой словарь кэшируем на короткий срок, чтобы не
    // долбить упавшую БД на каждом сообщении.
    cache.set(salonId, { names: EMPTY, expires: now + 60 * 1000 });
    return EMPTY;
  }

  cache.set(salonId, { names, expires: now + TTL_MS });
  return names;
}

/** Сброс кэша — для тестов и на случай массовой правки карточек. */
function _reset() { cache.clear(); }

module.exports = { load, _reset };
