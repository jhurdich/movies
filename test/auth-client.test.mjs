import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function createHarness({failSave=false}={}) {
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
    async signInWithOAuth(options){calls.push({type:'login',options});return {error:null}}
  }};
  const context={document,localStorage,window:{},location:{origin:'https://example.test'},URL,
    setTimeout(){return 1},clearTimeout(){},
    async fetch(_path,options){calls.push({type:'save',profile:JSON.parse(options.body).profile,authorization:options.headers.Authorization});return {ok:!failSave,json:async()=>failSave?{error:'offline'}:{profile:{}}}}
  };
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
  runInNewContext(source+`\nthis.driver={start:(client)=>{supabaseClient=client;session={access_token:'test.token',user:{id:'user-1'}}},setMovie:()=>{profile.watched=[{id:42,title:'Saved movie',genre_ids:[18]}];profile.ratings={42:1};persist()},signOut:()=>signOutAccount(),login:()=>login('google')};`,context);
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
