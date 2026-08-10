'use strict';

// ── Запись на конкретный препарат, которого пациент не называл. Чистый модуль. ──
//
// Инцидент 2026-07-31: пациент попросил «биоревитализацию», модель молча оформила
// «Revi Silk 1 ml» — правило промпта «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» требует в этом
// случае обобщённую услугу (препарат подбирает врач очно). Держалось только на
// промпте; теперь create_booking переспрашивает детерминированно (hint-ответ, как
// too_soon), обход — явный patient_named_service:true.
//
// Охраняются ТОЛЬКО «препаратные» направления и ТОЛЬКО по ЛАТИНСКИМ брендовым
// токенам (Revi, Stylage, Profhilo…): зоны ботулинотерапии — русские слова со
// склонением («лба» при услуге «Лоб+Межбровье»), стем-сверка давала бы ложные
// срабатывания на самом частом легальном пути, а каждое ложное — лишний проход
// провайдера. Пациент, назвавший бренд кириллицей («стилаж»), — тоже ложное
// срабатывание, на него и есть обход patient_named_service.
const { matchesGenericTitle } = require('./catalog-data');

const GUARDED_GENERICS = ['Биоревитализация', 'Увеличение губ', 'Контурная пластика'];

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

// Латинские токены названия — маркер конкретного препарата. ≥3 букв: «ml», «gr»
// и прочие единицы измерения отсеиваются длиной.
function brandTokens(title) {
  return (String(title || '').match(/[A-Za-z]{3,}/g) || []).map(t => t.toLowerCase());
}

// → null (нарушения нет) либо { genericTitle, genericYcId, brands }.
function check({ title, categoryPath, patientText, services } = {}) {
  if (!patientText) return null;   // сверять не с чем — не судим
  const path = (categoryPath || []).map(norm);
  const genericTitle = GUARDED_GENERICS.find(g => path.includes(norm(g)));
  if (!genericTitle) return null;
  if (matchesGenericTitle(title, genericTitle)) return null;   // сама обобщённая
  const brands = brandTokens(title);
  if (!brands.length) return null;                             // без бренда не судим
  const hay = norm(patientText);
  if (brands.some(b => hay.includes(b))) return null;          // пациент называл
  const generic = (services || []).find(s => matchesGenericTitle(s.title, genericTitle));
  if (!generic) return null;   // обобщённой услуги нет в каталоге — правило невыполнимо
  return { genericTitle, genericYcId: generic.yc_id, brands };
}

module.exports = { check, GUARDED_GENERICS };
