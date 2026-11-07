// Deploy as a Cloudflare Worker with static assets bound as ASSETS.
export default {
 async fetch(request, env) {
  const TMDB_API_KEY=env.TMDB_API_KEY||'', TMDB_READ_TOKEN=env.TMDB_READ_TOKEN||'';
  const SUPABASE_URL=(env.SUPABASE_URL||'').replace(/\/$/,''), SUPABASE_ANON_KEY=env.SUPABASE_ANON_KEY||'';
  const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  const fail=(message,status)=>Object.assign(new Error(message),{status});
  const ids=a=>[...new Set((Array.isArray(a)?a:[]).map(x=>Number(typeof x==='object'?x.id:x)).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,100);
  const movies=a=>(Array.isArray(a)?a:[]).slice(0,500).filter(x=>x&&Number.isSafeInteger(Number(x.id))&&Number(x.id)>0).map(x=>({id:Number(x.id),title:String(x.title||'').slice(0,200),release_date:String(x.release_date||'').slice(0,20),poster_path:typeof x.poster_path==='string'?x.poster_path.slice(0,200):null,overview:typeof x.overview==='string'?x.overview.slice(0,3000):'',genre_ids:ids(x.genre_ids)}));
  const cleanStars=a=>{const result={};for(const [id,n] of Object.entries(a&&typeof a==='object'?a:{}).slice(0,1000))if(/^\d{1,10}$/.test(id)&&Number.isInteger(n)&&n>=1&&n<=5)result[id]=n;return result};
  const cleanGenres=a=>{const result=ids(a);if(Array.isArray(a)&&a.includes('coming-of-age'))result.push('coming-of-age');return result};
  const clean=v=>{v=v&&typeof v==='object'?v:{};let watched=movies(v.watched),saved=movies(v.saved);let ratings={};for(let [k,n] of Object.entries(v.ratings||{}).slice(0,1000))if(/^\d{1,10}$/.test(k)&&(n===1||n===-1))ratings[k]=n;return {watched,saved,genres:cleanGenres(v.genres),decades:ids(v.decades).filter(n=>n>=1950&&n<=2020&&n%10===0),providers:ids(v.providers),ratings,starRatings:cleanStars(v.starRatings),zipCode:typeof v.zipCode==='string'&&/^\d{5}$/.test(v.zipCode)?v.zipCode:'',types:(Array.isArray(v.types)?v.types:[]).filter(x=>['flatrate','free','ads','rent','buy','theater'].includes(x))}};
  async function tmdb(path,params={}){if(!TMDB_API_KEY&&!TMDB_READ_TOKEN)throw fail('Movie data is not configured. Set a TMDB credential.',503);let u=new URL('https://api.themoviedb.org/3'+path);for(let [k,v] of Object.entries(params))if(v!==undefined&&v!=='')u.searchParams.set(k,String(v));if(TMDB_API_KEY)u.searchParams.set('api_key',TMDB_API_KEY);let r=await fetch(u,{headers:TMDB_READ_TOKEN?{Authorization:'Bearer '+TMDB_READ_TOKEN}:{},signal:AbortSignal.timeout(12000)});if(!r.ok)throw fail('Movie data is temporarily unavailable.',r.status===429?429:502);return r.json()}
  async function profile(method,value){if(!SUPABASE_URL||!SUPABASE_ANON_KEY)throw fail('Account storage is not configured.',503);let auth=request.headers.get('Authorization')||'';if(!/^Bearer [\w.-]+$/.test(auth))throw fail('Please sign in first.',401);let headers={apikey:SUPABASE_ANON_KEY,Authorization:auth};let me=await fetch(SUPABASE_URL+'/auth/v1/user',{headers});if(!me.ok)throw fail('Your session has expired. Please sign in again.',401);let user=await me.json();if(!user.id)throw fail('Invalid session.',401);let url=SUPABASE_URL+'/rest/v1/movie_profiles?user_id=eq.'+encodeURIComponent(user.id)+'&select=profile', opts={headers};if(method==='PUT'){url=SUPABASE_URL+'/rest/v1/movie_profiles?on_conflict=user_id';opts={method:'POST',headers:{...headers,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({user_id:user.id,profile:clean(value)})}}let r=await fetch(url,opts);if(!r.ok)throw fail('Could not save or load your profile. Check database setup.',502);let rows=await r.json();return rows.length?clean(rows[0]?.profile):null}
  async function recommend(value) {
  const p = clean(value);
  const watched = ids(p.watched);
  const stars = p.starRatings;
  const notPositive = id => stars[id] ? stars[id] <= 3 : p.ratings[id] === -1;
  const liked = [...new Set([
    ...Object.keys(stars).filter(id => stars[id] >= 4).sort((a,b) => stars[b] - stars[a]).map(Number),
    ...Object.keys(p.ratings).filter(id => !stars[id] && p.ratings[id] === 1).map(Number)
  ])];
  const excluded = new Set([...watched, ...Object.keys(p.ratings).map(Number), ...Object.keys(stars).map(Number)]);
  const seeds = [...new Set([...liked, ...watched.filter(id => !notPositive(id))])].slice(0, 8);
  const genres = p.genres.filter(Number.isSafeInteger);
  const comingOfAge = p.genres.includes('coming-of-age');
  const decades = p.decades;
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

  const streamBranches = decades.length ? branches.flatMap(branch => decades.map(decade => ({...branch, params:{...branch.params, 'primary_release_date.gte':`${decade}-01-01`, 'primary_release_date.lte':`${decade+9}-12-31`}}))) : [...branches];
  const theaterBranches = [...branches];
  // Reserve requests for availability checks while adding targeted searches for underrepresented genres.
  const discoveryBudget = Math.max(0, 48 - seeds.length - (comingOfAge ? 1 : 0) - (wantsTheaters ? 1 : 0) - (wantsStreaming ? 16 : 0));
  let extraBudget = Math.max(0, discoveryBudget - (wantsStreaming ? streamBranches.length : 0) - (wantsTheaters ? theaterBranches.length : 0));
  if (genres.length > 1) {
    if (wantsStreaming) for (const decade of decades.length ? decades : [null]) for (const genre of genres) {
      if (!extraBudget) break;
      const params = {with_genres:String(genre)};
      if (decade !== null) {params['primary_release_date.gte']=`${decade}-01-01`;params['primary_release_date.lte']=`${decade+9}-12-31`}
      streamBranches.push({kind:'target',params});extraBudget--;
    }
    if (wantsTheaters) for (const genre of genres) {
      if (!extraBudget) break;
      theaterBranches.push({kind:'target',params:{with_genres:String(genre)}});extraBudget--;
    }
  }
  const streamParams = {...base, watch_region:'US'};
  if (p.providers.length) streamParams.with_watch_providers = p.providers.join('|');
  if (streamingTypes.length) streamParams.with_watch_monetization_types = streamingTypes.join('|');
  const [streams, nowPlaying, ...related] = await Promise.all([
    wantsStreaming ? Promise.allSettled(streamBranches.map(branch => tmdb('/discover/movie', {...streamParams,...branch.params}))) : Promise.resolve([]),
    wantsTheaters ? tmdb('/movie/now_playing', {language:'en-US', region:'US'}).catch(() => null) : Promise.resolve(null),
    ...seeds.map(id => tmdb('/movie/' + id + '/recommendations', {language:'en-US',page:1}).catch(() => ({results:[]})))
  ]);
  const discoveryIncomplete = streams.some(result => result.status === 'rejected');
  if (wantsStreaming && streams.length && streams.every(result => result.status === 'rejected') && !wantsTheaters) throw fail('Movie searches are temporarily unavailable.',503);
  const streamData = streams.map(result => result.status === 'fulfilled' ? result.value : {results:[]});
  const streamResults = streamData.flatMap(result => result.results || []);
  const verifiedThemeIds = new Set();
  for (let i = 0; i < streams.length; i++) if (streamBranches[i].kind === 'theme') {
    for (const movie of streamData[i].results || []) verifiedThemeIds.add(movie.id);
  }

  let theaterResults = [];
  let theaterUnavailable = false;
  let theaterBranchesSucceeded = 0;
  if (wantsTheaters) {
    const min = nowPlaying?.dates?.minimum;
    const max = nowPlaying?.dates?.maximum;
    if (/^\d{4}-\d{2}-\d{2}$/.test(min || '') && /^\d{4}-\d{2}-\d{2}$/.test(max || '')) {
      const theaters = await Promise.allSettled(theaterBranches.map(branch => tmdb('/discover/movie', {
        ...base, ...branch.params, include_video:'false', with_release_type:'2|3',
        'release_date.gte':min, 'release_date.lte':max
      })));
      for (let i = 0; i < theaters.length; i++) {
        if (theaters[i].status === 'rejected') { theaterUnavailable = true; continue; }
        theaterBranchesSucceeded++;
        const movies = theaters[i].value.results || [];
        theaterResults.push(...movies);
        if (theaterBranches[i].kind === 'theme') for (const movie of movies) verifiedThemeIds.add(movie.id);
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
    const year = Number(String(movie.release_date || '').slice(0,4));
    if (!movie.id || excluded.has(movie.id) || movie.adult || !matchesGenres(movie) || (decades.length && !decades.some(decade => year >= decade && year <= decade + 9))) return;
    const current = map.get(movie.id) || {movie, score:0, related:false};
    current.score += score;
    current.related ||= isRelated;
    map.set(movie.id, current);
  }
  for (const movie of streamResults) add(movie, 1);
  for (const movie of theaterResults) add(movie, 1);
  for (let i = 0; i < related.length; i++) for (const movie of related[i].results || []) {
    if (!wantsStreaming && !theaterIds.has(movie.id)) continue;
    add(movie, stars[seeds[i]] === 5 ? 5 : liked.includes(seeds[i]) ? 4 : 2, true);
  }
  const preferences = {};
  for (const movie of p.watched) if (!notPositive(movie.id)) for (const genre of movie.genre_ids || []) preferences[genre] = (preferences[genre] || 0) + (stars[movie.id] === 5 ? 1.25 : 1);
  // Check a mix of genres before spending the remaining request budget on availability.
  const candidateLimit = Math.min(32, Math.max(0, 48 - (wantsStreaming ? streamBranches.length : 0) - (wantsTheaters ? theaterBranches.length + 1 : 0) - seeds.length - (comingOfAge ? 1 : 0)));
  const selectedGenres = [...genres.map(String), ...(comingOfAge ? ['coming-of-age'] : [])];
  const covers = movie => [...(movie.genre_ids || []).filter(id => genres.includes(id)).map(String), ...(comingOfAge && verifiedThemeIds.has(movie.id) ? ['coming-of-age'] : [])];
  const ranked = [...map.values()]
    .map(item => ({...item, score:item.score + (item.movie.genre_ids || []).reduce((sum, genre) => sum + (preferences[genre] || 0) * .15, 0) + Math.min(item.movie.vote_count || 0, 1000) / 10000}))
    .sort((a,b) => b.score - a.score);
  const ordered = [], seen = new Set();
  if (selectedGenres.length > 1) {
    const groups = selectedGenres.map(genre => ranked.filter(item => covers(item.movie).includes(genre)));
    for (let index=0;index<ranked.length;index++) for (const group of groups) {
      const item=group[index];if(item&&!seen.has(item.movie.id)){ordered.push(item);seen.add(item.movie.id)}
    }
  }
  for (const item of ranked) if(!seen.has(item.movie.id)){ordered.push(item);seen.add(item.movie.id)}
  const candidates=ordered.slice(0,candidateLimit), scores=new Map(ranked.map(item=>[item.movie.id,item.score]));
  const available = [], availableGenres = new Set();
  let incomplete = false;
  for (let i = 0; i < candidates.length && (available.length < 10 || selectedGenres.some(genre=>!availableGenres.has(genre))); i += 6) {
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
    for (const movie of batch.filter(Boolean)) {available.push(movie);for(const genre of covers(movie))availableGenres.add(genre)}
  }
  available.sort((a,b)=>(scores.get(b.id)||0)-(scores.get(a.id)||0));
  const out=[],remaining=[...available],uncovered=new Set(selectedGenres);
  while(uncovered.size&&remaining.length&&out.length<10){
    let best=-1,bestCount=0;
    for(let i=0;i<remaining.length;i++){const count=covers(remaining[i]).filter(genre=>uncovered.has(genre)).length;if(count>bestCount){best=i;bestCount=count}}
    if(best<0)break;
    const [movie]=remaining.splice(best,1);out.push(movie);for(const genre of covers(movie))uncovered.delete(genre);
  }
  out.push(...remaining.slice(0,10-out.length));
  const missingGenres=selectedGenres.filter(genre=>!out.some(movie=>covers(movie).includes(genre)));
  const warnings = [];
  if (discoveryIncomplete) warnings.push('Some genre searches could not be checked. Try again shortly.');
  if (missingGenres.length) warnings.push('Some selected genres could not be included. Try broadening your viewing options or selecting fewer genres.');
  if (theaterUnavailable) warnings.push('Some theater listings could not be checked. Try again shortly.');
  if (incomplete) warnings.push('Some streaming availability could not be checked. Try again shortly.');
  if (out.length < 10) warnings.push('Fewer than 10 matches were found. Try selecting more options or relaxing the genres or decades.');
  return {results:out, warning:warnings.join(' ') || null, missing_genres:missingGenres};
}
  try {let u=new URL(request.url),p=u.pathname,m=request.method;
   if(p==='/api/config'&&m==='GET')return reply(200,{tmdbConfigured:!!(TMDB_API_KEY||TMDB_READ_TOKEN),supabaseUrl:SUPABASE_URL,supabaseAnonKey:SUPABASE_ANON_KEY,authConfigured:!!(SUPABASE_URL&&SUPABASE_ANON_KEY)});
   if(p==='/api/search'&&m==='GET'){let q=(u.searchParams.get('q')||'').trim();if(q.length<2)return reply(200,{results:[]});return reply(200,{results:(await tmdb('/search/movie',{query:q.slice(0,100),language:'en-US',include_adult:'false'})).results||[]})}
   if(p==='/api/featured'&&m==='GET'){
  const pages=Array.from({length:10},(_,i)=>i+1);
  for(let i=pages.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pages[i],pages[j]]=[pages[j],pages[i]]}
  const responses=await Promise.allSettled(pages.slice(0,4).map(page=>tmdb('/movie/popular',{language:'en-US',region:'US',page})));
  if(responses.every(result=>result.status==='rejected'))throw fail('Movie posters are temporarily unavailable.',503);
  const seen=new Set(),results=[];
  for(const response of responses)if(response.status==='fulfilled')for(const movie of response.value.results||[]){
    if(movie.adult||!movie.poster_path||!Number.isSafeInteger(movie.id)||movie.id<=0||seen.has(movie.id))continue;
    seen.add(movie.id);results.push({id:movie.id,title:movie.title,poster_path:movie.poster_path});
  }
  return reply(200,{results});
 }
   if(p==='/api/genres'&&m==='GET')return reply(200,await tmdb('/genre/movie/list',{language:'en-US'}));
   if(p==='/api/providers'&&m==='GET')return reply(200,{results:(await tmdb('/watch/providers/movie',{language:'en-US',watch_region:'US'})).results||[]});
   if(/^\/api\/movies\/\d+$/.test(p)&&m==='GET')return reply(200,{movie:await tmdb('/movie/'+p.split('/').pop(),{language:'en-US'})});
   if(p==='/api/recommendations'&&m==='POST'){if(Number(request.headers.get('content-length')||0)>100000)throw fail('Request too large.',413);return reply(200,await recommend(await request.json()))}
   if(p==='/api/profile'&&m==='GET')return reply(200,{profile:await profile('GET')});
   if(p==='/api/profile'&&m==='PUT'){if(Number(request.headers.get('content-length')||0)>500000)throw fail('Request too large.',413);let v=await request.json();return reply(200,{profile:await profile('PUT',v.profile)})}
   if(p.startsWith('/api/'))return reply(404,{error:'Not found.'});
   if(env.ASSETS)return env.ASSETS.fetch(request);return reply(404,{error:'Not found.'});
  } catch(e){return reply(e.status||500,{error:e.status?e.message:'Unexpected server error.'})}
 }
};

