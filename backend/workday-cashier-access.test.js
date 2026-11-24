'use strict';
jest.mock('./middleware/auth',()=>({auth:(req,res,next)=>{req.user=req.actor;next();}}));
const {apiAuthGuard}=require('./routes/index');
function check(role,method,path){
 const next=jest.fn();const res={status:jest.fn().mockReturnThis(),json:jest.fn()};
 apiAuthGuard({actor:{role,salonId:7},method,path},res,next);
 return {next,res};
}
test.each(['/journal/day','/journal/week','/journal/month'])('all staff reach journal router %s',path=>{
 for(const role of ['owner','admin','admin_cashier','specialist']) expect(check(role,'GET',path).next).toHaveBeenCalled();
});
test.each([['GET','/records'],['GET','/paper-folders/day'],['PATCH','/clients/5/paper-folder']])('cashier Workday grant %s %s',(method,path)=>{
 expect(check('admin_cashier',method,path).next).toHaveBeenCalled();
 expect(check('specialist',method,path).res.status).toHaveBeenCalledWith(403);
});
test.each([['POST','/records'],['GET','/clients'],['GET','/clients/5'],['POST','/clients/5/bonus'],['PATCH','/clients/5'],['PATCH','/clients/5/paper-folder/other']])('cashier no broader access %s %s',(method,path)=>{
 const result=check('admin_cashier',method,path);expect(result.next).not.toHaveBeenCalled();expect(result.res.status).toHaveBeenCalledWith(403);
});
