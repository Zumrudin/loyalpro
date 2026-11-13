'use strict';
// Money is calculated in integer kopecks; inputs are never trusted totals.
function invalid(message) { throw new Error(message); }
function money(value, label = 'Сумма') {
 if (!['number','string'].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) invalid(`${label}: укажите неотрицательное число с точностью до копейки.`);
 const cents = Math.round(Number(value) * 100);
 if (!Number.isSafeInteger(cents) || cents > 100000000000) invalid(`${label}: слишком большое значение.`);
 return cents;
}
function line(input) {
 if (!input || typeof input !== 'object') invalid('Некорректная строка услуги.');
 const serviceId = Number(input.serviceId), quantity = Number(input.quantity);
 if (!Number.isSafeInteger(serviceId) || serviceId < 1) invalid('Некорректная услуга.');
 if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) invalid('Количество — целое число от 1 до 100.');
 const unitPrice = money(input.unitPrice, 'Цена');
 const gross = unitPrice * quantity;
 if (!Number.isSafeInteger(gross) || gross > 100000000000) invalid('Стоимость строки слишком большая.');
 let total, discount;
 if (input.mode === 'total') {
  total = money(input.total, 'Итого');
  if (total > gross) invalid('Итог не может превышать стоимость без скидки. Для увеличения суммы измените цену.');
  discount = gross ? Math.round((gross-total)/gross * 1000000)/10000 : 0;
 } else {
  if (input.mode !== undefined && input.mode !== 'discount') invalid('Неизвестный способ расчёта.');
  const basisPoints = money(input.discount ?? 0, 'Скидка');
  if (basisPoints > 10000) invalid('Скидка — от 0 до 100%.');
  total = Math.round(gross * (10000 - basisPoints) / 10000);
  discount = basisPoints / 100;
 }
 return {serviceId,quantity,unitPrice:unitPrice/100,discount,total:total/100,gross:gross/100,discountAmount:(gross-total)/100,mode:input.mode || 'discount'};
}
function quote(inputs, serviceIds) {
 if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10) invalid('Укажите от 1 до 10 строк услуг.');
 const lines = inputs.map(line), ids = lines.map(l=>l.serviceId);
 if (new Set(ids).size !== ids.length || ids.length !== serviceIds.length || serviceIds.some(id=>!ids.includes(id))) invalid('Состав расчёта не совпадает с выбранными услугами.');
 const cents=lines.reduce((sum,l)=>sum+Math.round(l.total*100),0);
 if (!Number.isSafeInteger(cents) || cents>100000000000) invalid('Сумма визита слишком большая.');
 return {lines,total:cents/100};
}
module.exports={money,line,quote};
