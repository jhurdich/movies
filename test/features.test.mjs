import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import worker from '../worker.mjs';

const require = createRequire(import.meta.url);
const {sanitizedProfile} = require('../server.js');
const originalFetch = globalThis.fetch;
const request = profile => new Request('https://local/api/recommendations', {
  method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(profile)
});

test('coming-of-age recommendations use the matching movie keyword', async () => {
  const seen = [];
  globalThis.fetch = async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('/search/keyword')) return Response.json({results:[{id:10683,name:'coming of age'}]});
    if (u.pathname.endsWith('/discover/movie')) return Response.json({results:[{id:2,title:'Matched',genre_ids:[18]},{id:3,title:'Also matched',genre_ids:[35]}]});
    if (u.pathname.endsWith('/recommendations')) return Response.json({results:[{id:2,title:'Matched',genre_ids:[18]},{id:99,title:'Unrelated',genre_ids:[18]}]});
    if (u.pathname.endsWith('/watch/providers')) return Response.json({results:{US:{link:'https://www.themoviedb.org/',flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res = await worker.fetch(request({watched:[{id:1,genre_ids:[18]}],genres:['coming-of-age'],providers:[9],types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data = await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(new Set(data.results.map(movie => movie.id)),new Set([2,3]));
    const discover = seen.find(url => url.pathname.endsWith('/discover/movie'));
    assert.equal(discover.searchParams.get('with_keywords'),'10683');
    assert.equal(discover.searchParams.has('with_genres'),false);
  } finally { globalThis.fetch = originalFetch; }
});

test('theater-only results use current U.S. release dates and never send ZIP to the movie service', async () => {
  const seen = [];
  globalThis.fetch = async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('/search/keyword')) return Response.json({results:[{id:10683,name:'coming of age'}]});
    if (u.pathname.endsWith('/movie/now_playing')) return Response.json({dates:{minimum:'2026-09-01',maximum:'2026-11-05'},results:[]});
    if (u.pathname.endsWith('/discover/movie')) return Response.json({results:[{id:7,title:'In theaters',genre_ids:[18]}]});
    if (u.pathname.endsWith('/recommendations')) return Response.json({results:[{id:99,title:'Not confirmed',genre_ids:[18]}]});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res = await worker.fetch(request({watched:[{id:1,genre_ids:[18]}],genres:['coming-of-age'],providers:[9],types:['theater'],zipCode:'01234'}),{TMDB_API_KEY:'fake'});
    const data = await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(data.results.map(movie => [movie.id,movie.in_theaters]),[[7,true]]);
    const discover = seen.find(url => url.pathname.endsWith('/discover/movie'));
    assert.equal(discover.searchParams.get('with_release_type'),'2|3');
    assert.equal(discover.searchParams.get('release_date.gte'),'2026-09-01');
    assert.equal(discover.searchParams.get('release_date.lte'),'2026-11-05');
    assert.equal(discover.searchParams.get('with_keywords'),'10683');
    assert.equal(discover.searchParams.has('with_watch_providers'),false);
    assert.ok(seen.every(url => !url.href.includes('01234')));
  } finally { globalThis.fetch = originalFetch; }
});

test('theater and streaming choices both contribute results without inventing local showtimes', async () => {
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/movie/now_playing')) return Response.json({dates:{minimum:'2026-09-01',maximum:'2026-11-05'}});
    if (u.pathname.endsWith('/discover/movie')) return Response.json({results:u.searchParams.has('with_release_type') ? [{id:8,title:'Theater',genre_ids:[18]}] : [{id:7,title:'Streaming',genre_ids:[18]}]});
    if (u.pathname.endsWith('/7/watch/providers')) return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    if (u.pathname.endsWith('/8/watch/providers')) return Response.json({results:{US:{}}});
    return Response.json({results:[]});
  };
  try {
    const res = await worker.fetch(request({genres:[18],providers:[9],types:['flatrate','theater']}),{TMDB_API_KEY:'fake'});
    const data = await res.json();
    assert.deepEqual(new Map(data.results.map(movie => [movie.id,movie.in_theaters])),new Map([[7,false],[8,true]]));
  } finally { globalThis.fetch = originalFetch; }
});

test('unavailable theater data does not produce theater-only recommendations', async () => {
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/movie/now_playing')) return new Response('{}',{status:503});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res = await worker.fetch(request({types:['theater']}),{TMDB_API_KEY:'fake'});
    const data = await res.json();
    assert.equal(res.status,503);
    assert.match(data.error,/Theater listings are temporarily unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});

test('a missing coming-of-age keyword does not fall back to unrelated movies', async () => {
  globalThis.fetch = async url => {
    if (new URL(url).pathname.endsWith('/search/keyword')) return Response.json({results:[]});
    throw new Error('Unexpected request');
  };
  try {
    const res = await worker.fetch(request({genres:['coming-of-age'],types:['flatrate']}),{TMDB_API_KEY:'fake'});
    assert.equal(res.status,503);
    assert.match((await res.json()).error,/coming-of-age filter/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('account storage preserves the theme, theater option and five-digit ZIP', async () => {
  let saved;
  globalThis.fetch = async (url, options={}) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({id:'verified-user'});
    saved=JSON.parse(options.body);
    return Response.json([saved]);
  };
  try {
    const res = await worker.fetch(new Request('https://local/api/profile',{method:'PUT',headers:{authorization:'Bearer test.token','content-type':'application/json'},body:JSON.stringify({profile:{genres:['coming-of-age'],types:['theater'],zipCode:'01234'}})}),{SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public'});
    const data = await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(saved.profile.genres,['coming-of-age']);
    assert.deepEqual(saved.profile.types,['theater']);
    assert.equal(saved.profile.zipCode,'01234');
    assert.equal(data.profile.zipCode,'01234');
    assert.equal(sanitizedProfile({zipCode:'12bad',types:['theater']}).zipCode,'');
  } finally { globalThis.fetch = originalFetch; }
});

test('page zoom changes, resets and remembers a supported level', () => {
  const script=readFileSync(new URL('../public/zoom.js',import.meta.url),'utf8');
  const values=new Map();
  const buttons=Object.fromEntries(['zoomOut','zoomReset','zoomIn','zoomStatus'].map(id=>[id,{textContent:'',disabled:false,handlers:{},setAttribute(){},addEventListener(type,fn){this.handlers[type]=fn}}]));
  const doc={body:{style:{}},documentElement:{classList:{toggle(){}}},getElementById:id=>buttons[id]};
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  runInNewContext(script,{document:doc,localStorage:storage});
  buttons.zoomIn.handlers.click();
  assert.equal(doc.body.style.zoom,'1.1');
  assert.equal(values.get('nextthree.pageZoom.v1'),'1.1');
  buttons.zoomReset.handlers.click();
  assert.equal(doc.body.style.zoom,'1');
  assert.equal(buttons.zoomReset.textContent,'100%');
});
