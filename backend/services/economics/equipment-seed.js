'use strict';
// Сид реестра аппаратов PERI (§12 спеки, 18.10.2026): цены — ориентир из открытых
// источников, владелец вводит фактическую. service_ids пусты — привязку делает
// владелец на вкладке. Предлагается при первом открытии пустого реестра.
const EQUIPMENT_SEED = [
  { name: 'Morpheus8 (InMode)', purchase_price: 4400000, useful_life_months: 60, note: 'estelab.ru 4,4 млн – prosalonoff.ru 5,3 млн; насадки — расходник техкарты' },
  { name: 'Lumecca (InMode)', purchase_price: 5050000, useful_life_months: 60, note: 'prosalonoff.ru; лампа 100 000 вспышек → в ТО/мес; если одна платформа с Morpheus8 — ввести цену платформы один раз' },
  { name: 'Volnewmer (Classys)', purchase_price: 7100000, useful_life_months: 60, note: 'bc-clinic.ru, medeq.ru; картриджи — расходник' },
  { name: 'Pacer One Pro (MBT)', purchase_price: 1190000, useful_life_months: 60, note: 'paceronepro.ru 0,52–1,19 млн; лазерная эпиляция' },
  { name: 'Tesla Former (Iskra Medical)', purchase_price: 2800000, useful_life_months: 60, note: 'laserexpert.pro от 2,8 млн (б/у и аренда) — новая цена не найдена' },
  { name: 'PlaDuo (SHEnB)', purchase_price: 0, useful_life_months: 60, note: 'цена в РФ-источниках не найдена — уточнить у дилера' },
  { name: 'Beautylizer RSL', purchase_price: 0, useful_life_months: 60, note: 'цена не найдена — уточнить' },
  { name: 'HELEO4 (Harmonia LED Pro)', purchase_price: 0, useful_life_months: 60, note: 'цена не найдена; гель-фотосенсибилизатор — расходник' },
  { name: 'ProFacial A000-23', purchase_price: 100000, useful_life_months: 36, note: '≈30–100 тыс. по зарубежным листингам; Hollywood, аквапилинг, RF-лифтинг' },
  { name: 'Микротоки (модель уточнить)', purchase_price: 0, useful_life_months: 60, note: 'модель и цена неизвестны' },
];
module.exports = { EQUIPMENT_SEED };
