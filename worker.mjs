// Deploy as a Cloudflare Worker with static assets bound as ASSETS.
export default {
 async fetch(request, env) {
  const TMDB_API_KEY=env.TMDB_API_KEY||'', TMDB_READ_TOKEN=env.TMDB_READ_TOKEN||'';
  const SUPABASE_URL=(env.SUPABASE_URL||'').replace(/\/$/,''), SUPABASE_ANON_KEY=env.SUPABASE_ANON_KEY||'';
  const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  const fail=(message,status)=>Object.assign(new Error(message),{status});
  const ids=a=>[...new Set((Array.isArray(a)?a:[]).map(x=>Number(typeof x==='object'?x.id:x)).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,100);
  const cleanGenres=a=>{const result=ids(a);if(Array.isArray(a)&&a.includes('coming-of-age'))result.push('coming-of-age');return result};
  const clean=v=>{v=v&&typeof v==='object'?v:{};let watched=(Array.isArray(v.watched)?v.watched:[]).slice(0,500).filter(x=>x&&Number.isSafeInteger(Number(x.id))&&Number(x.id)>0).map(x=>({id:Number(x.id),title:String(x.title||'').slice(0,200),release_date:String(x.release_date||'').slice(0,20),poster_path:typeof x.poster_path==='string'?x.poster_path.slice(0,200):null,genre_ids:ids(x.genre_ids)}));let ratings={};for(let [k,n] of Object.entries(v.ratings||{}).slice(0,1000))if(/^\d{1,10}$/.test(k)&&(n===1||n===-1))ratings[k]=n;return {watched,genres:cleanGenres(v.genres),providers:ids(v.providers),ratings,zipCode:typeof v.zipCode==='string'&&/^\d{5}$/.test(v.zipCode)?v.zipCode:'',types:(Array.isArray(v.types)?v.types:[]).filter(x=>['flatrate','free','ads','rent','buy','theater'].includes(x))}};
  async function tmdb(path,params={}){if(!TMDB_API_KEY&&!TMDB_READ_TOKEN)throw fail('Movie data is not configured. Set a TMDB credential.',503);let u=new URL('https://api.themoviedb.org/3'+path);for(let [k,v] of Object.entries(params))if(v!==undefined&&v!=='')u.searchParams.set(k,String(v));if(TMDB_API_KEY)u.searchParams.set('api_key',TMDB_API_KEY);let r=await fetch(u,{headers:TMDB_READ_TOKEN?{Authorization:'Bearer '+TMDB_READ_TOKEN}:{},signal:AbortSignal.timeout(12000)});if(!r.ok)throw fail('Movie data is temporarily unavailable.',r.status===429?429:502);return r.json()}
  async function profile(method,value){if(!SUPABASE_URL||!SUPABASE_ANON_KEY)throw fail('Account storage is not configured.',503);let auth=request.headers.get('Authorization')||'';if(!/^Bearer [\w.-]+$/.test(auth))throw fail('Please sign in first.',401);let headers={apikey:SUPABASE_ANON_KEY,Authorization:auth};let me=await fetch(SUPABASE_URL+'/auth/v1/user',{headers});if(!me.ok)throw fail('Your session has expired. Please sign in again.',401);let user=await me.json();if(!user.id)throw fail('Invalid session.',401);let url=SUPABASE_URL+'/rest/v1/movie_profiles?user_id=eq.'+encodeURIComponent(user.id)+'&select=profile', opts={headers};if(method==='PUT'){url=SUPABASE_URL+'/rest/v1/movie_profiles?on_conflict=user_id';opts={method:'POST',headers:{...headers,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({user_id:user.id,profile:clean(value)})}}let r=await fetch(url,opts);if(!r.ok)throw fail('Could not save or load your profile. Check database setup.',502);let rows=await r.json();return rows.length?clean(rows[0]?.profile):null}
  async function recommend(value) {
  const p = clean(value);
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
  if (genres.length) base.with_genres = genres.join('|');
  if (comingOfAge) {
    const found = await tmdb('/search/keyword', {query:'coming of age'});
    const keyword = (found.results || []).find(item =>
      String(item.name || '').trim().toLowerCase() === 'coming of age' &&
      Number.isSafeInteger(item.id) && item.id > 0);
    if (!keyword) throw fail('The coming-of-age filter is temporarily unavailable.', 503);
    base.with_keywords = keyword.id;
  }
  const streamParams = {...base, watch_region:'US'};
  if (p.providers.length) streamParams.with_watch_providers = p.providers.join('|');
  if (streamingTypes.length) streamParams.with_watch_monetization_types = streamingTypes.join('|');
  const [stream, nowPlaying, ...related] = await Promise.all([
    wantsStreaming ? tmdb('/discover/movie', streamParams) : Promise.resolve({results:[]}),
    wantsTheaters ? tmdb('/movie/now_playing', {language:'en-US', region:'US'}).catch(() => null) : Promise.resolve(null),
    ...seeds.map(id => tmdb('/movie/' + id + '/recommendations', {language:'en-US',page:1}).catch(() => ({results:[]})))
  ]);

  let theaterResults = [];
  let theaterUnavailable = false;
  if (wantsTheaters) {
    const min = nowPlaying?.dates?.minimum;
    const max = nowPlaying?.dates?.maximum;
    if (/^\d{4}-\d{2}-\d{2}$/.test(min || '') && /^\d{4}-\d{2}-\d{2}$/.test(max || '')) {
      try {
        const current = await tmdb('/discover/movie', {...base, include_video:'false',
          with_release_type:'2|3', 'release_date.gte':min, 'release_date.lte':max});
        theaterResults = current.results || [];
      } catch (_) { theaterUnavailable = true; }
    } else theaterUnavailable = true;
  }
  if (theaterUnavailable && !wantsStreaming) throw fail('Theater listings are temporarily unavailable.', 503);

  const theaterIds = new Set(theaterResults.map(movie => movie.id));
  const verifiedThemeIds = new Set([...(stream.results || []), ...theaterResults].map(movie => movie.id));
  const map = new Map();
  function add(movie, score) {
    if (!movie.id || excluded.has(movie.id) || movie.adult) return;
    const current = map.get(movie.id) || {movie, score:0};
    current.score += score;
    map.set(movie.id, current);
  }
  for (const movie of stream.results || []) add(movie, 1);
  for (const movie of theaterResults) add(movie, 1);
  for (let i = 0; i < related.length; i++) for (const movie of related[i].results || []) {
    if (comingOfAge && !verifiedThemeIds.has(movie.id)) continue;
    if (!wantsStreaming && !theaterIds.has(movie.id)) continue;
    add(movie, liked.includes(seeds[i]) ? 4 : 2);
  }
  const preferences = {};
  for (const movie of p.watched) for (const genre of movie.genre_ids || []) preferences[genre] = (preferences[genre] || 0) + 1;
  const candidates = [...map.values()]
    .filter(item => !genres.length || item.movie.genre_ids?.some(genre => genres.includes(genre)))
    .map(item => ({...item, score:item.score + (item.movie.genre_ids || []).reduce((sum, genre) => sum + (preferences[genre] || 0) * .15, 0) + Math.min(item.movie.vote_count || 0, 1000) / 10000}))
    .sort((a,b) => b.score - a.score).slice(0,32);

  const out = [];
  let incomplete = false;
  for (let i = 0; i < candidates.length && out.length < 3; i += 8) {
    const batch = await Promise.all(candidates.slice(i, i + 8).map(async ({movie, score}) => {
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
        reason:score > 2 ? 'Related to movies you selected or liked.' : 'Matches your selected preferences.'};
    }));
    out.push(...batch.filter(Boolean).slice(0, 3 - out.length));
  }
  const warnings = [];
  if (theaterUnavailable) warnings.push('Theater listings could not be checked. Try again shortly.');
  if (incomplete) warnings.push('Some streaming availability could not be checked. Try again shortly.');
  if (out.length < 3) warnings.push('Fewer than three matches were found. Try selecting more options or relaxing the genre.');
  return {results:out, warning:warnings.join(' ') || null};
}
  try {let u=new URL(request.url),p=u.pathname,m=request.method;
   if(p==='/api/config'&&m==='GET')return reply(200,{tmdbConfigured:!!(TMDB_API_KEY||TMDB_READ_TOKEN),supabaseUrl:SUPABASE_URL,supabaseAnonKey:SUPABASE_ANON_KEY,authConfigured:!!(SUPABASE_URL&&SUPABASE_ANON_KEY)});
   if(p==='/api/search'&&m==='GET'){let q=(u.searchParams.get('q')||'').trim();if(q.length<2)return reply(200,{results:[]});return reply(200,{results:(await tmdb('/search/movie',{query:q.slice(0,100),language:'en-US',include_adult:'false'})).results||[]})}
   if(p==='/api/genres'&&m==='GET')return reply(200,await tmdb('/genre/movie/list',{language:'en-US'}));
   if(p==='/api/providers'&&m==='GET')return reply(200,{results:(await tmdb('/watch/providers/movie',{language:'en-US',watch_region:'US'})).results||[]});
   if(/^\/api\/movies\/\d+$/.test(p)&&m==='GET')return reply(200,{movie:await tmdb('/movie/'+p.split('/').pop(),{language:'en-US'})});
   if(p==='/api/recommendations'&&m==='POST'){if(Number(request.headers.get('content-length')||0)>100000)throw fail('Request too large.',413);return reply(200,await recommend(await request.json()))}
   if(p==='/api/profile'&&m==='GET')return reply(200,{profile:await profile('GET')});
   if(p==='/api/profile'&&m==='PUT'){if(Number(request.headers.get('content-length')||0)>100000)throw fail('Request too large.',413);let v=await request.json();return reply(200,{profile:await profile('PUT',v.profile)})}
   if(p.startsWith('/api/'))return reply(404,{error:'Not found.'});
   if(env.ASSETS)return env.ASSETS.fetch(request);return reply(404,{error:'Not found.'});
  } catch(e){return reply(e.status||500,{error:e.status?e.message:'Unexpected server error.'})}
 }
};
