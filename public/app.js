'use strict';
const $ = id => document.getElementById(id);
const blank=()=>({watched:[],genres:[],providers:[],ratings:{},types:['flatrate','free','ads'],zipCode:''});
let profile=blank(), providers=[], genres=[], current=[], config={}, supabaseClient=null, session=null, searchSeq=0, saveTimer=null;
let saveQueue=Promise.resolve(), saveVersion=0, savedVersion=0;
const STORAGE='nextthree.profile.v1';
try { const saved=JSON.parse(localStorage.getItem(STORAGE)); if(saved) profile={...blank(),...saved}; } catch (_) {}
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
  try{localStorage.setItem(STORAGE,JSON.stringify(profile))}catch(_){}
  if(session){saveVersion++;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;syncProfile().catch(e=>{$('configWarning').textContent='Could not save your profile to your account. Your changes remain in this browser. '+e.message;$('configWarning').hidden=false})},400)}
}
function setRating(movie,rating,origin){
  const existing=profile.ratings[movie.id];
  if(existing===rating)delete profile.ratings[movie.id];
  else {
    profile.ratings[movie.id]=rating;
    if(!profile.watched.some(item=>item.id===movie.id))profile.watched.push({id:movie.id,title:movie.title||movie.name||'',release_date:movie.release_date||'',poster_path:movie.poster_path||null,genre_ids:Array.isArray(movie.genre_ids)?movie.genre_ids:[]});
  }
  persist();renderWatched();renderCards();
  const area=origin==='watched'?$('watched'):$('cards');
  const replacement=[...area.querySelectorAll('button[data-movie-id]')].find(button=>button.dataset.movieId===String(movie.id)&&button.dataset.rating===String(rating));
  replacement?.focus({preventScroll:true});
}
function renderWatched(){
  const container=$('watched');container.replaceChildren();
  if(!profile.watched.length){container.append(el('p','No movies added yet.','hint'));return}
  for(const movie of profile.watched){
    const title=movie.title||movie.name||`Movie ${movie.id}`,chip=el('div',undefined,'chip');
    chip.append(el('span',title));
    const ratings=el('div',undefined,'chip-ratings');ratings.setAttribute('role','group');ratings.setAttribute('aria-label','Rate '+title);
    for(const [rating,label] of [[1,'👍'],[-1,'👎']]){
      const button=el('button',label,'chip-rating');button.type='button';
      button.dataset.movieId=String(movie.id);button.dataset.rating=String(rating);
      button.setAttribute('aria-label',(rating===1?'Like ':'Dislike ')+title+' in watched movies');
      button.setAttribute('aria-pressed',String(profile.ratings[movie.id]===rating));
      button.onclick=()=>setRating(movie,rating,'watched');ratings.append(button);
    }
    const remove=el('button','×','remove-watched');remove.type='button';
    remove.setAttribute('aria-label','Remove '+title+' and its rating from watched movies');
    remove.onclick=()=>{profile.watched=profile.watched.filter(item=>item.id!==movie.id);delete profile.ratings[movie.id];persist();renderWatched();renderCards()};
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
  const box=$('cards');box.replaceChildren();
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
    body.append(el('p',alreadyWatched?'Saved to your watched movies.':'Seen it? Rate it to save as watched.','rating-hint'));
    const actions=el('div',undefined,'card-actions');
    for(const [rating,label] of [[1,'👍'],[-1,'👎']]){const b=el('button',label);b.type='button';b.dataset.movieId=String(movie.id);b.dataset.rating=String(rating);b.setAttribute('aria-label',(rating===1?'Like ':'Dislike ')+movie.title);b.setAttribute('aria-pressed',String(profile.ratings[movie.id]===rating));b.onclick=()=>setRating(movie,rating,'cards');actions.append(b)}
    if(movie.watch_url){try{const url=new URL(movie.watch_url);if(url.protocol==='https:'){const a=el('a','Where to watch ↗');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';actions.append(a)}}catch(_){}}
    body.append(actions);card.append(body);box.append(card);
  }
}
async function recommend(){if(!profile.watched.length&&!profile.types.includes('theater')){$('recommendStatus').textContent='Please add a movie you’ve watched or select In theaters.';return}if(!profile.types.length){$('recommendStatus').textContent='Choose at least one viewing option.';return}$('recommend').disabled=true;$('recommendStatus').textContent='Finding your recommendations…';$('cards').replaceChildren();try{const data=await request('/api/recommendations',{method:'POST',body:JSON.stringify(profile)});current=data.results||[];renderCards();$('recommendStatus').textContent=[current.length?`Found ${current.length} ${current.length===1?'movie':'movies'} for you.`:'No matches found. Try another genre or service.',data.warning||''].filter(Boolean).join(' ');location.hash='discover'}catch(e){$('recommendStatus').textContent=e.message}finally{$('recommend').disabled=false}}
function openDialog(){$('authDialog').showModal()}
async function authInit(){if(!config.authConfigured||!window.supabase){$('authNote').textContent='Sign in is not configured yet. Your selections are saved in this browser.';$('googleLogin').disabled=true;$('facebookLogin').disabled=true;return}supabaseClient=window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);const result=await supabaseClient.auth.getSession();session=result.data.session;await updateAccount();supabaseClient.auth.onAuthStateChange((_event,newSession)=>{session=newSession;setTimeout(()=>updateAccount(),0)})}
async function updateAccount(){if(!session){$('accountButton').textContent='Sign in';return}const owner=session.user?.id;$('accountButton').textContent='Sign out';try{const data=await request('/api/profile');if(!session||session.user?.id!==owner)return;if(data.profile){profile={...blank(),...data.profile};persist();renderWatched();renderCards();renderProviders();renderGenres();renderTypes();renderZip()}else{persist()}}catch(e){$('configWarning').textContent='Could not load your saved profile: '+e.message;$('configWarning').hidden=false}}
async function login(provider){if(!supabaseClient)return;const options={redirectTo:location.origin+'/'};if(provider==='google')options.queryParams={prompt:'select_account'};const {error}=await supabaseClient.auth.signInWithOAuth({provider,options});if(error)$('authNote').textContent=error.message}
async function signOutAccount(){
  const button=$('accountButton');button.disabled=true;
  try{
    clearTimeout(saveTimer);saveTimer=null;await syncProfile();
    const {error}=await supabaseClient.auth.signOut({scope:'local'});if(error)throw error;
    session=null;saveQueue=Promise.resolve();saveVersion=0;savedVersion=0;profile=blank();
    try{localStorage.removeItem(STORAGE)}catch(_){}
    current=[];renderCards();renderWatched();renderProviders();renderGenres();renderTypes();renderZip();
    $('recommendStatus').textContent='Add a movie or select In theaters to get started.';await updateAccount();
  }catch(e){$('configWarning').textContent='Could not finish signing out or saving your changes. Please try again. '+e.message;$('configWarning').hidden=false}
  finally{button.disabled=false}
}
$('zipCode').addEventListener('input',e=>{const zip=e.target.value.replace(/\D/g,'').slice(0,5);e.target.value=zip;$('zipStatus').textContent=zip&&zip.length<5?('Enter all 5 digits.'+(profile.zipCode?' Your saved ZIP is still in use.':'')):'';if(zip.length===5||zip.length===0){profile.zipCode=zip;persist();renderCards()}});
$('search').addEventListener('input',debounce(search,300));$('providerSearch').addEventListener('input',renderProviders);document.querySelectorAll('.type-grid input').forEach(input=>input.onchange=()=>{profile.types=[...document.querySelectorAll('.type-grid input:checked')].map(x=>x.value);persist()});$('recommend').onclick=recommend;$('accountButton').onclick=async()=>{if(session&&supabaseClient)await signOutAccount();else openDialog()};$('bottomLogin').onclick=()=>session?($('authNote').textContent='You are signed in.',openDialog()):openDialog();$('closeDialog').onclick=()=>$('authDialog').close();$('googleLogin').onclick=()=>login('google');$('facebookLogin').onclick=()=>login('facebook');
async function init(){renderWatched();renderProviders();renderTypes();renderGenres();renderZip();try{config=await request('/api/config');if(!config.tmdbConfigured){$('configWarning').hidden=false;$('configWarning').textContent='Movie data is not connected yet. An administrator needs to configure the movie data service.'}else{const [gs,ps]=await Promise.all([request('/api/genres'),request('/api/providers')]);genres=gs.genres||[];providers=ps.results||ps.providers||[];renderGenres();renderProviders()}await authInit()}catch(e){$('configWarning').hidden=false;$('configWarning').textContent='Could not connect to the application service. '+e.message;$('googleLogin').disabled=true;$('facebookLogin').disabled=true}}
init();
