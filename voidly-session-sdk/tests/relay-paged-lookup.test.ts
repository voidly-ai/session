import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORIZATION_USED_TOPIC0, createReadOnlyEvmRpc, resolveSettlementTransaction } from '../src/relay';
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAYER = `0x${'12'.repeat(20)}`, REF = '34'.repeat(32), TX = `0x${'56'.repeat(32)}`;
const HASH = `0x${'78'.repeat(32)}`;
const topics = [AUTHORIZATION_USED_TOPIC0, `0x${PAYER.slice(2).padStart(64,'0')}`, `0x${REF}`];
const input = { chainId:8453, authorizer:PAYER, bindingReference:REF, fromBlock:100n,
  logQuery:{maxBlocksPerRequest:50,maxRequests:32} };
const hex = (n: number|bigint) => `0x${BigInt(n).toString(16)}`;
const log = (n:number) => ({address:TOKEN,topics,transactionHash:TX,blockNumber:hex(n),removed:false});
afterEach(() => vi.restoreAllMocks());
function fixture(over: {end?:number; pages?:(first:number,last:number)=>unknown; recheck?:unknown; head?:unknown; failAt?:number; throwAt?:number} = {}) {
  const calls: Array<{method:string;params:any[]}> = []; let page = 0;
  const end = over.end ?? 220;
  const rpc = createReadOnlyEvmRpc({url:'https://rpc.invalid',fetchImpl:async (_url,init)=>{
    const body=JSON.parse(String(init.body));calls.push(body);
    let result:any;
    if (body.method === 'eth_getBlockByNumber') result = body.params[0] === 'latest'
      ? (over.head ?? {number:hex(end),hash:HASH}) : (over.recheck ?? {number:hex(end),hash:HASH});
    else if (body.method === 'eth_getLogs') {
      const f=body.params[0];
      if (!/^0x[0-9a-f]+$/.test(f.fromBlock) || !/^0x[0-9a-f]+$/.test(f.toBlock) ||
          BigInt(f.toBlock)-BigInt(f.fromBlock)>=50n) return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32001,message:'numeric toBlock and <=50 blocks required'}}));
      ++page;
      if (over.throwAt===page) throw Error('transport timeout');
      if (over.failAt===page) return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32602,message:'Archive requests require a personal token'}}),{status:403});
      result=over.pages?.(Number(BigInt(f.fromBlock)),Number(BigInt(f.toBlock)))??[];
    } else throw Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  }});
  return {rpc,calls};
}
describe('numeric complete settlement lookup',()=>{
 it('preserves full range and fixed numeric end, finding a later-page payment',async()=>{
  const f=fixture({pages:a=>a===150?[log(177)]:[]});
  expect(await resolveSettlementTransaction({...input,rpc:f.rpc})).toEqual({kind:'found',transactionHash:TX,blockNumber:177n});
  expect(f.calls.filter(c=>c.method==='eth_getLogs').map(c=>c.params[0])).toEqual([
    {address:TOKEN,topics,fromBlock:'0x64',toBlock:'0x95'},
    {address:TOKEN,topics,fromBlock:'0x96',toBlock:'0xc7'},
    {address:TOKEN,topics,fromBlock:'0xc8',toBlock:'0xdc'},
  ]);
  expect(f.calls.at(-1)).toMatchObject({method:'eth_getBlockByNumber',params:['0xdc',false]});
 });
 it('requires every page before returning empty',async()=>{
  const f=fixture();expect(await resolveSettlementTransaction({...input,rpc:f.rpc})).toEqual({kind:'not_consumed'});expect(f.calls).toHaveLength(5);
 });
 it.each([1,2,3])('partial HTTP failure on page %i is unavailable even after a match',async failAt=>{
  const f=fixture({failAt,pages:a=>a===100?[log(100)]:[]});
  expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
 });
 it('transport exception after a match does not promote it',async()=>{
  const f=fixture({throwAt:2,pages:a=>a===100?[log(100)]:[]});
  expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
 });
 it('two matches on separate pages are impossible',async()=>{
  const f=fixture({pages:a=>a===100?[log(101)]:a===200?[log(201)]:[]});
  expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('impossible');
  expect(f.calls.at(-1)).toMatchObject({method:'eth_getBlockByNumber',params:['0xdc',false]});
 });
 it('contradictory matches still require every page and a stable end',async()=>{
  for (const over of [{failAt:3}, {recheck:{number:'0xdc',hash:`0x${'99'.repeat(32)}`}}]) {
   const f=fixture({...over,pages:a=>a===100?[log(101),log(102)]:[]});
   expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
   expect(f.calls.filter(c=>c.method==='eth_getLogs')).toHaveLength(3);
  }
 });
 it.each([
  {address:`0x${'99'.repeat(20)}`}, {topics:[...topics.slice(0,2),`0x${'99'.repeat(32)}`]},
  {topics:[]}, {blockNumber:'0x96'}, {blockNumber:null}, {transactionHash:'0x123'},
  {removed:true}, {removed:undefined},
 ])('refuses misbound/malformed/removed page log %j',async patch=>{
  const f=fixture({pages:a=>a===100?[{...log(100),...patch}]:[]});
  expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
 });
 it.each([{},'bad',42])('refuses malformed page array %j',async value=>{
  const f=fixture({pages:()=>value});
  expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
 });
 it.each([{number:'0xdc',hash:`0x${'99'.repeat(32)}`},{number:'0xdb',hash:HASH},{}])('refuses changed/malformed final head %j',async recheck=>{
  const f=fixture({recheck});expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');
 });
 it.each([{number:'0x63',hash:HASH},{number:'bad',hash:HASH},{number:'0xdc',hash:'bad'},{}])('refuses unusable captured head %j',async head=>{
  const f=fixture({head});expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');expect(f.calls).toHaveLength(1);
 });
 it('refuses long history before scanning; anchor is never advanced',async()=>{
  const f=fixture({end:1700});expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('unavailable');expect(f.calls).toHaveLength(1);
 });
 it('exact inclusive page budget and one-block boundaries succeed',async()=>{
  for(const end of [100,149,150,1699]){
   const f=fixture({end});expect((await resolveSettlementTransaction({...input,rpc:f.rpc})).kind).toBe('not_consumed');
   expect(f.calls.length).toBe(Math.ceil((end-99)/50)+2);
  }
 });
 it.each([null,{}, {maxBlocksPerRequest:0,maxRequests:1},{maxBlocksPerRequest:2001,maxRequests:1},
   {maxBlocksPerRequest:50,maxRequests:257},{maxBlocksPerRequest:50,maxRequests:0},
   {maxBlocksPerRequest:1.5,maxRequests:1},{maxBlocksPerRequest:50,maxRequests:NaN},
   {maxBlocksPerRequest:50,maxRequests:32,maxElapsedMs:0},
   {maxBlocksPerRequest:50,maxRequests:32,maxElapsedMs:60001},
   {maxBlocksPerRequest:50,maxRequests:32,maxElapsedMs:NaN},
   {maxBlocksPerRequest:50,maxRequests:32,maxElapsedMs:1.5}])('rejects malformed limits before reads %j',async logQuery=>{
  const f=fixture();expect((await resolveSettlementTransaction({...input,rpc:f.rpc,logQuery:logQuery as any})).kind).toBe('unavailable');expect(f.calls).toHaveLength(0);
 });
 it.each([1,2,5])('elapsed budget after reply %i never promotes a partial or late result',async expireAfter=>{
  let elapsed=0;
  vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  const f=fixture({pages:a=>a===100?[log(101)]:[]});
  const rpc={url:f.rpc.url,request:async(method:string,params:readonly unknown[])=>{
   const result=await f.rpc.request(method,params);
   if(f.calls.length===expireAfter)elapsed=15_000;
   return result;
  }};
  expect(await resolveSettlementTransaction({...input,rpc})).toMatchObject({kind:'unavailable',detail:expect.stringContaining('elapsed budget exceeded')});
  expect(f.calls).toHaveLength(expireAfter);
 });
 it('snapshots the original anchor and query bounds before network yields',async()=>{
  const f=fixture({pages:()=>{
   original.fromBlock=200n;
   original.logQuery.maxBlocksPerRequest=1;
   original.logQuery.maxRequests=1;
   return [];
  }});
  const original={...input,logQuery:{...input.logQuery},rpc:f.rpc};
  expect((await resolveSettlementTransaction(original)).kind).toBe('not_consumed');
  expect(f.calls.filter(c=>c.method==='eth_getLogs').map(c=>c.params[0].fromBlock)).toEqual(['0x64','0x96','0xc8']);
 });
 it('default keeps latest-tag behavior and reproduces incompatible node refusal',async()=>{
  const f=fixture();expect((await resolveSettlementTransaction({...input,rpc:f.rpc,logQuery:undefined})).kind).toBe('unavailable');
  expect(f.calls).toHaveLength(1);expect(f.calls[0].params[0].toBlock).toBe('latest');
 });
});
