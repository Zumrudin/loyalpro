'use strict';
const {fail, positiveId}=require('./journal/model');
const nullableNumber=v=>v==null||v===''?null:Number(v);
function parseAssignments(value) {
 if(!Array.isArray(value)||value.length>500) fail('Проверьте список специалистов.');
 const seen=new Set();
 return value.map(row=>{
  if(!row||typeof row!=='object') fail('Проверьте назначение специалиста.');
  if(!['number','string'].includes(typeof row.staffMemberId)) fail('Некорректный специалист.');
  const staffMemberId=positiveId(row.staffMemberId);
  if(seen.has(staffMemberId)) fail('Специалист назначен дважды.');
  seen.add(staffMemberId);
  const priceMin=nullableNumber(row.priceMin),priceMax=nullableNumber(row.priceMax),duration=nullableNumber(row.duration);
  if([row.priceMin,row.priceMax,row.duration].some(v=>typeof v==='boolean'||(v!==null&&typeof v==='object'))) fail('Некорректные параметры специалиста.');
  if([priceMin,priceMax].some(v=>v!==null&&(!Number.isFinite(v)||v<0||v>1e9||Math.abs(v*100-Math.round(v*100))>1e-5)) || (priceMax!==null&&(priceMin===null||priceMax<priceMin))) fail('Проверьте цену специалиста.');
  if(duration!==null&&(!Number.isInteger(duration)||duration<1||duration>1440)) fail('Длительность специалиста — от 1 до 1440 минут.');
  return {staffMemberId,priceMin,priceMax,duration};
 });
}
function effectiveValues(service,assignment) {
 const inheritsPrice=assignment.priceMin==null;
 return {priceMin:nullableNumber(inheritsPrice?service.price_min:assignment.priceMin),
  priceMax:nullableNumber(inheritsPrice?service.price_max:(assignment.priceMax??assignment.priceMin)),
  duration:Number(assignment.duration??service.duration),inheritsPrice,inheritsDuration:assignment.duration==null};
}
function legacyAssignment(raw,member) {
 const seconds=Number(raw?.seance_length);
 const min=nullableNumber(raw?.price?.min),max=nullableNumber(raw?.price?.max);
 return {staffMemberId:Number(member.id),priceMin:min,priceMax:min==null?null:(max!=null&&max>=min?max:min),duration:seconds>0?Math.ceil(seconds/60):null};
}
module.exports={parseAssignments,effectiveValues,legacyAssignment};
