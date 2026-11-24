import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const src=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('const MATCH_STOP_WORDS='),src.indexOf('function showMovieMatch(movie)'));
function evaluate(profile,movie){return runInNewContext(code+'\nestimateMovieMatch(movie)',{profile,movie,Set,Math,Number,String,Object,Array});}
const profile=(watched,stars)=>({watched,starRatings:stars,ratings:{},genres:[],decades:[]});
const target={id:9,genre_ids:[18,35],release_date:'2024-01-01',overview:'A teenager finds friendship at high school and falls in love.'};
test('similar highly rated story scores higher than the same story rated poorly',()=>{
 const m={id:1,genre_ids:[18,35],release_date:'2020-01-01',overview:'A teenager discovers friendship and romance at high school.'};
 assert.ok(evaluate(profile([m],{1:5}),target).score>evaluate(profile([m],{1:1}),target).score);
});
test('no ratings or preferences gives no estimate',()=>{assert.equal(evaluate(profile([{id:1,genre_ids:[18]}],{}),target),null)});
test('known film uses own rating exactly',()=>{assert.equal(evaluate(profile([],{9:4}),target).score,7.5)});
test('zero evidence is indicated and a matching decade alone is not a rated neighbor',()=>{
 const result=evaluate(profile([{id:1,genre_ids:[27],release_date:'2022-01-01'}],{1:5}),target);assert.equal(result.matchCount,0);assert.equal(result.score,5);
});
