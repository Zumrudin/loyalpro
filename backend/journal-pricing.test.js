'use strict';
const p=require('./services/journal/pricing');
const base={serviceId:7,quantity:2,unitPrice:'100.01',discount:10};
test('quantity, unit price and percentage calculate rounded integer kopecks',()=>{expect(p.line(base)).toMatchObject({gross:200.02,total:180.02,discountAmount:20});});
test('explicit total derives discount and accepts free services',()=>{expect(p.line({...base,mode:'total',total:150})).toMatchObject({total:150,discountAmount:50.02});expect(p.line({...base,unitPrice:0,discount:100})).toMatchObject({total:0});});
test.each([{quantity:0},{quantity:1.5},{quantity:101},{unitPrice:-1},{unitPrice:'NaN'},{unitPrice:'1.001'},{unitPrice:null},{discount:101},{discount:-1},{mode:'total',total:500},{mode:'unknown'}])('rejects invalid financial input %p',patch=>expect(()=>p.line({...base,...patch})).toThrow());
test('quote rejects duplicate or mismatched services',()=>{expect(()=>p.quote([base,base],[7,8])).toThrow();expect(()=>p.quote([base],[8])).toThrow();expect(p.quote([base],[7]).total).toBe(180.02);});
