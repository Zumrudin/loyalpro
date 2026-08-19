'use strict';

// Детерминированная маршрутизация ТОЛЬКО для состава prompt-v2. Она не вызывает
// инструменты и не принимает решения за пациента: при неясном сообщении включаем
// общий сценарий, а критичные safety-инварианты есть в v2 всегда.
const SCENARIOS = Object.freeze({
  BOOKING: 'booking',
  MANAGE_BOOKING: 'manage_booking',
  PRICE: 'price',
  MEDICAL: 'medical',
  PERSONAL: 'personal',
  ESCALATION: 'escalation',
  CLINIC: 'clinic',
  GENERAL: 'general',
});

const RULES = [
  [SCENARIOS.MANAGE_BOOKING, /(?:перенес|перезапис|отмен|измен|добав(?:ить|ьте)|убра(?:ть|ть)|удал(?:ить|ите)).{0,35}(?:запис|визит|процедур)|(?:запис|визит).{0,35}(?:перенес|отмен|измен)/iu],
  [SCENARIOS.BOOKING, /(?:запиш|записаться|окошк|свободн(?:ое|ые)?\s+(?:время|дат)|когда\s+(?:можно|принимает)|на\s+какое\s+время)/iu],
  [SCENARIOS.PRICE, /(?:цен[аы]|стоимост|сколько\s+стоит|прайс|поч[её]м|скидк)/iu],
  [SCENARIOS.MEDICAL, /(?:болит|боль|от[её]к|осложнен|покрасн|сып[ьи]|беремен|лактац|грудн(?:ое|ом)\s+вскармливани|аллерг|диабет|противопоказ|реабилит|подготовк|можно\s+ли\s+мне)/iu],
  [SCENARIOS.PERSONAL, /(?:бонус|абонемент|остаток\s+посещен)/iu],
  [SCENARIOS.ESCALATION, /(?:администратор|человек|оператор|жалоб|недовол|возмущ|опаздыва|задержива)/iu],
  [SCENARIOS.CLINIC, /(?:адрес|телефон|как\s+добраться|где\s+вы\s+находитесь|парковк|метро|лицензи)/iu],
];

function detectPromptScenarios(text) {
  const value = String(text || '');
  const matched = RULES.filter(([, re]) => re.test(value)).map(([name]) => name);
  return matched.length ? [...new Set(matched)] : [SCENARIOS.GENERAL];
}

module.exports = { SCENARIOS, detectPromptScenarios };
