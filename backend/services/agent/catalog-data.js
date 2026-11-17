'use strict';
const serviceCatalog = require('../service-catalog');
const settings = require('../agent-settings');
const svcFilter = require('./service-filter');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentCatalogData');
const UNIT_PRICE_SERVICE_TITLE = 'Ботулинотерапия Ботулакс 1 ед';
const GENERIC_SERVICE_TITLES = ['Биоревитализация', 'Увеличение губ', 'Контурная пластика', UNIT_PRICE_SERVICE_TITLE];
const warnedMissing = new Set();
const normTitle = t => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
function matchesGenericTitle(catalogTitle, genericTitle) { const t=normTitle(catalogTitle),g=normTitle(genericTitle);return t===g||(t.startsWith(g)&&t.slice(g.length).trim().startsWith('(')); }
function warnMissingGenericServices(salonId, services) {
 for (const title of GENERIC_SERVICE_TITLES) { const key=`${salonId}:${title}`;if(warnedMissing.has(key)||services.some(s=>matchesGenericTitle(s.title,title)))continue;warnedMissing.add(key);logger.warn(`salon ${salonId}: обобщённой услуги «${title}» нет в каталоге агента`); }
}
const numberOrNull=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
function categoryPath(categories, categoryId) {
 const byId=new Map((categories||[]).map(c=>[Number(c.id),c])),path=[],seen=new Set();let current=categoryId==null?null:Number(categoryId);
 while(current!=null&&!seen.has(current)){seen.add(current);const row=byId.get(current);if(!row)break;path.push(row.title);current=row.parent_id==null?null:Number(row.parent_id);}
 return path.reverse();
}
// Pure local-catalog DTO adapter: no HTTP, writes or legacy price/name fallback.
function adaptCatalog(data, filter) {
 const categories=data?.categories||[];
 const activeStaff=new Map((data?.staffMembers||[]).filter(m=>m.is_active&&m.yclients_staff_id!=null).map(m=>[String(m.yclients_staff_id),m]));
 return (data?.services||[]).flatMap(service=>{
  const externalId=numberOrNull(service.yclients_id);
  if(externalId==null||!service.linked||service.active!==true||service.assignmentsUnresolved||!svcFilter.decideOfferVisible(filter,externalId,true))return [];
  const staff=(Array.isArray(service.staff)?service.staff:[]).flatMap(raw=>{
   const externalStaffId=numberOrNull(raw?.id??raw),member=activeStaff.get(String(externalStaffId));
   if(!member||!svcFilter.filterServiceStaff(filter,externalId,[externalStaffId]).length)return [];
   const rawPrice=raw&&typeof raw==='object'?raw.price:null,rawDuration=raw&&typeof raw==='object'?numberOrNull(raw.seance_length):null;
   const priceMin=rawPrice?.min==null?numberOrNull(service.price_min):numberOrNull(rawPrice.min);
   const priceMax=rawPrice?.min==null?numberOrNull(service.price_max):(rawPrice.max==null?priceMin:numberOrNull(rawPrice.max));
   const durationMin=rawDuration==null?numberOrNull(service.duration):Math.round(rawDuration/60);
   if(!Number.isInteger(durationMin)||durationMin<=0)return [];
   return [{yc_id:externalStaffId,name:member.name,price_min:priceMin,price_max:priceMax,duration_min:durationMin}];
  });
  if(!staff.length)return [];
  const allPriced=staff.every(s=>s.price_min!=null);
  const mins=staff.map(s=>s.price_min),maxs=staff.map(s=>s.price_max==null?s.price_min:s.price_max);
  return [{local_id:Number(service.id),yc_id:externalId,title:service.title,duration_min:numberOrNull(service.duration),price_min:allPriced?Math.min(...mins):null,price_max:allPriced?Math.max(...maxs):null,category_id:service.category_id==null?null:Number(service.category_id),category_path:categoryPath(categories,service.category_id),category_paths:[...new Set([service.category_id,...(service.secondary_category_ids||[])].filter(x=>x!=null).map(Number))].map(id=>categoryPath(categories,id)),staff}];
 });
}
async function loadCatalogServices(salonId) {
 const [data,filter]=await Promise.all([serviceCatalog.list(salonId),settings.loadServiceFilter(salonId)]);
 const services=adaptCatalog(data,filter);warnMissingGenericServices(salonId,services);return services;
}
async function loadCategoryTitles(salonId) {
 const data=await serviceCatalog.list(salonId);
 return (data.categories||[]).map(c=>({id:Number(c.id),title:c.title,external_id:c.yclients_id==null?null:Number(c.yclients_id)}));
}
module.exports={adaptCatalog,categoryPath,loadCatalogServices,loadCategoryTitles,GENERIC_SERVICE_TITLES,UNIT_PRICE_SERVICE_TITLE,warnMissingGenericServices,matchesGenericTitle};
