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
const ids = (a) => [...new Set((Array.isArray(a)?a:[]).map(x=>Number(typeof x==='object'?x.id:x)).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,100);
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
 const types=(Array.isArray(v.types)?v.types:[]).filter(x=>['flatrate','free','ads','rent','buy'].includes(x));
 return {watched,genres:ids(v.genres),providers:ids(v.providers),ratings,types};
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
async function recommend(profile) {
 const p=sanitizedProfile(profile), watched=ids(p.watched), liked=Object.keys(p.ratings).filter(k=>p.ratings[k]===1).map(Number), excluded=new Set([...watched,...Object.keys(p.ratings).map(Number)]);
 const seeds=[...new Set([...liked,...watched])].slice(0,8);
 const params={language:'en-US',include_adult:'false',region:'US',watch_region:'US',sort_by:'popularity.desc',page:1};
 if(p.genres.length)params.with_genres=p.genres.join('|');if(p.providers.length)params.with_watch_providers=p.providers.join('|');if(p.types.length)params.with_watch_monetization_types=p.types.join('|');
 const calls=[tmdb('/discover/movie',params), ...seeds.map(id=>tmdb('/movie/'+id+'/recommendations',{language:'en-US',page:1}).catch(()=>({results:[]})))];
 const responses=await Promise.all(calls); const map=new Map();
 for(let i=0;i<responses.length;i++)for(const m of responses[i].results||[]){if(!m.id||excluded.has(m.id)||m.adult)continue;let o=map.get(m.id)||{movie:m,score:0};o.score+=i===0?1:(liked.includes(seeds[i-1])?4:2);map.set(m.id,o)}
 const preferences={};for(const m of p.watched)for(const g of m.genre_ids||[])preferences[g]=(preferences[g]||0)+1;
 const candidates=[...map.values()].filter(o=>!p.genres.length||o.movie.genre_ids?.some(g=>p.genres.includes(g))).map(o=>({...o,score:o.score+(o.movie.genre_ids||[]).reduce((s,g)=>s+(preferences[g]||0)*.15,0)+(Math.min(o.movie.vote_count||0,1000)/10000)})).sort((a,b)=>b.score-a.score).slice(0,32);
 const out=[];let incomplete=false;
 for(let i=0;i<candidates.length&&out.length<3;i+=8){const batch=await Promise.all(candidates.slice(i,i+8).map(async ({movie,score})=>{try {const w=await tmdb('/movie/'+movie.id+'/watch/providers');const us=w.results?.US||{};let providers=[];for(const type of ['flatrate','free','ads','rent','buy'])for(const provider of us[type]||[])if((!p.types.length||p.types.includes(type))&&(!p.providers.length||p.providers.includes(provider.provider_id))) providers.push({...provider,type});if((p.providers.length||p.types.length)&&!providers.length)return null;return {...movie,providers,watch_url:us.link||null,reason:score>2?'Related to movies you selected or liked.':'Matches your selected preferences.'};}catch{incomplete=true;return null}}));out.push(...batch.filter(Boolean).slice(0,3-out.length));}
 return {results:out,warning:incomplete?'Some availability could not be checked. Try again shortly.':out.length<3?'Fewer than three matches were found. Try selecting more services or relaxing the genre.':null};
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
 const ext=path.extname(full);const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[ext]||'application/octet-stream';
 fs.readFile(full,(err,bytes)=>{if(err)return send(res,404,{error:'Not found.'});res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff'});res.end(bytes)});
 }catch(err){console.error(err.message);send(res,err.status||500,{error:err.status?err.message:'Unexpected server error.'})}});
if(require.main===module)server.listen(Number(process.env.PORT)||3000,()=>console.log('Listening on http://localhost:'+(process.env.PORT||3000)));
module.exports={server,sanitizedProfile,recommend};
