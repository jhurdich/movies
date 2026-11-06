'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const BASE = 'https://api.themoviedb.org/3';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || '';
const publicDir = path.join(__dirname, 'public');
const send = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); };
const fail = (message,status) => Object.assign(new Error(message),{status});
const ids = (a) => [...new Set((Array.isArray(a)?a:[]).map(x=>Number(typeof x==='object'?x.id:x)).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,100);
const cleanGenres = a => {const result=ids(a);if(Array.isArray(a)&&a.includes('coming-of-age'))result.push('coming-of-age');return result};
async function tmdb(endpoint, params={}) {
 if(!TMDB_API_KEY&&!TMDB_READ_TOKEN) throw Object.assign(new Error('Movie data is not configured. Set a TMDB credential on the server.'),{status:503});
 const url=new URL(BASE+endpoint); for(const [k,v] of Object.entries(params)) if(v!==undefined&&v!=='') url.searchParams.set(k,String(v));
 if(TMDB_API_KEY) url.searchParams.set('api_key',TMDB_API_KEY);
 const r=await fetch(url,{headers: TMDB_READ_TOKEN?{Authorization:'Bearer '+TMDB_READ_TOKEN}: {},signal:AbortSignal.timeout(12000)});
 if(!r.ok) throw Object.assign(new Error('Movie data is temporarily unavailable.'),{status: r.status===429?429:502});
 return r.json();
}
function sanitizedProfile(value) {
 const v=value&&typeof value==='object'?value:{};
 const watched=(Array.isArray(v.watched)?v.watched:[]).slice(0,500).filter(x=>x&&Number.isSafeInteger(Number(x.id))&&Number(x.id)>0).map(x=>({id:Number(x.id),title:String(x.title||'').slice(0,200),release_date:String(x.release_date||'').slice(0,20),poster_path:typeof x.poster_path==='string'?x.poster_path.slice(0,200):null,genre_ids:ids(x.genre_ids)}));
 const ratings={};for(const [k,n] of Object.entries(v.ratings||{}).slice(0,1000)) if(/^\d{1,10}$/.test(k)&&(n===1||n===-1)) ratings[k]=n;
 const types=(Array.isArray(v.types)?v.types:[]).filter(x=>['flatrate','free','ads','rent','buy','theater'].includes(x));
 return {watched,genres:cleanGenres(v.genres),providers:ids(v.providers),ratings,types,zipCode:typeof v.zipCode==='string'&&/^\d{5}$/.test(v.zipCode)?v.zipCode:''};
}
async function profileRequest(req,method,profile) {
 if(!SUPABASE_URL||!SUPABASE_ANON_KEY) throw Object.assign(new Error('Account storage is not configured.'),{status:503});
 const auth=req.headers.authorization||'';if(!/^Bearer [\w.-]+$/.test(auth))throw Object.assign(new Error('Please sign in first.'),{status:401});
 const headers={apikey:SUPABASE_ANON_KEY,Authorization:auth};
 const me=await fetch(SUPABASE_URL+'/auth/v1/user',{headers,signal:AbortSignal.timeout(10000)});
 if(!me.ok)throw Object.assign(new Error('Your session has expired. Please sign in again.'),{status:401});
 const user=await me.json(); if(!user.id)throw Object.assign(new Error('Invalid session.'),{status:401});
 let url=SUPABASE_URL+'/rest/v1/movie_profiles?user_id=eq.'+encodeURIComponent(user.id)+'&select=profile';
 const opts={headers,signal:AbortSignal.timeout(10000)};
 if(method==='PUT'){url=SUPABASE_URL+'/rest/v1/movie_profiles?on_conflict=user_id';opts.method='POST';opts.headers={...headers,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'};opts.body=JSON.stringify({user_id:user.id,profile:sanitizedProfile(profile)});}
 const r=await fetch(url,opts);if(!r.ok)throw Object.assign(new Error('Could not save or load your profile. Check database setup.'),{status:502});
 const rows=await r.json();return rows.length ? sanitizedProfile(rows[0]?.profile) : null;
}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>100000)throw Object.assign(new Error('Request too large.'),{status:413});}try{return JSON.parse(data||'{}')}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400})}}
async function recommend(value) {
  const p = sanitizedProfile(value);
  const watched = ids(p.watched);
  const liked = Object.keys(p.ratings).filter(id => p.ratings[id] === 1).map(Number);
  const excluded = new Set([...watched, ...Object.keys(p.ratings).map(Number)]);
  const seeds = [...new Set([...liked, ...watched])].slice(0, 8);
  const genres = p.genres.filter(Number.isSafeInteger);
  const comingOfAge = p.genres.includes('coming-of-age');
  const wantsTheaters = p.types.includes('theater');
  const streamingTypes = p.types.filter(type => type !== 'theater');
  const wantsStreaming = streamingTypes.length > 0 || !wantsTheaters;
  const base = {language:'en-US', include_adult:'false', region:'US', sort_by:'popularity.desc', page:1};
  const branches = [];
  if (genres.length) branches.push({kind:'genres', params:{with_genres:genres.join('|')}});
  if (comingOfAge) {
    const found = await tmdb('/search/keyword', {query:'coming of age'});
    const keyword = (found.results || []).find(item =>
      String(item.name || '').trim().toLowerCase() === 'coming of age' &&
      Number.isSafeInteger(item.id) && item.id > 0);
    if (!keyword) throw fail('The coming-of-age filter is temporarily unavailable.', 503);
    branches.push({kind:'theme', params:{with_keywords:keyword.id}});
  }
  if (!branches.length) branches.push({kind:'all', params:{}});

  const streamParams = {...base, watch_region:'US'};
  if (p.providers.length) streamParams.with_watch_providers = p.providers.join('|');
  if (streamingTypes.length) streamParams.with_watch_monetization_types = streamingTypes.join('|');
  const [streams, nowPlaying, ...related] = await Promise.all([
    wantsStreaming ? Promise.all(branches.map(branch => tmdb('/discover/movie', {...streamParams,...branch.params}))) : Promise.resolve([]),
    wantsTheaters ? tmdb('/movie/now_playing', {language:'en-US', region:'US'}).catch(() => null) : Promise.resolve(null),
    ...seeds.map(id => tmdb('/movie/' + id + '/recommendations', {language:'en-US',page:1}).catch(() => ({results:[]})))
  ]);
  const streamResults = streams.flatMap(result => result.results || []);
  const verifiedThemeIds = new Set();
  for (let i = 0; i < streams.length; i++) if (branches[i].kind === 'theme') {
    for (const movie of streams[i].results || []) verifiedThemeIds.add(movie.id);
  }

  let theaterResults = [];
  let theaterUnavailable = false;
  let theaterBranchesSucceeded = 0;
  if (wantsTheaters) {
    const min = nowPlaying?.dates?.minimum;
    const max = nowPlaying?.dates?.maximum;
    if (/^\d{4}-\d{2}-\d{2}$/.test(min || '') && /^\d{4}-\d{2}-\d{2}$/.test(max || '')) {
      const theaters = await Promise.allSettled(branches.map(branch => tmdb('/discover/movie', {
        ...base, ...branch.params, include_video:'false', with_release_type:'2|3',
        'release_date.gte':min, 'release_date.lte':max
      })));
      for (let i = 0; i < theaters.length; i++) {
        if (theaters[i].status === 'rejected') { theaterUnavailable = true; continue; }
        theaterBranchesSucceeded++;
        const movies = theaters[i].value.results || [];
        theaterResults.push(...movies);
        if (branches[i].kind === 'theme') for (const movie of movies) verifiedThemeIds.add(movie.id);
      }
    } else theaterUnavailable = true;
  }
  if (theaterUnavailable && !theaterBranchesSucceeded && !wantsStreaming) throw fail('Theater listings are temporarily unavailable.', 503);

  const theaterIds = new Set(theaterResults.map(movie => movie.id));
  const matchesGenres = movie => (!genres.length && !comingOfAge) ||
    (genres.length > 0 && (movie.genre_ids || []).some(genre => genres.includes(genre))) ||
    (comingOfAge && verifiedThemeIds.has(movie.id));
  const map = new Map();
  function add(movie, score, isRelated = false) {
    if (!movie.id || excluded.has(movie.id) || movie.adult || !matchesGenres(movie)) return;
    const current = map.get(movie.id) || {movie, score:0, related:false};
    current.score += score;
    current.related ||= isRelated;
    map.set(movie.id, current);
  }
  for (const movie of streamResults) add(movie, 1);
  for (const movie of theaterResults) add(movie, 1);
  for (let i = 0; i < related.length; i++) for (const movie of related[i].results || []) {
    if (!wantsStreaming && !theaterIds.has(movie.id)) continue;
    add(movie, liked.includes(seeds[i]) ? 4 : 2, true);
  }
  const preferences = {};
  for (const movie of p.watched) for (const genre of movie.genre_ids || []) preferences[genre] = (preferences[genre] || 0) + 1;
  const candidates = [...map.values()]
    .map(item => ({...item, score:item.score + (item.movie.genre_ids || []).reduce((sum, genre) => sum + (preferences[genre] || 0) * .15, 0) + Math.min(item.movie.vote_count || 0, 1000) / 10000}))
    .sort((a,b) => b.score - a.score).slice(0,32);

  const out = [];
  let incomplete = false;
  for (let i = 0; i < candidates.length && out.length < 10; i += 6) {
    const batch = await Promise.all(candidates.slice(i, i + 6).map(async ({movie, related}) => {
      const inTheaters = wantsTheaters && theaterIds.has(movie.id);
      let offers = [];
      let watchUrl = null;
      let available = false;
      if (wantsStreaming) {
        try {
          const watch = await tmdb('/movie/' + movie.id + '/watch/providers');
          const us = watch.results?.US || {};
          for (const type of ['flatrate','free','ads','rent','buy']) for (const provider of us[type] || []) {
            if ((!streamingTypes.length || streamingTypes.includes(type)) && (!p.providers.length || p.providers.includes(provider.provider_id))) offers.push({...provider,type});
          }
          available = offers.length > 0 || (!streamingTypes.length && !p.providers.length);
          if (available) watchUrl = us.link || null;
        } catch (_) { incomplete = true; }
      }
      if (!inTheaters && !available) return null;
      return {...movie, providers:offers, watch_url:watchUrl, in_theaters:inTheaters,
        reason:related ? 'Related to movies you selected or liked.' : 'Matches your selected preferences.'};
    }));
    out.push(...batch.filter(Boolean).slice(0, 10 - out.length));
  }
  const warnings = [];
  if (theaterUnavailable) warnings.push('Some theater listings could not be checked. Try again shortly.');
  if (incomplete) warnings.push('Some streaming availability could not be checked. Try again shortly.');
  if (out.length < 10) warnings.push('Fewer than 10 matches were found. Try selecting more options or relaxing the genres.');
  return {results:out, warning:warnings.join(' ') || null};
}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');const p=u.pathname;
 if(req.method==='GET'&&p==='/api/config')return send(res,200,{tmdbConfigured:!!(TMDB_API_KEY||TMDB_READ_TOKEN),supabaseUrl:SUPABASE_URL,supabaseAnonKey:SUPABASE_ANON_KEY,authConfigured:!!(SUPABASE_URL&&SUPABASE_ANON_KEY)});
 if(req.method==='GET'&&p==='/api/search'){let q=(u.searchParams.get('q')||'').trim();if(q.length<2)return send(res,200,{results:[]});const v=await tmdb('/search/movie',{query:q.slice(0,100),language:'en-US',include_adult:'false'});return send(res,200,{results:v.results||[]});}
 if(req.method==='GET'&&p==='/api/genres'){return send(res,200,await tmdb('/genre/movie/list',{language:'en-US'}));}
 if(req.method==='GET'&&p==='/api/providers'){const v=await tmdb('/watch/providers/movie',{language:'en-US',watch_region:'US'});return send(res,200,{results:v.results||[]});}
 if(req.method==='GET'&&/^\/api\/movies\/\d+$/.test(p)){const v=await tmdb('/movie/'+p.split('/').pop(),{language:'en-US'});return send(res,200,{movie:v});}
 if(req.method==='POST'&&p==='/api/recommendations'){return send(res,200,await recommend(await body(req)));}
 if(p==='/api/profile'&&req.method==='GET')return send(res,200,{profile:await profileRequest(req,'GET')});
 if(p==='/api/profile'&&req.method==='PUT'){const b=await body(req);return send(res,200,{profile:await profileRequest(req,'PUT',b.profile)});}
 if(p.startsWith('/api/'))return send(res,404,{error:'Not found.'});
 if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'});
 const file=p==='/'?'index.html':p.slice(1);const full=path.resolve(publicDir,file);if(!full.startsWith(publicDir+path.sep))return send(res,403,{error:'Forbidden.'});
 const ext=path.extname(full);const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[ext]||'application/octet-stream';
 fs.readFile(full,(err,bytes)=>{if(err)return send(res,404,{error:'Not found.'});res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff'});res.end(bytes)});
 }catch(err){console.error(err.message);send(res,err.status||500,{error:err.status?err.message:'Unexpected server error.'})}});
if(require.main===module)server.listen(Number(process.env.PORT)||3000,()=>console.log('Listening on http://localhost:'+(process.env.PORT||3000)));
module.exports={server,sanitizedProfile,recommend};
