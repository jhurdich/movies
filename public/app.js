'use strict';
const $ = id => document.getElementById(id);
const blank=()=>({watched:[],saved:[],genres:[],decades:[],providers:[],ratings:{},starRatings:{},types:['flatrate','free','ads'],zipCode:''});
let profile=blank(), providers=[], genres=[], current=[], currentWarning='', config={}, supabaseClient=null, session=null, searchSeq=0, suggestedSeq=0, saveTimer=null;
let saveQueue=Promise.resolve(), saveVersion=0, savedVersion=0;
let profileOwner='',loadedAccountId=null;
const STORAGE='nextthree.profile.v1', OWNER_STORAGE='nextthree.profileOwner.v1', REC_STORAGE='nextthree.recommendations.v1', IDLE_PREFIX='nextthree.idle.v1.', LOGIN_INTENT='nextthree.loginIntent.v1';
const IDLE_LIMIT=5*60*1000;
let signingOut=false,idleSignOutPromise=null;
try { const saved=JSON.parse(localStorage.getItem(STORAGE)); if(saved) profile={...blank(),...saved}; profileOwner=localStorage.getItem(OWNER_STORAGE)||''; } catch (_) {}
try{const stored=JSON.parse(sessionStorage.getItem(REC_STORAGE)||'null');if(stored&&stored.owner===profileOwner&&Array.isArray(stored.results)){current=stored.results.filter(movie=>movie&&Number.isSafeInteger(Number(movie.id))&&Number(movie.id)>0).slice(0,10);currentWarning=typeof stored.warning==='string'?stored.warning:''}}catch(_){}
// Do not display a cached signed-in profile if this browser was already idle.
try{const last=Number(localStorage.getItem(IDLE_PREFIX+profileOwner));if(profileOwner&&last>0&&Date.now()-last>=IDLE_LIMIT){profile=blank();current=[];currentWarning=''}}catch(_){}
if(!Array.isArray(profile.saved))profile.saved=[];
if(!Array.isArray(profile.decades))profile.decades=[];
if(!profile.ratings||typeof profile.ratings!=='object'||Array.isArray(profile.ratings))profile.ratings={};
if(!profile.starRatings||typeof profile.starRatings!=='object'||Array.isArray(profile.starRatings))profile.starRatings={};
const el=(tag,text,className)=>{const node=document.createElement(tag); if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
async function request(path, options={}){const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{})};const res=await fetch(path,{...options,headers:{...headers,...options.headers}});let data;try{data=await res.json()}catch(_){throw new Error('The server returned an unexpected response.')}if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status}).`);return data}
function syncProfile(){
  if(!session||saveVersion<=savedVersion)return saveQueue;
  const version=saveVersion,body=JSON.stringify({profile}),token=session.access_token,owner=session.user?.id;
  const operation=saveQueue.catch(()=>{}).then(()=>request('/api/profile',{method:'PUT',headers:{Authorization:'Bearer '+token},body}));
  saveQueue=operation.then(()=>{if(session?.user?.id===owner){savedVersion=Math.max(savedVersion,version);if(owner&&saveVersion<=version)try{localStorage.removeItem('nextthree.unsynced.v1.'+owner)}catch(_){}}});
  return saveQueue;
}
function persist(){
  if(session?.user?.id&&loadedAccountId===session.user.id)profileOwner=session.user.id;
  try{localStorage.setItem(STORAGE,JSON.stringify(profile));if(profileOwner)localStorage.setItem(OWNER_STORAGE,profileOwner);else localStorage.removeItem(OWNER_STORAGE)}catch(_){}
  if(session&&loadedAccountId===session.user?.id){saveVersion++;try{localStorage.setItem('nextthree.unsynced.v1.'+session.user.id,JSON.stringify(profile))}catch(_){}clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;syncProfile().catch(e=>{$('configWarning').textContent='Could not save your profile to your account. Your changes remain in this browser. '+e.message;$('configWarning').hidden=false})},400)}
}
function rememberRecommendations(){try{if(current.length)sessionStorage.setItem(REC_STORAGE,JSON.stringify({owner:profileOwner,results:current,warning:currentWarning}));else sessionStorage.removeItem(REC_STORAGE)}catch(_){}}
function movieRecord(movie){return {id:Number(movie.id),title:String(movie.title||movie.name||'').slice(0,200),release_date:String(movie.release_date||'').slice(0,20),poster_path:typeof movie.poster_path==='string'?movie.poster_path.slice(0,200):null,overview:typeof movie.overview==='string'?movie.overview.slice(0,3000):'',genre_ids:Array.isArray(movie.genre_ids)?movie.genre_ids:[]}}
const hydrationAttempted=new WeakSet(), hydrationQueue=[];
let hydrationActive=0;
function hydrateSaved(movie){
  if(hydrationAttempted.has(movie)||!Number.isSafeInteger(Number(movie.id))||Number(movie.id)<=0)return;
  hydrationAttempted.add(movie);hydrationQueue.push(movie);drainHydration();
}
function drainHydration(){
  while(hydrationActive<4&&hydrationQueue.length){
    const movie=hydrationQueue.shift();if(!profile.saved.includes(movie))continue;
    hydrationActive++;
    request('/api/movies/'+Number(movie.id)).then(({movie:detail})=>{
      if(!profile.saved.includes(movie)||!detail)return;
      const updated=movieRecord({...movie,...detail,genre_ids:movie.genre_ids?.length?movie.genre_ids:(detail.genres||[]).map(g=>g.id)});
      Object.assign(movie,updated);persist();renderSaved();
    }).catch(()=>{}).finally(()=>{hydrationActive--;drainHydration()});
  }
}
function renderSaved(){
  const box=$('savedMovies');box.replaceChildren();
  $('savedHelp').textContent=session?'Saved to your account for your next movie night.':'Saved in this browser. Sign in to keep your list across devices.';
  $('savedCount').textContent=profile.saved.length?'('+profile.saved.length+')':'';
  if(!profile.saved.length){box.append(el('p','Movies you save will appear here.','saved-empty'));return}
  for(const movie of profile.saved){
    const title=movie.title||`Movie ${movie.id}`,row=el('div',undefined,'saved-row'),details=el('div',undefined,'saved-details');
    const poster=movie.poster_path?document.createElement('img'):el('div','✦','saved-poster saved-poster-fallback');
    if(movie.poster_path){poster.className='saved-poster';poster.alt=title+' poster';poster.loading='lazy';poster.src='https://image.tmdb.org/t/p/w185'+movie.poster_path;poster.onerror=()=>poster.replaceWith(el('div','✦','saved-poster saved-poster-fallback'))}
    const heading=el('div',undefined,'saved-title');heading.append(el('strong',title));if(movie.release_date)heading.append(el('span',movie.release_date.slice(0,4),'saved-year'));
    details.append(heading,el('p',movie.overview||'No synopsis available.','saved-overview'));
    if(!movie.overview||!movie.poster_path)hydrateSaved(movie);
    const actions=el('div',undefined,'saved-actions'),id=Number(movie.id);
    if(Number.isSafeInteger(id)&&id>0){const link=el('a','Where to watch ↗');link.href='https://www.themoviedb.org/movie/'+id+'/watch?locale=US';link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Where to watch '+title);actions.append(link)}
    const remove=el('button','Remove','remove-saved');remove.type='button';remove.setAttribute('aria-label','Remove '+title+' from saved movies');
    remove.onclick=()=>{profile.saved=profile.saved.filter(item=>Number(item.id)!==id);persist();renderSaved();renderCards();$('saveMessage').textContent='';$('savedStatus').textContent=title+' removed from saved movies.'};
    actions.append(remove);details.append(actions);row.append(poster,details);box.append(row);
  }
}
function toggleSaved(movie){
  const id=Number(movie.id),exists=profile.saved.some(item=>Number(item.id)===id);
  if(exists)profile.saved=profile.saved.filter(item=>Number(item.id)!==id);
  else if(profile.saved.length<500)profile.saved.push(movieRecord(movie));
  else{$('saveMessage').textContent='Your saved list is full. Remove a movie to save another.';return}
  persist();renderSaved();renderCards();$('savedStatus').textContent='';$('saveMessage').textContent=(movie.title||'Movie')+(exists?' removed from saved movies.':' saved for later.');
  [...$('cards').querySelectorAll('button[data-save-id]')].find(button=>button.dataset.saveId===String(id))?.focus({preventScroll:true});
}
function saveRecommendations(){
  const known=new Set(profile.saved.map(movie=>Number(movie.id)));let added=0;
  for(const movie of current){const id=Number(movie.id);if(!known.has(id)&&profile.saved.length<500){profile.saved.push(movieRecord(movie));known.add(id);added++}}
  if(added){persist();renderSaved();renderCards()}
  const remaining=current.some(movie=>!known.has(Number(movie.id)));
  $('savedStatus').textContent='';$('saveMessage').textContent=added?`Saved ${added} ${added===1?'movie':'movies'} for later.`+(remaining?' Your saved list is full. Remove a movie to save another.':''):(remaining?'Your saved list is full. Remove a movie to save another.':'These recommendations are already saved.');
}
function setStarRating(movie,rating,origin){
  if(profile.starRatings[movie.id]===rating)delete profile.starRatings[movie.id];
  else {
    profile.starRatings[movie.id]=rating;
    if(!profile.watched.some(item=>item.id===movie.id))profile.watched.push(movieRecord(movie));
  }
  delete profile.ratings[movie.id];
  persist();renderWatched();renderCards();
  const area=origin==='watched'?$('watched'):$('cards');
  const replacement=[...area.querySelectorAll('button[data-movie-id]')].find(button=>button.dataset.movieId===String(movie.id)&&button.dataset.stars===String(rating));
  replacement?.focus({preventScroll:true});
}
function starControl(movie,origin){
  const title=movie.title||movie.name||`Movie ${movie.id}`,value=profile.starRatings[movie.id]||0;
  const wrap=el('div',undefined,'star-control'),group=el('div',undefined,'star-rating');
  group.setAttribute('role','group');group.setAttribute('aria-label','Rate '+title+' from 1 to 5 stars');
  for(let n=1;n<=5;n++){
    const button=el('button',n<=value?'★':'☆','star-button'+(n<=value?' is-filled':''));button.type='button';
    button.dataset.movieId=String(movie.id);button.dataset.stars=String(n);
    button.setAttribute('aria-label','Rate '+title+' '+n+' '+(n===1?'star':'stars')+(origin==='watched'?' in watched movies':''));
    button.setAttribute('aria-pressed',String(value===n));button.onclick=()=>setStarRating(movie,n,origin);group.append(button);
  }
  const legacy=profile.ratings[movie.id];
  const status=value?`${value} out of 5 stars`:legacy===1?'Earlier rating: liked':legacy===-1?'Earlier rating: disliked':'Not rated yet';
  wrap.append(group,el('span',status,'star-value'));return wrap;
}
function renderWatched(){
  const container=$('watched');container.replaceChildren();
  if(!profile.watched.length){container.append(el('p','No movies added yet.','hint'));return}
  for(const movie of profile.watched){
    const title=movie.title||movie.name||`Movie ${movie.id}`,chip=el('div',undefined,'chip');
    chip.append(el('span',title));
    const ratings=starControl(movie,'watched');
    const remove=el('button','×','remove-watched');remove.type='button';
    remove.setAttribute('aria-label','Remove '+title+' and its rating from watched movies');
    remove.onclick=()=>{profile.watched=profile.watched.filter(item=>item.id!==movie.id);delete profile.ratings[movie.id];delete profile.starRatings[movie.id];persist();renderWatched();renderCards()};
    chip.append(ratings,remove);container.append(chip);
  }
}
function renderProviders(){const box=$('providers');box.replaceChildren();const query=$('providerSearch').value.toLowerCase().trim();let list=providers.filter(p=>p.provider_name.toLowerCase().includes(query));if(!providers.length){box.append(el('p','Service choices appear when the movie catalog is connected.','hint'));return}if(!list.length){box.append(el('p','No services match your search.','hint'));return}for(const p of list){const b=el('button',p.provider_name,'provider');b.type='button';b.setAttribute('aria-pressed',profile.providers.includes(p.provider_id));b.onclick=()=>{profile.providers=profile.providers.includes(p.provider_id)?profile.providers.filter(i=>i!==p.provider_id):[...profile.providers,p.provider_id];persist();renderProviders()};box.append(b)}}
function renderGenres(){
  const box=$('genreOptions');box.replaceChildren();
  for(const genre of [...genres,{id:'coming-of-age',name:'Coming of age'}].sort((a,b)=>a.name.localeCompare(b.name))){
    const label=el('label',undefined,'genre-option'),input=document.createElement('input'),text=el('span',genre.name);
    input.type='checkbox';input.value=String(genre.id);input.checked=profile.genres.some(value=>String(value)===String(genre.id));
    input.addEventListener('change',()=>{const choice=genre.id==='coming-of-age'?genre.id:Number(genre.id);profile.genres=profile.genres.filter(value=>String(value)!==String(choice));if(input.checked)profile.genres.push(choice);persist()});label.append(input,text);box.append(label)
  }
}
async function loadFeatured(){
  const box=$('featuredPosters');
  try{
    const data=await request('/api/featured');
    const candidates=(data.results||[]).filter(movie=>Number.isSafeInteger(movie.id)&&movie.id>0&&typeof movie.poster_path==='string'&&/^\/[\w-]+\.(jpg|png|webp)$/i.test(movie.poster_path));
    for(let i=candidates.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]]}
    box.replaceChildren();
    for(const movie of candidates.slice(0,50)){
      const title=movie.title||'Movie',link=el('a',undefined,'featured-poster');link.href='https://www.themoviedb.org/movie/'+movie.id;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Explore '+title+' on TMDB');
      const poster=document.createElement('img');poster.src='https://image.tmdb.org/t/p/w185'+movie.poster_path;poster.alt=title+' poster';poster.loading='lazy';poster.onerror=()=>{link.remove();if(!box.children.length)box.append(el('p','Movie posters are unavailable right now.','featured-message'));updatePosterStatus()};link.append(poster);box.append(link);
    }
    if(!box.children.length)box.append(el('p','Movie posters are unavailable right now.','featured-message'));
    updatePosterStatus();
  }catch(_){box.replaceChildren(el('p','Movie posters are unavailable right now.','featured-message'));$('posterStatus').textContent='' }
}
function updatePosterStatus(){const count=$('featuredPosters').querySelectorAll('.featured-poster').length;$('posterStatus').textContent=count?count+' '+(count===1?'movie':'movies')+' · scroll or swipe to explore':''}
let posterAutoPlaying=!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,posterHovered=false,posterTimer=null;
function advancePosterCarousel(){
  const box=$('featuredPosters'),max=box.scrollWidth-box.clientWidth,rect=box.getBoundingClientRect();
  if(!posterAutoPlaying||posterHovered||document.hidden||max<=5||rect.bottom<=0||rect.top>=window.innerHeight)return;
  if(box.scrollLeft>=max-5){box.scrollTo({left:0,behavior:'smooth'});return}
  const first=box.querySelector('.featured-poster');
  box.scrollBy({left:(first?.getBoundingClientRect().width||94)+10,behavior:'smooth'});
}
function startPosterAutoplay(){
  if(posterTimer!==null)return;
  const box=$('featuredPosters');
  box.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')posterHovered=true});
  box.addEventListener('pointerleave',()=>{posterHovered=false});
  box.addEventListener('focusin',()=>{posterAutoPlaying=false});
  box.addEventListener('pointerdown',event=>{if(event.pointerType==='touch')posterAutoPlaying=false});
  box.addEventListener('keydown',event=>{if(event.target===box&&event.code==='Space'){event.preventDefault();posterAutoPlaying=!posterAutoPlaying}});
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change',event=>{if(event.matches)posterAutoPlaying=false});
  posterTimer=setInterval(advancePosterCarousel,1800);
}

function movieListText(movies){return movies.map(movie=>{const year=/^\d{4}/.test(movie.release_date||'')?' ('+movie.release_date.slice(0,4)+')':'';return '• '+(movie.title||movie.name||'Movie')+year}).join('\n')}
function composeShareMessage(watched,recommendations,includeWatched,includeRecommended,origin){
  const parts=[];
  if(includeRecommended&&recommendations.length)parts.push('Movies recommended for me:\n'+movieListText(recommendations));
  if(includeWatched&&watched.length)parts.push('Movies I’ve watched:\n'+movieListText(watched));
  return parts.length?'A few movie ideas for us!\n\n'+parts.join('\n\n')+'\n\nFind your own picks: '+origin+'/':'';
}
function updateShareMessage(){
  $('shareRecCount').textContent=current.length?'('+current.length+')':'';
  $('shareRecHint').textContent=current.length?'':'No current recommendations yet. Select Find my movies first to include them.';
  const message=composeShareMessage(profile.watched,current,$('shareWatched').checked,$('shareRecommended').checked,location.origin);
  $('shareText').value=message;$('shareStatus').textContent=message?'':'Add a watched movie or find recommendations to share.';
  updateShareButtons();
}
function updateShareButtons(){const empty=!$('shareText').value.trim(),canShare=typeof navigator.share==='function';$('nativeShare').disabled=empty||!canShare;$('copyShare').disabled=empty;$('shareHelp').textContent=canShare?'Long messages may be split into multiple texts. Your friend is selected in your messaging app.':'Copy the message and paste it into a text to your friend. Long messages may be split into multiple texts.'}
async function shareMovies(){
  const message=$('shareText').value.trim();if(!message||typeof navigator.share!=='function')return;
  try{await navigator.share({text:message});$('shareStatus').textContent='Choose your friend and send from your messaging app.'}
  catch(error){if(error.name!=='AbortError')$('shareStatus').textContent='Sharing is unavailable here. Copy the message and paste it into your messaging app.'}
}
async function copyShareMessage(){
  try{await navigator.clipboard.writeText($('shareText').value);$('shareStatus').textContent='Message copied. Paste it into a text to your friend.'}
  catch(_){$('shareText').focus();$('shareText').select();$('shareStatus').textContent='Select and copy the message, then paste it into a text.'}
}

function renderDecades(){
  const box=$('decadeOptions');box.replaceChildren();
  for(let decade=1950;decade<=2020;decade+=10){const label=el('label',undefined,'decade-option'),input=document.createElement('input'),text=el('span',decade+'s');input.type='checkbox';input.checked=profile.decades.includes(decade);input.addEventListener('change',()=>{profile.decades=profile.decades.filter(value=>value!==decade);if(input.checked)profile.decades.push(decade);persist()});label.append(input,text);box.append(label)}
}
function renderZip(){const zip=$('zipCode');zip.value=/^\d{5}$/.test(profile.zipCode||'')?profile.zipCode:'';$('zipStatus').textContent=''}
function renderTypes(){document.querySelectorAll('.type-grid input').forEach(input=>{input.checked=profile.types.includes(input.value)})}
function debounce(fn,ms){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms)}}
async function search(){const query=$('search').value.trim();const seq=++searchSeq;const box=$('searchResults');box.replaceChildren();if(query.length<2)return;box.append(el('p','Searching…','hint'));try{const data=await request('/api/search?q='+encodeURIComponent(query));if(seq!==searchSeq)return;box.replaceChildren();const results=(data.results||[]).filter(m=>!profile.watched.some(x=>x.id===m.id));if(!results.length){box.append(el('p','No matching movies found.','hint'));return}for(const m of results.slice(0,7)){let b=el('button',`${m.title} ${m.release_date?'('+m.release_date.slice(0,4)+')':''}`,'search-result');b.type='button';b.onclick=()=>{profile.watched.push(m);persist();renderWatched();$('search').value='';box.replaceChildren()};box.append(b)}}catch(e){if(seq!==searchSeq)return;box.replaceChildren(el('p',e.message,'hint'))}}
async function searchSuggestions(query,seq){
  const box=$('suggestedResults');
  if(seq!==suggestedSeq)return;
  if(query.length<2){box.replaceChildren();return}
  box.replaceChildren(el('p','Searching…','hint'));
  try{
    const data=await request('/api/search?q='+encodeURIComponent(query));if(seq!==suggestedSeq)return;
    box.replaceChildren();const results=(Array.isArray(data.results)?data.results:[]).filter(movie=>movie&&Number.isSafeInteger(Number(movie.id))&&Number(movie.id)>0).slice(0,7);
    if(!results.length){box.append(el('p','No matching movies found.','hint'));return}
    for(const movie of results){
      const title=movie.title||movie.name||'Movie',year=(movie.release_date||'').slice(0,4),already=profile.saved.some(item=>Number(item.id)===Number(movie.id));
      const button=el('button',title+(year?' ('+year+')':'')+(already?' · Already saved':' · Add'),'search-result');button.type='button';button.disabled=already;
      button.setAttribute('aria-label',already?title+' is already saved':'Add '+title+' to saved movies');
      button.onclick=()=>{
        const id=Number(movie.id);if(profile.saved.some(item=>Number(item.id)===id))return;
        if(profile.saved.length>=500){$('savedStatus').textContent='Your saved list is full. Remove a movie to add another.';return}
        profile.saved.push(movieRecord(movie));persist();renderSaved();renderCards();suggestedSeq++;$('suggestedSearch').value='';box.replaceChildren();$('savedStatus').textContent=title+' added to saved movies.';$('suggestedSearch').focus();
      };
      box.append(button);
    }
  }catch(error){if(seq===suggestedSeq)box.replaceChildren(el('p',error.message,'hint'))}
}
function renderCards(){
  const box=$('cards');box.replaceChildren();$('saveRecommendations').disabled=!current.length;
  for(const movie of current){
    const card=el('article',undefined,'card');
    if(movie.poster_path){const poster=document.createElement('img');poster.className='poster';poster.alt=movie.title+' poster';poster.src='https://image.tmdb.org/t/p/w500'+movie.poster_path;poster.loading='lazy';poster.onerror=()=>poster.replaceWith(el('div','✦','poster-fallback'));card.append(poster)}
    else card.append(el('div','✦','poster-fallback'));
    const body=el('div',undefined,'card-body');
    body.append(el('div',(movie.release_date||'').slice(0,4),'card-meta'),el('h3',movie.title),el('p',movie.overview||'No synopsis available.'),el('p',movie.reason||'Selected based on your movie preferences.','why'));
    const offers=Array.isArray(movie.providers)?movie.providers:[];
    const names={flatrate:'Subscription',free:'Free',ads:'Free with ads',rent:'Rent',buy:'Buy'};
    if(offers.length)body.append(el('div','Available: '+offers.map(p=>p.provider_name+(p.type?' ('+(names[p.type]||p.type)+')':'')).join(', '),'availability'));
    else if(!movie.in_theaters)body.append(el('div','Streaming availability unavailable.','availability'));
    if(movie.in_theaters){
      body.append(el('span','In U.S. theaters · Check local showtimes','theater-badge'));
      const search=new URL('https://www.google.com/search');
      const place=/^\d{5}$/.test(profile.zipCode||'')?'near '+profile.zipCode:'near me';
      search.searchParams.set('q',[movie.title,(movie.release_date||'').slice(0,4),'movie showtimes',place].filter(Boolean).join(' '));
      const showtimes=el('a','Search showtimes on Google ↗','showtimes-link');
      showtimes.href=search.href;showtimes.target='_blank';showtimes.rel='noopener noreferrer';
      showtimes.setAttribute('aria-label','Search Google for '+movie.title+' showtimes '+place);
      body.append(showtimes);
    }
    const alreadyWatched=profile.watched.some(item=>item.id===movie.id);
    body.append(el('p',alreadyWatched?'Saved to your watched movies.':'Seen it? Rate it to save as watched.','rating-hint'),starControl(movie,'cards'));
    const actions=el('div',undefined,'card-actions');
    if(movie.watch_url){try{const url=new URL(movie.watch_url);if(url.protocol==='https:'){const a=el('a','Where to watch ↗');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';actions.append(a)}}catch(_){}}
    const isSaved=profile.saved.some(item=>Number(item.id)===Number(movie.id)),save=el('button',isSaved?'✓ Saved for later':'☆ Save for later','save-movie');
    save.type='button';save.dataset.saveId=String(movie.id);save.setAttribute('aria-label','Save '+movie.title+' for later');save.setAttribute('aria-pressed',String(isSaved));save.onclick=()=>toggleSaved(movie);
    body.append(actions,save);card.append(body);box.append(card);
  }
}
async function recommend(){if(!profile.watched.length&&!profile.genres.length&&!profile.decades.length&&!profile.types.includes('theater')){$('recommendStatus').textContent='Please add a movie you’ve watched, choose genres or decades, or select In theaters.';return}if(!profile.types.length){$('recommendStatus').textContent='Choose at least one viewing option.';return}$('recommend').disabled=true;$('recommendStatus').textContent='Finding your recommendations…';const ownerAtRequest=profileOwner;try{const {saved,...preferences}=profile;const data=await request('/api/recommendations',{method:'POST',body:JSON.stringify(preferences)});if(ownerAtRequest!==profileOwner)return;current=Array.isArray(data.results)?data.results.slice(0,10):[];const missing=Array.isArray(data.missing_genres)?data.missing_genres.map(id=>id==='coming-of-age'?'Coming of age':(genres.find(genre=>String(genre.id)===String(id))?.name||'Genre '+id)):[];currentWarning=[data.warning||'',missing.length?'Not represented: '+missing.join(', ')+'.':''].filter(Boolean).join(' ');rememberRecommendations();renderCards();$('recommendStatus').textContent=[current.length?`Found ${current.length} ${current.length===1?'movie':'movies'} for you.`:'No matches found. Try another genre or service.',currentWarning].filter(Boolean).join(' ');location.hash='discover'}catch(e){$('recommendStatus').textContent=e.message}finally{$('recommend').disabled=false}}
function openDialog(){$('authDialog').showModal()}
function createIdleTracker(onExpire){
  let owner='',last=0,timer=null,expired=false;
  function stored(){try{const value=Number(localStorage.getItem(IDLE_PREFIX+owner));return Number.isFinite(value)&&value>0?Math.min(value,Date.now()):0}catch(_){return 0}}
  function write(value){try{localStorage.setItem(IDLE_PREFIX+owner,String(value))}catch(_){}}
  function stop(){if(timer!==null)clearTimeout(timer);timer=null;owner='';last=0;expired=false}
  function check(){
    if(!owner||expired)return false;
    const now=Date.now();last=Math.max(last,stored());
    if(now-last>=IDLE_LIMIT){expired=true;if(timer!==null)clearTimeout(timer);timer=null;onExpire();return false}
    if(timer!==null)clearTimeout(timer);timer=setTimeout(check,Math.max(1,IDLE_LIMIT-(now-last)));return true;
  }
  function start(id,fresh=false){
    if(!id)return false;
    if(owner!==id){stop();owner=id}
    if(fresh){last=Date.now();write(last)}
    else if(!last){last=stored()||Date.now();write(last)}
    return check();
  }
  function activity(){if(!owner||expired||!check())return;last=Date.now();write(last);check()}
  return {start,stop,check,activity,key:()=>owner?IDLE_PREFIX+owner:''};
}
const idleTracker=createIdleTracker(()=>{if(!idleSignOutPromise)idleSignOutPromise=signOutAccount({idle:true}).finally(()=>{idleSignOutPromise=null})});
function startIdleEvents(){
  for(const type of ['pointerdown','keydown','wheel','touchstart','input'])document.addEventListener(type,event=>{
    if(!session)return;
    if((signingOut&&idleSignOutPromise)||(!signingOut&&!idleTracker.check())){if(event.cancelable)event.preventDefault();event.stopImmediatePropagation();return}
    if(!signingOut)idleTracker.activity();
  },{capture:true,passive:false});
  document.addEventListener('visibilitychange',()=>{if(session&&!document.hidden)idleTracker.check()});
  window.addEventListener('focus',()=>{if(session)idleTracker.check()});
  window.addEventListener('storage',event=>{if(session&&event.key===idleTracker.key())idleTracker.check()});
}
function clearAccountView(){
  session=null;saveQueue=Promise.resolve();saveVersion=0;savedVersion=0;profile=blank();profileOwner='';loadedAccountId=null;
  try{localStorage.removeItem(STORAGE);localStorage.removeItem(OWNER_STORAGE)}catch(_){}
  current=[];currentWarning='';rememberRecommendations();renderCards();renderWatched();renderSaved();$('saveMessage').textContent='';$('savedStatus').textContent='';renderProviders();renderGenres();renderDecades();renderTypes();renderZip();
  $('accountButton').textContent='Sign in';$('recommendStatus').textContent='Add a movie, choose genres or decades, or select In theaters to get started.';
}
async function authInit(){
  if(!config.authConfigured||!window.supabase){$('authNote').textContent='Sign in is not configured yet. Your selections are saved in this browser.';$('googleLogin').disabled=true;$('facebookLogin').disabled=true;return}
  const callbackUrl=new URL(location.href),hasOAuthResult=callbackUrl.searchParams.has('code')||new URLSearchParams(callbackUrl.hash.slice(1)).has('access_token');
  supabaseClient=window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);
  const result=await supabaseClient.auth.getSession();session=result.data.session;
  let fresh=false;try{fresh=hasOAuthResult&&sessionStorage.getItem(LOGIN_INTENT)==='1';sessionStorage.removeItem(LOGIN_INTENT)}catch(_){}
  if(session&&idleTracker.start(session.user?.id,fresh))await updateAccount();
  else if(session&&idleSignOutPromise)await idleSignOutPromise;
  else await updateAccount();
  supabaseClient.auth.onAuthStateChange((_event,newSession)=>{
    const hadSession=!!session;session=newSession;
    if(!newSession){idleTracker.stop();if(hadSession&&!signingOut){if(saveVersion>savedVersion&&profileOwner)try{localStorage.setItem('nextthree.unsynced.v1.'+profileOwner,JSON.stringify(profile))}catch(_){}clearAccountView()}else setTimeout(()=>updateAccount(),0);return}
    if(idleTracker.start(newSession.user?.id))setTimeout(()=>updateAccount(),0);
  });
}

async function updateAccount(){
  if(!session){loadedAccountId=null;$('accountButton').textContent='Sign in';renderSaved();return}
  const owner=session.user?.id,wasGuest=!profileOwner;$('accountButton').textContent='Sign out';
  if(loadedAccountId===owner){renderSaved();return}
  try{
    const data=await request('/api/profile');if(!session||session.user?.id!==owner)return;
    if(data.profile){
      const guestSaved=wasGuest?profile.saved:[],guestWatched=wasGuest?profile.watched:[],guestRatings=wasGuest?profile.ratings:{},guestStars=wasGuest?profile.starRatings:{},account={...blank(),...data.profile};
      if(!Array.isArray(account.saved))account.saved=[];
      if(!Array.isArray(account.decades))account.decades=[];
      if(!Array.isArray(account.watched))account.watched=[];
      if(!account.ratings||typeof account.ratings!=='object'||Array.isArray(account.ratings))account.ratings={};
      if(!account.starRatings||typeof account.starRatings!=='object'||Array.isArray(account.starRatings))account.starRatings={};
      const known=new Set(account.saved.map(movie=>Number(movie.id)));
      for(const movie of guestSaved)if(!known.has(Number(movie.id))&&account.saved.length<500){account.saved.push(movieRecord(movie));known.add(Number(movie.id))}
      const watchedIds=new Set(account.watched.map(movie=>Number(movie.id)));
      for(const movie of guestWatched)if(!watchedIds.has(Number(movie.id))&&account.watched.length<500){account.watched.push(movieRecord(movie));watchedIds.add(Number(movie.id))}
      for(const [id,rating] of Object.entries(guestRatings))if(!account.starRatings[id]&&!account.ratings[id])account.ratings[id]=rating;
      for(const [id,rating] of Object.entries(guestStars)){account.starRatings[id]=rating;delete account.ratings[id]}
      profile=account;
    }else if(profileOwner&&profileOwner!==owner)profile=blank();
    // Restore locally preserved, unsynced changes only to the same account.
    let pending=null;try{pending=JSON.parse(localStorage.getItem('nextthree.unsynced.v1.'+owner)||'null')}catch(_){}
    if(pending&&typeof pending==='object'&&!Array.isArray(pending)){
      const mergeMovies=(accountItems,localItems)=>{const result=[...(Array.isArray(accountItems)?accountItems:[])],seen=new Set(result.map(item=>Number(item.id)));for(const movie of Array.isArray(localItems)?localItems:[]){if(!seen.has(Number(movie.id))&&result.length<500){result.push(movieRecord(movie));seen.add(Number(movie.id))}}return result};
      const merged={...profile};
      for(const key of ['genres','decades','providers','types'])if(Array.isArray(pending[key]))merged[key]=pending[key];
      if(typeof pending.zipCode==='string')merged.zipCode=pending.zipCode;
      merged.watched=mergeMovies(profile.watched,pending.watched);merged.saved=mergeMovies(profile.saved,pending.saved);
      merged.ratings={...profile.ratings,...(pending.ratings||{})};merged.starRatings={...profile.starRatings,...(pending.starRatings||{})};
      profile=merged;$('configWarning').textContent='Recovered unsynced choices from this browser. They will be saved to your account.';$('configWarning').hidden=false;
    }
    if(profileOwner&&profileOwner!==owner){current=[];currentWarning='';rememberRecommendations();$('recommendStatus').textContent='Add a movie, choose genres or decades, or select In theaters to get started.'}
    loadedAccountId=owner;persist();rememberRecommendations();renderWatched();renderSaved();renderCards();renderProviders();renderGenres();renderDecades();renderTypes();renderZip();
  }catch(e){$('configWarning').textContent='Could not load your saved profile: '+e.message;$('configWarning').hidden=false}
}
async function login(provider){if(!supabaseClient)return;try{sessionStorage.setItem(LOGIN_INTENT,'1')}catch(_){}const options={redirectTo:location.origin+'/'};if(provider==='google')options.queryParams={prompt:'select_account'};const {error}=await supabaseClient.auth.signInWithOAuth({provider,options});if(error){try{sessionStorage.removeItem(LOGIN_INTENT)}catch(_){}$('authNote').textContent=error.message}}
function withTimeout(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Connection timed out')),ms)})]).finally(()=>clearTimeout(timer))}
async function signOutAccount({idle=false}={}){
  if(signingOut)return;signingOut=true;
  const button=$('accountButton'),owner=session?.user?.id||profileOwner;button.disabled=true;
  let saveFailed=false,signOutError=null;
  try{
    if(!idle&&session&&loadedAccountId!==session.user?.id){await updateAccount();if(!session||loadedAccountId!==session.user?.id)throw new Error('Your saved preferences could not be loaded.')}
    clearTimeout(saveTimer);saveTimer=null;
    if(idle){
      if(loadedAccountId===session?.user?.id){
        try{await withTimeout(syncProfile(),3000)}catch(_){saveFailed=true}
      }
    }else await syncProfile();
    if(owner&&saveFailed&&loadedAccountId===owner){try{localStorage.setItem('nextthree.unsynced.v1.'+owner,JSON.stringify(profile))}catch(_){}}
    try{const pendingSignOut=supabaseClient.auth.signOut({scope:'local'}),result=idle?await withTimeout(pendingSignOut,3000):await pendingSignOut;if(result.error)throw result.error}catch(error){if(!idle)throw error;signOutError=error;supabaseClient?.auth?.stopAutoRefresh?.()}
    idleTracker.stop();
    if(!signOutError&&owner){try{localStorage.removeItem(IDLE_PREFIX+owner)}catch(_){}}
    clearAccountView();
    if(idle){$('configWarning').hidden=false;$('configWarning').textContent=signOutError?'Your session was locked after 5 minutes of inactivity. Reconnect and sign in again.':(saveFailed?'You were signed out after 5 minutes of inactivity. Some changes could not be synced and are saved in this browser.':'You were signed out after 5 minutes of inactivity.')}
    await updateAccount();
  }catch(e){$('configWarning').textContent='Could not finish signing out or saving your changes. Please try again. '+e.message;$('configWarning').hidden=false}
  finally{signingOut=false;button.disabled=false}
}

$('zipCode').addEventListener('input',e=>{const zip=e.target.value.replace(/\D/g,'').slice(0,5);e.target.value=zip;$('zipStatus').textContent=zip&&zip.length<5?('Enter all 5 digits.'+(profile.zipCode?' Your saved ZIP is still in use.':'')):'';if(zip.length===5||zip.length===0){profile.zipCode=zip;persist();renderCards()}});
$('shareMovies').onclick=()=>{updateShareMessage();$('shareDialog').showModal()};$('closeShare').onclick=()=>$('shareDialog').close();$('shareWatched').onchange=updateShareMessage;$('shareRecommended').onchange=updateShareMessage;$('shareText').addEventListener('input',updateShareButtons);$('nativeShare').onclick=shareMovies;$('copyShare').onclick=copyShareMessage;
const delayedSuggestionSearch=debounce((query,seq)=>searchSuggestions(query,seq),300);
$('suggestedSearch').addEventListener('input',event=>{const seq=++suggestedSeq,query=event.target.value.trim();$('suggestedResults').replaceChildren();if(query.length>=2)delayedSuggestionSearch(query,seq)});
$('search').addEventListener('input',debounce(search,300));$('providerSearch').addEventListener('input',renderProviders);document.querySelectorAll('.type-grid input').forEach(input=>input.onchange=()=>{profile.types=[...document.querySelectorAll('.type-grid input:checked')].map(x=>x.value);persist()});$('recommend').onclick=recommend;$('saveRecommendations').onclick=saveRecommendations;$('accountButton').onclick=async()=>{if(session&&supabaseClient)await signOutAccount();else openDialog()};$('bottomLogin').onclick=()=>session?($('authNote').textContent='You are signed in.',openDialog()):openDialog();$('closeDialog').onclick=()=>$('authDialog').close();$('googleLogin').onclick=()=>login('google');$('facebookLogin').onclick=()=>login('facebook');
async function init(){
  startIdleEvents();if(profileOwner)idleTracker.start(profileOwner);startPosterAutoplay();renderCards();
  if(current.length)$('recommendStatus').textContent=[`Showing your latest ${current.length} ${current.length===1?'recommendation':'recommendations'}.`,currentWarning].filter(Boolean).join(' ');
  renderWatched();renderSaved();renderProviders();renderTypes();renderGenres();renderDecades();renderZip();
  try{config=await request('/api/config')}
  catch(e){$('featuredPosters').replaceChildren(el('p','Movie posters are unavailable right now.','featured-message'));$('configWarning').hidden=false;$('configWarning').textContent='Could not connect to the application service. '+e.message;$('googleLogin').disabled=true;$('facebookLogin').disabled=true;return}
  try{await authInit()}catch(e){$('configWarning').hidden=false;$('configWarning').textContent='Could not initialize sign in. '+e.message}
  if(!config.tmdbConfigured){$('featuredPosters').replaceChildren(el('p','Movie posters are unavailable right now.','featured-message'));$('configWarning').hidden=false;$('configWarning').textContent='Movie data is not connected yet. An administrator needs to configure the movie data service.';return}
  loadFeatured();
  try{const [gs,ps]=await Promise.all([request('/api/genres'),request('/api/providers')]);genres=gs.genres||[];providers=ps.results||ps.providers||[];renderGenres();renderProviders()}
  catch(e){$('configWarning').hidden=false;$('configWarning').textContent='Could not load movie choices. '+e.message}
}
init();

