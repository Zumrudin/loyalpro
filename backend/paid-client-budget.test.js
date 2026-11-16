'use strict';
const mockAttempt=jest.fn();
jest.mock('./services/resource-limits',()=>({attempt:mockAttempt}));
const guard=require('./services/paid-client-budget');
beforeEach(()=>mockAttempt.mockReset().mockResolvedValue());
test('every explicit retry consumes quota and disables hidden SDK retries',async()=>{
 const create=jest.fn().mockRejectedValueOnce(new Error('synthetic provider failure')).mockResolvedValue('ok');
 const c=guard({chat:{completions:{create}}});
 await expect(c.chat.completions.create({model:'synthetic'},{maxRetries:4})).rejects.toThrow('synthetic');
 await expect(c.chat.completions.create({model:'synthetic'})).resolves.toBe('ok');
 expect(mockAttempt).toHaveBeenCalledTimes(2);
 expect(mockAttempt).toHaveBeenCalledWith({paid:true});
 expect(create.mock.calls.every(([,options])=>options.maxRetries===0)).toBe(true);
});
test('exhausted shared paid budget stops chat and embeddings before network',async()=>{
 mockAttempt.mockRejectedValue(Object.assign(new Error('limit'),{code:'BUDGET_EXHAUSTED',status:429}));
 const chat=jest.fn(),embed=jest.fn();const c=guard({chat:{completions:{create:chat}},embeddings:{create:embed}});
 await expect(c.chat.completions.create({})).rejects.toMatchObject({status:429});
 await expect(c.embeddings.create({})).rejects.toMatchObject({status:429});
 expect(chat).not.toHaveBeenCalled();expect(embed).not.toHaveBeenCalled();
});
