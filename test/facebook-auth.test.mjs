import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function createHarness({settingsFetch,oauthError=null}={}) {
  const elements=new Map(),calls=[];
  const element=()=>({
    value:'',textContent:'',hidden:false,disabled:false,dataset:{},style:{},
    addEventListener(){},setAttribute(){},replaceChildren(){},append(){},
    querySelectorAll(){return []},focus(){},showModal(){},close(){}
  });
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element,querySelectorAll(){return []}};
  document.getElementById('facebookLogin').disabled=true;
  const localStorage={getItem(){return null},setItem(){},removeItem(){}};
  const client={auth:{
    async getSession(){return {data:{session:null}}},
    onAuthStateChange(){},
    async signInWithOAuth(options){calls.push(options);return {error:oauthError}}
  }};
  const requests=[];
  const context={document,localStorage,window:{supabase:{createClient:()=>client}},location:{origin:'https://movies.example'},URL,
    setTimeout(){return 1},clearTimeout(){},
    fetch:async(url,options)=>{requests.push({url:String(url),options});return settingsFetch()}
  };
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
  runInNewContext(source+`\nthis.driver={initialize:()=>{config={authConfigured:true,supabaseUrl:'https://project.supabase.co',supabaseAnonKey:'public-key'};return authInit()},refresh:()=>updateFacebookAvailability(),loginGoogle:()=>login('google')};`,context);
  return {driver:context.driver,elements,calls,requests};
}

const response=facebook=>({ok:true,json:async()=>({external:{facebook}})});

test('an enabled Facebook provider offers login and starts the OAuth flow',async()=>{
  const {driver,elements,calls,requests}=createHarness({settingsFetch:async()=>response(true)});
  await driver.initialize();
  await driver.refresh();
  assert.equal(elements.get('facebookLogin').disabled,false);
  assert.equal(elements.get('facebookUnavailable').hidden,true);
  assert.equal(requests[0].url,'https://project.supabase.co/auth/v1/settings');
  assert.equal(requests[0].options.headers.apikey,'public-key');
  await elements.get('facebookLogin').onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].provider,'facebook');
  assert.equal(calls[0].options.redirectTo,'https://movies.example/');
});

test('a disabled provider cannot start Facebook login',async()=>{
  const {driver,elements,calls}=createHarness({settingsFetch:async()=>response(false)});
  await driver.initialize();
  await driver.refresh();
  assert.equal(elements.get('facebookLogin').disabled,true);
  assert.equal(elements.get('facebookUnavailable').hidden,false);
  await elements.get('facebookLogin').onclick();
  assert.equal(calls.length,0);
});

test('a failed provider check keeps Facebook unavailable without blocking Google',async()=>{
  const {driver,elements,calls}=createHarness({settingsFetch:async()=>{throw new Error('offline')}});
  await driver.initialize();
  await driver.refresh();
  assert.equal(elements.get('facebookLogin').disabled,true);
  assert.match(elements.get('facebookUnavailable').textContent,/temporarily unavailable/);
  await driver.loginGoogle();
  assert.equal(calls[0].provider,'google');
});

test('Facebook OAuth errors are shown to the user',async()=>{
  const {driver,elements}=createHarness({settingsFetch:async()=>response(true),oauthError:{message:'Please try again later.'}});
  await driver.initialize();
  await driver.refresh();
  await elements.get('facebookLogin').onclick();
  assert.match(elements.get('authNote').textContent,/Could not sign in/);
});

test('an older provider response cannot overwrite a more recent check',async()=>{
  const pending=[];
  const {driver,elements}=createHarness({settingsFetch:()=>new Promise(resolve=>pending.push(resolve))});
  await driver.initialize();
  const newer=driver.refresh();
  pending[1](response(true));
  await newer;
  pending[0](response(false));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('facebookLogin').disabled,false);
});
