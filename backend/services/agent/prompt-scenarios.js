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
  OBJECTION: 'objection',
  UNDECIDED: 'undecided',
});

// One price predicate for routing, KB prefetch and reply follow-through.
// Intervening words are normal Russian: «сколько у вас будет стоить …».
// Do not classify duration, number of sessions or appointment time as money.
const PRICE_QUESTION_RE = /(?<![\p{L}])(?:цен(?:а|ы|у|е|ой|ам|ами|ах)|ценник[\p{L}]*|стоимост[\p{L}]*|прайс[\p{L}]*|поч[её]м)(?![\p{L}])|(?:сколько|во\s+сколько)[^?!\n]{0,100}?(?:стоит|стоят|стоить|обойд[её]тся|обойдутся|выйдет|выйдут)(?![\p{L}])|(?:стоит|стоят|обойд[её]тся|обойдутся)\s+сколько|сколько[^?!\n]{0,60}(?:рублей|руб\.?|₽)|по\s+деньгам/iu;

function isPriceQuestion(text) {
  return String(text || '').split(/[?!;\n]/u).some(part => {
    // «Сколько времени стоит выделить?» is duration, despite «сколько … стоит».
    const quantity = /сколько\s+(?:(?:ещ[её]|примерно|всего)\s+)?(?:времени|минут|часов|дней|сеансов|процедур|раз)(?![\p{L}])/iu.test(part);
    return PRICE_QUESTION_RE.test(part) && (!quantity || /цен|стоимост|руб|₽|деньг/iu.test(part));
  });
}

const RULES = [
  [SCENARIOS.MANAGE_BOOKING, /(?:перенес|перезапис|отмен|измен|добав(?:ить|ьте)|убра(?:ть|ть)|удал(?:ить|ите)).{0,35}(?:запис|визит|процедур)|(?:запис|визит).{0,35}(?:перенес|отмен|измен)/iu],
  [SCENARIOS.BOOKING, /(?:запиш|записаться|окошк|свободн(?:ое|ые)?\s+(?:время|дат)|когда\s+(?:можно|принимает)|на\s+какое\s+время)/iu],
  [SCENARIOS.PRICE, { test: text => isPriceQuestion(text) || /скидк/iu.test(text) }],
  [SCENARIOS.MEDICAL, /(?:болит|боль|от[её]к|осложнен|покрасн|сып[ьи]|беремен|лактац|грудн(?:ое|ом)\s+вскармливани|аллерг|диабет|противопоказ|реабилит|подготовк|можно\s+ли\s+мне)/iu],
  [SCENARIOS.PERSONAL, /(?:бонус|абонемент|остаток\s+посещен)/iu],
  [SCENARIOS.ESCALATION, /(?:администратор|человек|оператор|жалоб|недовол|возмущ|опаздыва|задержива)/iu],
  [SCENARIOS.CLINIC, /(?:адрес|телефон|как\s+добраться|где\s+вы\s+находитесь|парковк|метро|лицензи)/iu],
  // Сомнение/откладывание: «дорого», «подумаю», «сравниваю», «напишу сама».
  // Ложное срабатывание даёт лишний модуль-инструкцию, а не действие, поэтому
  // регэксп, а не LLM-роутер (решение 07.10.2026). Границы — lookaround по
  // \p{L}: «\b» в JS ASCII-only. Правая граница — только у целых слов: стемы
  // («сравнива-ю», «сомнева-юсь», «не уверен-а») обязаны принимать окончание.
  // Отрицание перед «дорого»/«сомнева» («не дорого?», «не очень дорого»,
  // «не сомневаюсь, запишите») — не сомнение: отсекается lookbehind'ом
  // по целому слову «не» (Unicode-граница, не ASCII \b).
  [SCENARIOS.OBJECTION, /(?<![\p{L}])(?:(?:(?<!(?:^|[^\p{L}])не\s+(?:очень\s+)?)дорог(?:о|овато)|подума(?:ю|ем)|напишу\s+сам[аи]?)(?![\p{L}])|сравнива|не\s+уверен|(?<!(?:^|[^\p{L}])не\s+(?:очень\s+)?)сомнева|пока\s+не\s+готов|посоветуюсь|отложу)/iu],
  // Нерешительность: пациент не знает, какую процедуру хочет.
  [SCENARIOS.UNDECIDED, /(?:не\s+зна[юем]+,?\s+(?:что|какую|какой|какая)|что\s+(?:мне\s+)?(?:подойд[её]т|посоветуете|лучше\s+(?:сделать|выбрать))|посоветуйте|помогите\s+(?:выбрать|подобрать)|что\s+выбрать|хочу\s+выглядеть|освежить)/iu],
];

function detectPromptScenarios(text) {
  const value = String(text || '');
  const matched = RULES.filter(([, re]) => re.test(value)).map(([name]) => name);
  return matched.length ? [...new Set(matched)] : [SCENARIOS.GENERAL];
}

module.exports = { SCENARIOS, detectPromptScenarios, isPriceQuestion };
