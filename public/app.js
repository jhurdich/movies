'use strict';
const $ = id => document.getElementById(id);
const blank=()=>({watched:[],saved:[],genres:[],providers:[],ratings:{},starRatings:{},types:['flatrate','free','ads'],zipCode:''});
let profile=blank(), providers=[], genres=[], current=[], config={}, supabaseClient=null, session=null, searchSeq=0, saveTimer=null;
let saveQueue=Promise.resolve(), saveVersion=0, savedVersion=0;
let profileOwner='',loadedAccountId=null;
const STORAGE='nextthree.profile.v1', OWNER_STORAGE='nextthree.profileOwner.v1';
try { const saved=JSON.parse(localStorage.getItem(STORAGE)); if(saved) profile={...blank(),...saved}; profileOwner=localStorage.getItem(OWNER_STORAGE)||''; } catch (_) {}
if(!Array.isArray(profile.saved))profile.saved=[];
if(!profile.ratings||typeof profile.ratings!=='object'||Array.isArray(profile.ratings))profile.ratings={};
if(!profile.starRatings||typeof profile.starRatings!=='object'||Array.isArray(profile.starRatings))profile.starRatings={};
const el=(tag,text,className)=>{const node=document.createElement(tag); if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
async function request(path, options={}){const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{})};const res=await fetch(path,{...options,headers:{...headers,...options.headers}});let data;try{data=await res.json()}catch(_){throw new Error('The server returned an unexpected response.')}if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status}).`);return data}
function syncProfile(){
  if(!session||saveVersion<=savedVersion)return saveQueue;
  const version=saveVersion,body=JSON.stringify({profile}),token=session.access_token;
  const operation=saveQueue.catch(()=>{}).then(()=>request('/api/profile',{method:'PUT',headers:{Authorization:'Bearer '+token},body}));
  saveQueue=operation.then(()=>{savedVersion=Math.max(savedVersion,version)});
  return saveQueue;
}
function persist(){
  if(session?.user?.id&&loadedAccountId===session.user.id)profileOwner=session.user.id;
  try{localStorage.setItem(STORAGE,JSON.stringify(profile));if(profileOwner)localStorage.setItem(OWNER_STORAGE,profileOwner);else localStorage.removeItem(OWNER_STORAGE)}catch(_){}
  if(session&&loadedAccountId===session.user?.id){saveVersion++;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;syncProfile().catch(e=>{$('configWarning').textContent='Could not save your profile to your account. Your changes remain in this browser. '+e.message;$('configWarning').hidden=false})},400)}
}
function movieRecord(movie){return {id:Number(movie.id),title:String(movie.title||movie.name||'').slice(0,200),release_date:String(movie.release_date||'').slice(0,20),poster_path:typeof movie.poster_path==='string'?movie.poster_path.slice(0,200):null,genre_ids:Array.isArray(movie.genre_ids)?movie.genre_ids:[]}}
function renderSaved(){
  const box=$('savedMovies');box.replaceChildren();
  $('savedHelp').textContent=session?'Saved to your account for your next movie night.':'Saved in this browser. Sign in to keep your list across devices.';
  $('savedCount').textContent=profile.saved.length?'('+profile.saved.length+')':'';
  if(!profile.saved.length){box.append(el('p','Movies you save will appear here.','saved-empty'));return}
  for(const movie of profile.saved){
    const title=movie.title||`Movie ${movie.id}`,row=el('div',undefined,'saved-row'),details=el('div',undefined,'saved-details');
    details.append(el('strong',title));if(movie.release_date)details.append(el('span',movie.release_date.slice(0,4),'saved-year'));
    const actions=el('div',undefined,'saved-actions'),id=Number(movie.id);
    if(Number.isSafeInteger(id)&&id>0){const link=el('a','Where to watch ↗');link.href='https://www.themoviedb.org/movie/'+id+'/watch?locale=US';link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Where to watch '+title);actions.append(link)}
    const remove=el('button','Remove','remove-saved');remove.type='button';remove.setAttribute('aria-label','Remove '+title+' from saved movies');
    remove.onclick=()=>{profile.saved=profile.saved.filter(item=>Number(item.id)!==id);persist();renderSaved();renderCards();$('saveMessage').textContent='';$('savedStatus').textContent=title+' removed from saved movies.'};
    actions.append(remove);row.append(details,actions);box.append(row);
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
function renderGenres(){const box=$('genreOptions');box.replaceChildren();for(const genre of [...genres,{id:'coming-of-age',name:'Coming of age'}].sort((a,b)=>a.name.localeCompare(b.name))){const label=el('label',undefined,'genre-option'),input=document.createElement('input'),text=el('span',genre.name);input.type='checkbox';input.value=String(genre.id);input.checked=profile.genres.some(value=>String(value)===String(genre.id));input.addEventListener('change',()=>{const choice=genre.id==='coming-of-age'?genre.id:Number(genre.id);profile.genres=profile.genres.filter(value=>String(value)!==String(choice));if(input.checked)profile.genres.push(choice);persist()});label.append(input,text);box.append(label)}}
function renderZip(){const zip=$('zipCode');zip.value=/^\d{5}$/.test(profile.zipCode||'')?profile.zipCode:'';$('zipStatus').textContent=''}
function renderTypes(){document.querySelectorAll('.type-grid input').forEach(input=>{input.checked=profile.types.includes(input.value)})}
function debounce(fn,ms){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms)}}
async function search(){const query=$('search').value.trim();const seq=++searchSeq;const box=$('searchResults');box.replaceChildren();if(query.length<2)return;box.append(el('p','Searching…','hint'));try{const data=await request('/api/search?q='+encodeURIComponent(query));if(seq!==searchSeq)return;box.replaceChildren();const results=(data.results||[]).filter(m=>!profile.watched.some(x=>x.id===m.id));if(!results.length){box.append(el('p','No matching movies found.','hint'));return}for(const m of results.slice(0,7)){let b=el('button',`${m.title} ${m.release_date?'('+m.release_date.slice(0,4)+')':''}`,'search-result');b.type='button';b.onclick=()=>{profile.watched.push(m);persist();renderWatched();$('search').value='';box.replaceChildren()};box.append(b)}}catch(e){if(seq!==searchSeq)return;box.replaceChildren(el('p',e.message,'hint'))}}
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
async function recommend(){if(!profile.watched.length&&!profile.types.includes('theater')){$('recommendStatus').textContent='Please add a movie you’ve watched or select In theaters.';return}if(!profile.types.length){$('recommendStatus').textContent='Choose at least one viewing option.';return}$('recommend').disabled=true;$('recommendStatus').textContent='Finding your recommendations…';current=[];renderCards();try{const {saved,...preferences}=profile;const data=await request('/api/recommendations',{method:'POST',body:JSON.stringify(preferences)});current=data.results||[];renderCards();$('recommendStatus').textContent=[current.length?`Found ${current.length} ${current.length===1?'movie':'movies'} for you.`:'No matches found. Try another genre or service.',data.warning||''].filter(Boolean).join(' ');location.hash='discover'}catch(e){$('recommendStatus').textContent=e.message}finally{$('recommend').disabled=false}}
function openDialog(){$('authDialog').showModal()}
async function authInit(){if(!config.authConfigured||!window.supabase){$('authNote').textContent='Sign in is not configured yet. Your selections are saved in this browser.';$('googleLogin').disabled=true;$('facebookLogin').disabled=true;return}supabaseClient=window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);const result=await supabaseClient.auth.getSession();session=result.data.session;await updateAccount();supabaseClient.auth.onAuthStateChange((_event,newSession)=>{session=newSession;setTimeout(()=>updateAccount(),0)})}
async function updateAccount(){
  if(!session){loadedAccountId=null;$('accountButton').textContent='Sign in';renderSaved();return}
  const owner=session.user?.id,wasGuest=!profileOwner;$('accountButton').textContent='Sign out';
  if(loadedAccountId===owner){renderSaved();return}
  try{
    const data=await request('/api/profile');if(!session||session.user?.id!==owner)return;
    if(data.profile){
      const guestSaved=wasGuest?profile.saved:[],guestWatched=wasGuest?profile.watched:[],guestRatings=wasGuest?profile.ratings:{},guestStars=wasGuest?profile.starRatings:{},account={...blank(),...data.profile};
      if(!Array.isArray(account.saved))account.saved=[];
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
    loadedAccountId=owner;persist();renderWatched();renderSaved();renderCards();renderProviders();renderGenres();renderTypes();renderZip();
  }catch(e){$('configWarning').textContent='Could not load your saved profile: '+e.message;$('configWarning').hidden=false}
}
async function login(provider){if(!supabaseClient)return;const options={redirectTo:location.origin+'/'};if(provider==='google')options.queryParams={prompt:'select_account'};const {error}=await supabaseClient.auth.signInWithOAuth({provider,options});if(error)$('authNote').textContent=error.message}
async function signOutAccount(){
  const button=$('accountButton');button.disabled=true;
  try{
    if(session&&loadedAccountId!==session.user?.id){await updateAccount();if(!session||loadedAccountId!==session.user?.id)throw new Error('Your saved preferences could not be loaded.')}
    clearTimeout(saveTimer);saveTimer=null;await syncProfile();
    const {error}=await supabaseClient.auth.signOut({scope:'local'});if(error)throw error;
    session=null;saveQueue=Promise.resolve();saveVersion=0;savedVersion=0;profile=blank();profileOwner='';loadedAccountId=null;
    try{localStorage.removeItem(STORAGE);localStorage.removeItem(OWNER_STORAGE)}catch(_){}
    current=[];renderCards();renderWatched();renderSaved();$('savedStatus').textContent='';$('saveMessage').textContent='';renderProviders();renderGenres();renderTypes();renderZip();
    $('recommendStatus').textContent='Add a movie or select In theaters to get started.';await updateAccount();
  }catch(e){$('configWarning').textContent='Could not finish signing out or saving your changes. Please try again. '+e.message;$('configWarning').hidden=false}
  finally{button.disabled=false}
}
$('zipCode').addEventListener('input',e=>{const zip=e.target.value.replace(/\D/g,'').slice(0,5);e.target.value=zip;$('zipStatus').textContent=zip&&zip.length<5?('Enter all 5 digits.'+(profile.zipCode?' Your saved ZIP is still in use.':'')):'';if(zip.length===5||zip.length===0){profile.zipCode=zip;persist();renderCards()}});
$('search').addEventListener('input',debounce(search,300));$('providerSearch').addEventListener('input',renderProviders);document.querySelectorAll('.type-grid input').forEach(input=>input.onchange=()=>{profile.types=[...document.querySelectorAll('.type-grid input:checked')].map(x=>x.value);persist()});$('recommend').onclick=recommend;$('saveRecommendations').onclick=saveRecommendations;$('accountButton').onclick=async()=>{if(session&&supabaseClient)await signOutAccount();else openDialog()};$('bottomLogin').onclick=()=>session?($('authNote').textContent='You are signed in.',openDialog()):openDialog();$('closeDialog').onclick=()=>$('authDialog').close();$('googleLogin').onclick=()=>login('google');$('facebookLogin').onclick=()=>login('facebook');
async function init(){renderWatched();renderSaved();renderProviders();renderTypes();renderGenres();renderZip();try{config=await request('/api/config');if(!config.tmdbConfigured){$('configWarning').hidden=false;$('configWarning').textContent='Movie data is not connected yet. An administrator needs to configure the movie data service.'}else{const [gs,ps]=await Promise.all([request('/api/genres'),request('/api/providers')]);genres=gs.genres||[];providers=ps.results||ps.providers||[];renderGenres();renderProviders()}await authInit()}catch(e){$('configWarning').hidden=false;$('configWarning').textContent='Could not connect to the application service. '+e.message;$('googleLogin').disabled=true;$('facebookLogin').disabled=true}}
init();
