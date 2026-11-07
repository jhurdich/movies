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

test('multiple genres match any chosen genre', async () => {
  const seen = [];
  globalThis.fetch = async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('/discover/movie')) return Response.json({results:[
      {id:2,title:'Drama',genre_ids:[18]}, {id:3,title:'Comedy',genre_ids:[35]}
    ]});
    if (u.pathname.endsWith('/recommendations')) return Response.json({results:[{id:99,title:'Unrelated',genre_ids:[27]}]});
    if (u.pathname.endsWith('/watch/providers')) return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res = await worker.fetch(request({watched:[{id:1}],genres:[18,35],types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data = await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(new Set(data.results.map(movie=>movie.id)),new Set([2,3]));
    const discover=seen.find(url=>url.pathname.endsWith('/discover/movie'));
    assert.equal(discover.searchParams.get('with_genres'),'18|35');
    assert.equal(discover.searchParams.has('with_keywords'),false);
  } finally { globalThis.fetch = originalFetch; }
});

test('coming of age and other genres combine across streaming and theaters', async () => {
  const seen = [];
  globalThis.fetch = async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('/search/keyword')) return Response.json({results:[{id:10683,name:'coming of age'}]});
    if (u.pathname.endsWith('/movie/now_playing')) return Response.json({dates:{minimum:'2026-09-01',maximum:'2026-11-05'}});
    if (u.pathname.endsWith('/discover/movie')) {
      const theme=u.searchParams.has('with_keywords'), theater=u.searchParams.has('with_release_type');
      return Response.json({results:[theater
        ? (theme ? {id:4,title:'Theme in theaters',genre_ids:[27]} : {id:3,title:'Drama in theaters',genre_ids:[18]})
        : (theme ? {id:2,title:'Theme streaming',genre_ids:[35]} : {id:1,title:'Drama streaming',genre_ids:[18]})]});
    }
    if (u.pathname.endsWith('/recommendations')) return Response.json({results:[{id:99,title:'Unrelated',genre_ids:[27]}]});
    if (u.pathname.endsWith('/watch/providers')) return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res=await worker.fetch(request({watched:[{id:500}],genres:[18,'coming-of-age'],types:['flatrate','theater']}),{TMDB_API_KEY:'fake'});
    const data=await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(new Set(data.results.map(movie=>movie.id)),new Set([1,2,3,4]));
    assert.deepEqual(new Set(data.results.filter(movie=>movie.in_theaters).map(movie=>movie.id)),new Set([3,4]));
    assert.ok(data.results.every(movie=>movie.reason==='Matches your selected preferences.'));
    const discovers=seen.filter(url=>url.pathname.endsWith('/discover/movie'));
    assert.equal(discovers.length,4);
    assert.ok(discovers.every(url=>url.searchParams.has('with_genres') !== url.searchParams.has('with_keywords')));
  } finally { globalThis.fetch = originalFetch; }
});

test('recommendations return at most ten distinct unwatched and unrated movies', async () => {
  const movies=Array.from({length:15},(_,i)=>({id:i+1,title:'Movie '+(i+1),genre_ids:[18]}));
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/discover/movie')) return Response.json({results:[...movies,movies[4]]});
    if(u.pathname.endsWith('/recommendations')) return Response.json({results:movies});
    if(u.pathname.endsWith('/watch/providers')) return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res=await worker.fetch(request({watched:[{id:1}],ratings:{2:-1},genres:[18],types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data=await res.json(), ids=data.results.map(movie=>movie.id);
    assert.equal(res.status,200);
    assert.equal(ids.length,10);
    assert.equal(new Set(ids).size,10);
    assert.ok(!ids.includes(1) && !ids.includes(2));
    assert.equal(data.warning,null);
  } finally { globalThis.fetch=originalFetch; }
});

test('a broad search stays within the Worker request limit', async () => {
  let requests=0;
  const movies=Array.from({length:32},(_,i)=>({id:100+i,title:'Candidate',genre_ids:[18]}));
  globalThis.fetch=async url=>{
    requests++;
    const u=new URL(url);
    if(u.pathname.endsWith('/search/keyword')) return Response.json({results:[{id:10683,name:'coming of age'}]});
    if(u.pathname.endsWith('/movie/now_playing')) return Response.json({dates:{minimum:'2026-09-01',maximum:'2026-11-05'}});
    if(u.pathname.endsWith('/discover/movie')) return Response.json({results:u.searchParams.has('with_release_type')?[]:movies});
    if(u.pathname.endsWith('/recommendations')) return Response.json({results:[]});
    if(u.pathname.endsWith('/watch/providers')) return Response.json({results:{US:{}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res=await worker.fetch(request({watched:Array.from({length:8},(_,i)=>({id:i+1})),genres:[18,'coming-of-age'],types:['flatrate','theater']}),{TMDB_API_KEY:'fake'});
    assert.equal(res.status,200);
    assert.equal((await res.json()).results.length,0);
    assert.ok(requests<=50,`Made ${requests} external requests`);
  } finally { globalThis.fetch=originalFetch; }
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

test('account storage preserves multiple genres, the theater option and five-digit ZIP', async () => {
  let saved;
  globalThis.fetch = async (url, options={}) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({id:'verified-user'});
    saved=JSON.parse(options.body);
    return Response.json([saved]);
  };
  try {
    const res = await worker.fetch(new Request('https://local/api/profile',{method:'PUT',headers:{authorization:'Bearer test.token','content-type':'application/json'},body:JSON.stringify({profile:{genres:[18,35,'coming-of-age'],types:['theater'],zipCode:'01234'}})}),{SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public'});
    const data = await res.json();
    assert.equal(res.status,200);
    assert.deepEqual(saved.profile.genres,[18,35,'coming-of-age']);
    assert.deepEqual(data.profile.genres,[18,35,'coming-of-age']);
    assert.deepEqual(saved.profile.types,['theater']);
    assert.equal(saved.profile.zipCode,'01234');
    assert.equal(data.profile.zipCode,'01234');
    assert.equal(sanitizedProfile({zipCode:'12bad',types:['theater']}).zipCode,'');
  } finally { globalThis.fetch = originalFetch; }
});

test('account storage round-trips watched movies and liked, disliked, or cleared ratings', async () => {
  let savedProfile;
  globalThis.fetch=async (url,options={})=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'verified-user'});
    if(options.method==='POST')savedProfile=JSON.parse(options.body).profile;
    return Response.json(savedProfile?[{profile:savedProfile}]:[]);
  };
  const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public'};
  const save=async profile=>{
    const res=await worker.fetch(new Request('https://local/api/profile',{method:'PUT',headers:{authorization:'Bearer test.token','content-type':'application/json'},body:JSON.stringify({profile})}),env);
    assert.equal(res.status,200);return (await res.json()).profile;
  };
  try {
    const movie={id:42,title:'A movie',release_date:'2026-01-01',genre_ids:[18]};
    assert.deepEqual((await save({watched:[movie],ratings:{42:1}})).ratings,{42:1});
    assert.deepEqual((await save({watched:[movie],ratings:{42:-1}})).ratings,{42:-1});
    let profile=await save({watched:[movie],ratings:{}});
    assert.equal(profile.watched[0].title,'A movie');assert.deepEqual(profile.ratings,{});
    profile=await save({watched:[],ratings:{}});
    assert.deepEqual(profile.watched,[]);assert.deepEqual(profile.ratings,{});
    const loaded=await worker.fetch(new Request('https://local/api/profile',{headers:{authorization:'Bearer test.token'}}),env);
    assert.deepEqual((await loaded.json()).profile.watched,[]);
  } finally { globalThis.fetch=originalFetch; }
});

test('account storage preserves valid star ratings and earlier thumbs separately', async () => {
  let stored;
  globalThis.fetch=async (url,options={})=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'verified-user'});
    if(options.method==='POST')stored=JSON.parse(options.body).profile;
    return Response.json(stored?[{profile:stored}]:[]);
  };
  try {
    const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public'};
    const input={watched:[{id:1,title:'Seen'}],ratings:{1:1,2:-1},starRatings:{3:5,4:1,5:3,6:6,7:0,8:2.5,wrong:4}};
    const res=await worker.fetch(new Request('https://local/api/profile',{method:'PUT',headers:{authorization:'Bearer test.token','content-type':'application/json'},body:JSON.stringify({profile:input})}),env);
    const saved=(await res.json()).profile;
    assert.equal(res.status,200);
    assert.deepEqual(saved.ratings,{1:1,2:-1});
    assert.deepEqual(saved.starRatings,{3:5,4:1,5:3});
    assert.deepEqual(sanitizedProfile(input).starRatings,{3:5,4:1,5:3});
    const read=await worker.fetch(new Request('https://local/api/profile',{headers:{authorization:'Bearer test.token'}}),env);
    assert.deepEqual((await read.json()).profile.starRatings,{3:5,4:1,5:3});
  } finally { globalThis.fetch=originalFetch; }
});

test('saved recommendations survive account storage and can be removed independently', async () => {
  let stored;
  globalThis.fetch=async (url,options={})=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'verified-user'});
    if(options.method==='POST')stored=JSON.parse(options.body).profile;
    return Response.json(stored?[{profile:stored}]:[]);
  };
  const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public'};
  const save=async profile=>{
    const res=await worker.fetch(new Request('https://local/api/profile',{method:'PUT',headers:{authorization:'Bearer test.token','content-type':'application/json'},body:JSON.stringify({profile})}),env);
    assert.equal(res.status,200);return (await res.json()).profile;
  };
  try {
    const watched={id:1,title:'Already watched',genre_ids:[18]};
    const later={id:2,title:'Watch later',release_date:'2026-10-01',genre_ids:[35]};
    let profile=await save({watched:[watched],saved:[later,{id:-1,title:'Invalid'}],ratings:{1:1}});
    assert.deepEqual(profile.saved.map(movie=>movie.title),['Watch later']);
    const res=await worker.fetch(new Request('https://local/api/profile',{headers:{authorization:'Bearer test.token'}}),env);
    assert.equal((await res.json()).profile.saved[0].id,2);
    profile=await save({...profile,saved:[]});
    assert.deepEqual(profile.saved,[]);assert.equal(profile.watched[0].id,1);assert.equal(profile.ratings['1'],1);
    assert.equal(sanitizedProfile({saved:[later]}).saved[0].title,'Watch later');
  } finally { globalThis.fetch=originalFetch; }
});

test('disliked watched movies do not boost related movies or their genres', async () => {
  const paths=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);paths.push(u.pathname);
    if(u.pathname.endsWith('/discover/movie'))return Response.json({results:[
      {id:3,title:'Disliked genre',genre_ids:[27]}, {id:4,title:'Liked genre',genre_ids:[18]}
    ]});
    if(u.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    if(u.pathname.endsWith('/watch/providers'))return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const res=await worker.fetch(request({watched:[{id:1,genre_ids:[18]},{id:2,genre_ids:[27]}],ratings:{1:1,2:-1},types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data=await res.json();
    assert.equal(res.status,200);
    assert.ok(paths.includes('/3/movie/1/recommendations'));
    assert.ok(!paths.includes('/3/movie/2/recommendations'));
    assert.deepEqual(data.results.map(movie=>movie.id),[4,3]);
  } finally { globalThis.fetch=originalFetch; }
});

test('four- and five-star films guide recommendations while lower ratings do not', async () => {
  const paths=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);paths.push(u.pathname);
    if(u.pathname.endsWith('/discover/movie'))return Response.json({results:[
      {id:10,title:'Related to five',genre_ids:[18]}, {id:11,title:'Related to four',genre_ids:[28]}
    ]});
    if(u.pathname.endsWith('/movie/1/recommendations'))return Response.json({results:[{id:10,title:'Related to five',genre_ids:[18]}]});
    if(u.pathname.endsWith('/movie/4/recommendations'))return Response.json({results:[{id:11,title:'Related to four',genre_ids:[28]}]});
    if(u.pathname.endsWith('/recommendations'))return Response.json({results:[]});
    if(u.pathname.endsWith('/watch/providers'))return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try {
    const watched=[{id:1,genre_ids:[18]},{id:2,genre_ids:[27]},{id:3,genre_ids:[35]},{id:4,genre_ids:[28]},{id:5,genre_ids:[80]},{id:6,genre_ids:[99]}];
    const res=await worker.fetch(request({watched,starRatings:{1:5,2:1,3:3,4:4},ratings:{1:-1,2:1,5:-1,6:1},types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data=await res.json();
    assert.equal(res.status,200);
    for(const id of [1,4,6])assert.ok(paths.includes(`/3/movie/${id}/recommendations`));
    for(const id of [2,3,5])assert.ok(!paths.includes(`/3/movie/${id}/recommendations`));
    assert.deepEqual(data.results.map(movie=>movie.id),[10,11]);
  } finally { globalThis.fetch=originalFetch; }
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


test('selected decades search each era and exclude unrelated years from recommendations', async () => {
  const discovers=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/discover/movie')){
      discovers.push(u);
      return Response.json({results:[{id:2,title:'Eighties',release_date:'1985-03-01',genre_ids:[18]},{id:3,title:'Nineties',release_date:'1997-02-01',genre_ids:[18]}]});
    }
    if(u.pathname.endsWith('/recommendations'))return Response.json({results:[{id:4,title:'Other era',release_date:'2010-01-01',genre_ids:[18]}]});
    if(u.pathname.endsWith('/watch/providers'))return Response.json({results:{US:{flatrate:[{provider_id:9,provider_name:'Example'}]}}});
    throw new Error('Unexpected request '+u.pathname);
  };
  try{
    const res=await worker.fetch(request({watched:[{id:1}],genres:[18],decades:[1980,1990],types:['flatrate']}),{TMDB_API_KEY:'fake'});
    const data=await res.json();
    assert.deepEqual(new Set(data.results.map(movie=>movie.id)),new Set([2,3]));
    assert.deepEqual(new Set(discovers.map(url=>url.searchParams.get('primary_release_date.gte'))),new Set(['1980-01-01','1990-01-01']));
    assert.deepEqual(new Set(discovers.map(url=>url.searchParams.get('primary_release_date.lte'))),new Set(['1989-12-31','1999-12-31']));
  }finally{globalThis.fetch=originalFetch}
});

test('account storage retains saved movie synopses and valid decades', () => {
  const p=sanitizedProfile({decades:[1980,1990,1980,1985,3000],saved:[{id:10,title:'A film',poster_path:'/poster.jpg',overview:'A story worth watching.'}]});
  assert.deepEqual(p.decades,[1980,1990]);
  assert.equal(p.saved[0].overview,'A story worth watching.');
  assert.equal(p.saved[0].poster_path,'/poster.jpg');
});

test('featured posters only return films with artwork and omit adult titles',async()=>{
  let requested;
  globalThis.fetch=async url=>{
    requested=new URL(url);
    return Response.json({results:[{id:1,title:'Poster',poster_path:'/poster.jpg',adult:false},{id:2,title:'Missing',poster_path:null},{id:3,title:'Adult',poster_path:'/adult.jpg',adult:true}]});
  };
  try{
    const res=await worker.fetch(new Request('https://local/api/featured'),{TMDB_API_KEY:'fake'});
    assert.deepEqual(await res.json(),{results:[{id:1,title:'Poster',poster_path:'/poster.jpg'}]});
    assert.equal(requested.pathname,'/3/movie/popular');
    assert.ok(Number(requested.searchParams.get('page'))>=1&&Number(requested.searchParams.get('page'))<=10);
  }finally{globalThis.fetch=originalFetch}
});

test('sharing composes only the selected movie lists and preserves titles and years',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const snippets=source.slice(source.indexOf('function movieListText('),source.indexOf('function updateShareMessage('));
  const ctx={};runInNewContext(snippets+'\nthis.compose=composeShareMessage;',ctx);
  const watched=[{title:'A watched film',release_date:'1998-03-12'}],recommended=[{title:'A new pick',release_date:'2024-01-01'}];
  const both=ctx.compose(watched,recommended,true,true,'https://example.test');
  assert.match(both,/A watched film \(1998\)/);assert.match(both,/A new pick \(2024\)/);assert.ok(both.indexOf('A new pick')<both.indexOf('A watched film'));assert.match(both,/https:\/\/example.test\//);
  const onlyRecommendations=ctx.compose(watched,recommended,false,true,'https://example.test');
  assert.doesNotMatch(onlyRecommendations,/A watched film/);assert.match(onlyRecommendations,/A new pick/);
  assert.equal(ctx.compose([],[],true,true,'https://example.test'),'');
});

test('featured carousel gathers distinct pages and tolerates one failed catalog request',async()=>{
  const pages=[];
  globalThis.fetch=async url=>{
    const page=Number(new URL(url).searchParams.get('page'));pages.push(page);
    if(pages.length===1)return new Response(null,{status:502});
    return Response.json({results:Array.from({length:20},(_,i)=>({id:page*100+i+1,title:'Film',poster_path:'/poster.jpg'}))});
  };
  try{
    const res=await worker.fetch(new Request('https://local/api/featured'),{TMDB_API_KEY:'fake'});
    const data=await res.json();
    assert.equal(res.status,200);assert.equal(pages.length,4);assert.equal(new Set(pages).size,4);assert.equal(data.results.length,60);
  }finally{globalThis.fetch=originalFetch}
});

test('poster autoplay advances, wraps, and stays still when paused or offscreen',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const snippet=source.slice(source.indexOf('let posterAutoPlaying='),source.indexOf('function movieListText('));
  const moves=[],box={scrollWidth:500,clientWidth:200,scrollLeft:0,getBoundingClientRect:()=>({top:10,bottom:200}),querySelector:()=>({getBoundingClientRect:()=>({width:80})}),scrollBy:value=>moves.push(['by',value.left]),scrollTo:value=>moves.push(['to',value.left])};
  const context={window:{innerHeight:600,matchMedia:()=>({matches:false})},document:{hidden:false},$:()=>box};
  runInNewContext(snippet+'\nthis.advance=advancePosterCarousel;this.pause=()=>{posterAutoPlaying=false};this.play=()=>{posterAutoPlaying=true};',context);
  context.advance();assert.deepEqual(moves,[['by',90]]);
  box.scrollLeft=300;context.advance();assert.deepEqual(moves[1],['to',0]);
  context.pause();context.advance();assert.equal(moves.length,2);
  context.play();context.document.hidden=true;context.advance();assert.equal(moves.length,2);
});

test('sharing passes the full edited message to the device share menu',async()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function shareMovies()'),source.indexOf('async function copyShareMessage()'));
  const message='Movies recommended for me:\n• Pick One\n\nMovies I’ve watched:\n• Seen One';let shared;
  const status={textContent:''},ctx={navigator:{share:async data=>{shared=data}},$:id=>id==='shareText'?{value:message}:status};
  runInNewContext(code+'\nthis.send=shareMovies;',ctx);await ctx.send();
  assert.equal(shared.text,message);assert.match(status.textContent,/messaging app/);
});

test('recommendations restore only for the same browser profile',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(0,source.indexOf('if(!Array.isArray(profile.saved))'));
  function load(owner,storedOwner){
    const ctx={document:{getElementById:()=>({})},localStorage:{getItem:key=>key==='nextthree.profileOwner.v1'?owner:null},sessionStorage:{getItem:()=>JSON.stringify({owner:storedOwner,results:[{id:7,title:'A recommendation'}]})}};
    runInNewContext(code+'\nthis.restored=current;',ctx);return ctx.restored;
  }
  assert.equal(load('account-1','account-1').length,1);
  assert.equal(load('account-2','account-1').length,0);
});
