'use strict';
// Read-only inventory before migration/deployment. Output is aggregate only.
const {pool}=require('../db');
const {fetchSource,buildSnapshot}=require('../services/service-catalog-reconcile');
async function main(){
 const arg=process.argv.slice(2);
 if(arg.length!==1||!/^--salon=[1-9]\d*$/.test(arg[0]))throw new Error('usage');
 const salonId=Number(arg[0].slice(8));
 if(!Number.isSafeInteger(salonId))throw new Error('usage');
 const c=await pool.connect();let salon,state;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL statement_timeout='15s'");
  salon=(await c.query('SELECT * FROM salons WHERE id=$1',[salonId])).rows[0];
  if(!salon?.yclients_company_id)throw new Error('connection');
  const services=(await c.query('SELECT * FROM service_catalog WHERE salon_id=$1 ORDER BY id',[salonId])).rows.map(s=>({...s,version:Number(s.version||0),assignments_initialized:!!s.assignments_initialized}));
  const staff=(await c.query('SELECT id,yclients_staff_id,is_active FROM staff_members WHERE salon_id=$1 ORDER BY id',[salonId])).rows;
  const exists=(await c.query("SELECT to_regclass('public.service_staff_assignments') IS NOT NULL AS present")).rows[0].present;
  const assignments=exists?(await c.query('SELECT service_id,staff_member_id,price_min,price_max,duration FROM service_staff_assignments WHERE salon_id=$1',[salonId])).rows:[];
  state={companyId:String(salon.yclients_company_id),services,staff,assignments};
  await c.query('COMMIT');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
 const source=await fetchSource(salon),snapshot=buildSnapshot(state,source);
 const exceptions={};for(const item of snapshot.exceptions)exceptions[item.code]=(exceptions[item.code]||0)+1;
 console.log(JSON.stringify({readOnly:true,capturedAt:snapshot.capturedAt,localServices:state.services.length,
  localStaff:state.staff.length,activeStaff:state.staff.filter(s=>s.is_active).length,
  sourceCounts:snapshot.sourceCounts,targetServices:snapshot.targets.length,
  targetAssignments:snapshot.targets.reduce((sum,s)=>sum+s.target.assignments.length,0),
  skippedServices:snapshot.skippedServices,removedInactiveAssignments:snapshot.removedInactiveAssignments,
  canApply:snapshot.canApply,exceptions},null,2));
}
main().catch(()=>{console.error('Inventory failed. Usage: node scripts/service-catalog-inventory.js --salon=<id>. No changes applied.');process.exitCode=1;}).finally(()=>pool.end());
