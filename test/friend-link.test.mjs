import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const s=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=s.slice(s.indexOf('function encodeFriendLink('),s.indexOf('function chooseMoviesForLink()'));
const ctx={btoa,atob,Number,JSON,Array,Set,Error};
function execute(expression){return runInNewContext(code+'\n'+expression,ctx)}
test('share link round trips only IDs and ratings',()=>{const result=execute("decodeFriendLink(new URL(encodeFriendLink([[1,5],[2,0]],'https://example.org')).hash)");assert.equal(JSON.stringify(result),'[[1,5],[2,0]]')});
test('rejects duplicates, invalid ratings, and oversized payloads',()=>{for(const data of ['[[1,5],[1,3]]','[[1,9]]','[[0,1]]'])assert.throws(()=>execute('decodeFriendLink("#friend="+btoa(JSON.stringify({v:1,m:'+data+'})).replace(/=/g,""))'))});
ctx.URL=URL;
