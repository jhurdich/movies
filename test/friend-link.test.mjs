import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker from '../worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const env={TMDB_API_KEY:'test-secret'};
function post(path,data){return new Request('https://local'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})}
test('signed movie link works until 24 hours and rejects modification',async()=>{
 const now=Date.now;let time=1800000000000;Date.now=()=>time;
 try{const created=await worker.fetch(post('/api/friend-link',{entries:[[1,5],[2,4]]}),env);assert.equal(created.status,200);const {token}=await created.json();const resolve=await worker.fetch(post('/api/friend-link/resolve',{token}),env);assert.deepEqual((await resolve.json()).entries,[[1,5],[2,4]]);const bad=await worker.fetch(post('/api/friend-link/resolve',{token:token.slice(0,-3)+'xyz'}),env);assert.equal(bad.status,400);time+=86400000;const expired=await worker.fetch(post('/api/friend-link/resolve',{token}),env);assert.equal(expired.status,410)}finally{Date.now=now}
});
test('rejects invalid movie selections and unsigned legacy links',async()=>{
 const invalid=await worker.fetch(post('/api/friend-link',{entries:[[1,5],[1,4]]}),env);assert.equal(invalid.status,400);
 const legacy=await worker.fetch(post('/api/friend-link/resolve',{token:'eyJ2IjoxfQ'}),env);assert.equal(legacy.status,400);
});
