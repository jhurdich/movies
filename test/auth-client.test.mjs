import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function createHarness({failSave=false,remoteProfile=null}={}) {
  const elements=new Map(), storage=new Map(), calls=[];
  const element=()=>({
    value:'',textContent:'',hidden:false,disabled:false,dataset:{},style:{},
    addEventListener(){},setAttribute(){},replaceChildren(){},append(){},
    querySelectorAll(){return []},focus(){},showModal(){},close(){}
  });
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element,querySelectorAll(){return []}};
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const client={auth:{
    async signOut(options){calls.push({type:'signOut',scope:options.scope});return {error:null}},
    async signInWithOAuth(options){calls.push({type:'login',options});return {error:null}},
    async getSession(){return {data:{session:{access_token:'test.token',user:{id:'user-1'}}}}},
    onAuthStateChange(callback){this.callback=callback}
  }};
  const context={document,localStorage,window:{supabase:{createClient:()=>client}},location:{origin:'https://example.test',href:'https://example.test/'},URL,URLSearchParams,
    setTimeout(){return 1},clearTimeout(){},
    async fetch(_path,options){if(options.method!=='PUT')return {ok:true,json:async()=>({profile:remoteProfile})};calls.push({type:'save',profile:JSON.parse(options.body).profile,authorization:options.headers.Authorization});return {ok:!failSave,json:async()=>failSave?{error:'offline'}:{profile:{}}}}
  };
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
  runInNewContext(source+`\nthis.driver={start:(client)=>{supabaseClient=client;session={access_token:'test.token',user:{id:'user-1'}};loadedAccountId='user-1'},setMovie:()=>{profile.watched=[{id:42,title:'Saved movie',genre_ids:[18]}];profile.ratings={42:1};persist()},setGuest:(owner='')=>{session=null;loadedAccountId=null;profileOwner=owner;profile=blank();profile.saved=[{id:7,title:'Browser movie'}];persist()},setGuestStar:()=>{session=null;loadedAccountId=null;profileOwner='';profile=blank();profile.ratings={7:-1};setStarRating({id:7,title:'Browser movie',genre_ids:[18]},4,'watched')},rateGuestStar:n=>setStarRating({id:7,title:'Browser movie',genre_ids:[18]},n,'watched'),loadAccount:async()=>{session={access_token:'test.token',user:{id:'user-1'}};await updateAccount()},snapshot:()=>JSON.stringify(profile),signOut:()=>signOutAccount(),idleSignOut:()=>signOutAccount({idle:true}),idleWithoutClient:()=>{supabaseClient=null;return signOutAccount({idle:true})},initAuth:()=>{session=null;loadedAccountId=null;config={authConfigured:true,supabaseUrl:'https://example.test',supabaseAnonKey:'public'};return authInit()},remoteSignOut:()=>supabaseClient.auth.callback('SIGNED_OUT',null),login:()=>login('google')};`,context);
  context.driver.start(client);
  return {driver:context.driver,calls,elements,storage};
}

test('sign-out saves pending ratings, signs out locally, and requests a Google account choice',async()=>{
  const {driver,calls,storage}=createHarness();
  driver.setMovie();
  await driver.signOut();
  assert.deepEqual(calls.map(call=>call.type),['save','signOut']);
  assert.equal(calls[0].profile.watched[0].title,'Saved movie');
  assert.equal(calls[0].profile.ratings['42'],1);
  assert.equal(calls[0].authorization,'Bearer test.token');
  assert.equal(calls[1].scope,'local');
  assert.equal(storage.has('nextthree.profile.v1'),false);
  await driver.login();
  assert.equal(calls[2].options.provider,'google');
  assert.equal(calls[2].options.options.queryParams.prompt,'select_account');
});

test('failed profile saving keeps the local movie and does not falsely complete sign-out',async()=>{
  const {driver,calls,elements,storage}=createHarness({failSave:true});
  driver.setMovie();
  await driver.signOut();
  assert.deepEqual(calls.map(call=>call.type),['save']);
  assert.equal(JSON.parse(storage.get('nextthree.profile.v1')).watched[0].title,'Saved movie');
  assert.match(elements.get('configWarning').textContent,/Could not finish signing out/);
});

test('movies saved as a guest merge into an existing account without duplicates',async()=>{
  const remoteProfile={watched:[],saved:[{id:8,title:'Account movie'}],ratings:{}};
  const {driver,calls}=createHarness({remoteProfile});driver.setGuest();await driver.loadAccount();
  const profile=JSON.parse(driver.snapshot());
  assert.deepEqual(profile.saved.map(movie=>movie.id),[8,7]);
  await driver.signOut();
  assert.deepEqual(calls[0].profile.saved.map(movie=>movie.id),[8,7]);
  const duplicate=createHarness({remoteProfile:{watched:[],saved:[{id:7,title:'Browser movie'}],ratings:{}}});
  duplicate.driver.setGuest();await duplicate.driver.loadAccount();
  assert.deepEqual(JSON.parse(duplicate.driver.snapshot()).saved.map(movie=>movie.id),[7]);
});

test('a different account does not inherit the prior account’s cached watchlist',async()=>{
  const {driver}=createHarness({remoteProfile:{watched:[],saved:[{id:8,title:'Account movie'}],ratings:{}}});
  driver.setGuest('different-user');await driver.loadAccount();
  assert.deepEqual(JSON.parse(driver.snapshot()).saved.map(movie=>movie.id),[8]);
});

test('star ratings mark a film watched, replace its old thumb, and can be cleared',()=>{
  const {driver}=createHarness();driver.setGuestStar();
  let profile=JSON.parse(driver.snapshot());
  assert.equal(profile.watched[0].id,7);assert.equal(profile.starRatings['7'],4);assert.equal(profile.ratings['7'],undefined);
  driver.rateGuestStar(4);profile=JSON.parse(driver.snapshot());
  assert.equal(profile.starRatings['7'],undefined);assert.equal(profile.watched[0].id,7);
  driver.rateGuestStar(1);profile=JSON.parse(driver.snapshot());assert.equal(profile.starRatings['7'],1);
});

test('guest star ratings and watched movies merge into an existing account',async()=>{
  const remoteProfile={watched:[{id:8,title:'Account movie'}],saved:[],ratings:{8:1},starRatings:{8:5}};
  const {driver,calls}=createHarness({remoteProfile});driver.setGuestStar();await driver.loadAccount();
  const profile=JSON.parse(driver.snapshot());
  assert.deepEqual(profile.watched.map(movie=>movie.id),[8,7]);assert.deepEqual(profile.starRatings,{7:4,8:5});
  await driver.signOut();assert.deepEqual(calls[0].profile.starRatings,{7:4,8:5});
});



test('idle timeout signs out even when saving fails and preserves unsynced choices',async()=>{
  const {driver,calls,storage}=createHarness({failSave:true});driver.setMovie();await driver.idleSignOut();
  assert.deepEqual(calls.map(call=>call.type),['save','signOut']);
  assert.equal(calls[1].scope,'local');
  assert.equal(JSON.parse(storage.get('nextthree.unsynced.v1.user-1')).watched[0].title,'Saved movie');
  assert.equal(JSON.parse(driver.snapshot()).watched.length,0);
});

test('unsynced choices are recovered only for their owner on next sign-in',async()=>{
  const {driver,calls,storage}=createHarness({remoteProfile:{watched:[{id:8,title:'Account movie'}],saved:[],ratings:{}}});
  driver.setGuest();storage.set('nextthree.unsynced.v1.user-1',JSON.stringify({watched:[{id:42,title:'Offline movie'}],saved:[],ratings:{42:1}}));
  await driver.loadAccount();const profile=JSON.parse(driver.snapshot());
  assert.ok(profile.watched.some(movie=>movie.id===42));assert.ok(profile.watched.some(movie=>movie.id===8));
  await driver.signOut();assert.ok(calls[0].profile.watched.some(movie=>movie.id===42));
  assert.equal(storage.has('nextthree.unsynced.v1.user-1'),false);
});

test('inactivity tracker respects activity in another tab and expires on return',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function createIdleTracker('),source.indexOf('const idleTracker='));
  const store=new Map(),storage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)};let now=1000,expired=0;
  const context={localStorage:storage,IDLE_PREFIX:'idle.',IDLE_LIMIT:300000,Date:{now:()=>now},setTimeout:()=>1,clearTimeout:()=>{}};
  runInNewContext(code+'\nthis.make=createIdleTracker;',context);
  const first=context.make(()=>expired++),second=context.make(()=>expired++);
  assert.equal(first.start('user-1'),true);assert.equal(second.start('user-1'),true);
  now+=240000;first.activity();now+=60001;assert.equal(second.check(),true);assert.equal(expired,0);
  now+=240000;assert.equal(second.check(),false);assert.equal(expired,1);
  second.activity();assert.equal(expired,1);
  const restored=context.make(()=>expired++);assert.equal(restored.start('user-1'),false);assert.equal(expired,2);
});


test('an expired stored session signs out before loading the account on reopening',async()=>{
  const {driver,calls,storage}=createHarness();storage.set('nextthree.idle.v1.user-1',String(Date.now()-300001));
  await driver.initAuth();assert.deepEqual(calls.map(call=>call.type),['signOut']);assert.equal(calls[0].scope,'local');
  assert.equal(JSON.parse(driver.snapshot()).watched.length,0);
});

test('a sign-out from another tab clears the account view and preserves pending changes',async()=>{
  const {driver,storage}=createHarness();await driver.initAuth();driver.setMovie();driver.remoteSignOut();
  assert.equal(JSON.parse(driver.snapshot()).watched.length,0);
  assert.equal(JSON.parse(storage.get('nextthree.unsynced.v1.user-1')).watched[0].title,'Saved movie');
});

test('an interaction after the idle deadline is blocked before it reaches the page',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function startIdleEvents()'),source.indexOf('function clearAccountView()'));
  const handlers={},tracker={check:()=>false,activity:()=>{throw new Error('expired activity was recorded')},key:()=>''};
  const context={document:{addEventListener:(name,handler,options)=>{handlers[name]={handler,options}}},window:{addEventListener(){}},session:{user:{id:'user-1'}},signingOut:false,idleSignOutPromise:null,idleTracker:tracker};
  runInNewContext(code+'\nthis.start=startIdleEvents;',context);context.start();
  let prevented=false,stopped=false;handlers.pointerdown.handler({cancelable:true,preventDefault:()=>{prevented=true},stopImmediatePropagation:()=>{stopped=true}});
  assert.equal(handlers.pointerdown.options.capture,true);assert.equal(prevented,true);assert.equal(stopped,true);
});


test('idle lock clears the account view if the authentication service is unavailable',async()=>{
  const {driver,elements}=createHarness();driver.setMovie();await driver.idleWithoutClient();
  assert.equal(JSON.parse(driver.snapshot()).watched.length,0);
  assert.match(elements.get('configWarning').textContent,/session was locked/);
});
