const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname,'..','netlify','functions');
const sessionToken = require(path.join(ROOT,'session-token.js'));
process.env.SESSION_SECRET='test-secret-pillbox';
process.env.FIREBASE_CLIENT_EMAIL='x@test.invalid';
process.env.FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';
process.env.FIREBASE_WEB_API_KEY='fake-key';

let checks=0;
function eq(a,b,msg){assert.strictEqual(a,b,msg);checks++;}
function ok(v,msg){assert.ok(v,msg);checks++;}
function mockModule(file,exports){
  const id=require.resolve(file);
  require.cache[id]={id,filename:id,loaded:true,exports};
}
function fresh(file){ const id=require.resolve(file); delete require.cache[id]; return require(file); }
function resp(status,data){return {ok:status>=200&&status<300,status,async json(){return data;},async text(){return typeof data==='string'?data:JSON.stringify(data);}};}

(async()=>{
  const firebasePath=path.join(ROOT,'firebase-token.js');
  const permPath=path.join(ROOT,'permissions.js');
  const logsPath=path.join(ROOT,'logs.js');
  mockModule(firebasePath,{createFirebaseCustomToken:()=> 'custom'});
  let allow=true;
  mockModule(permPath,{
    can:()=>allow,
    loadPermissionContext:async()=>({custom:{},individual:{}}),
    resolveUserLevel:(id,grade)=> grade && ['MC','ADD','CD','D','DG'].includes(String(grade).toUpperCase()) ? String(grade).toUpperCase() : null,
  });
  mockModule(logsPath,{logAction:async()=>({ok:true})});

  const token=sessionToken.sign({discordId:'123456789',name:'Test',level:'ADD',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);

  // Delete: failed archive MUST prevent DELETE.
  let deleteCalled=false;
  global.fetch=async(url,opt={})=>{
    if(String(url).includes('identitytoolkit')) return resp(200,{idToken:'idtoken'});
    if(String(url).includes('pillboxWeekHistory/2026-10-17.json') && (!opt.method || opt.method==='GET')) return resp(200,{processedAt:1,summary:{}});
    if(String(url).includes('pillboxWeekHistoryArchive') && opt.method==='PUT') return resp(401,{error:'denied'});
    if(opt.method==='DELETE'){deleteCalled=true;return resp(200,{});}
    throw new Error('unexpected fetch delete test '+url+' '+(opt.method||'GET'));
  };
  const del=fresh(path.join(ROOT,'pillbox-delete-week.js'));
  let out=await del.handler({httpMethod:'POST',body:JSON.stringify({token,weekKey:'2026-10-17'})});
  eq(out.statusCode,502,'archive failure must return 502');
  eq(deleteCalled,false,'archive failure must not issue DELETE');

  // Reopen: failed PATCH MUST not return success.
  global.fetch=async(url,opt={})=>{
    if(String(url).includes('identitytoolkit')) return resp(200,{idToken:'idtoken'});
    if(String(url).includes('pillboxWeekHistory/2026-10-17.json') && (!opt.method || opt.method==='GET')) return resp(200,{processedAt:1,sessionSnapshot:{}});
    if(String(url).includes('pillboxWeekHistory/2026-10-17.json') && opt.method==='PATCH') return resp(401,{error:'denied'});
    throw new Error('unexpected fetch reopen test '+url+' '+(opt.method||'GET'));
  };
  const reopen=fresh(path.join(ROOT,'pillbox-reopen-week.js'));
  out=await reopen.handler({httpMethod:'POST',body:JSON.stringify({token,weekKey:'2026-10-17'})});
  eq(out.statusCode,502,'failed reopen PATCH must return 502');
  ok(JSON.parse(out.body).error.includes('Réouverture refusée'),'failed reopen exposes real failure');

  // Renew session: current roster grade replaces old token grade.
  global.fetch=async(url,opt={})=>{
    if(String(url).includes('identitytoolkit')) return resp(200,{idToken:'idtoken'});
    if(String(url).includes('rosterEmsData')) return resp(200,{employees:[{discordId:'123456789',name:'Test Renamed',grade:'MC',licencie:false}]});
    throw new Error('unexpected fetch renew '+url);
  };
  const renew=fresh(path.join(ROOT,'renew-session.js'));
  const old=sessionToken.sign({discordId:'123456789',name:'Old',level:'DG',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  out=await renew.handler({httpMethod:'POST',body:JSON.stringify({token:old,app:'pillbox'})});
  eq(out.statusCode,200,'renew succeeds with current roster access');
  const body=JSON.parse(out.body);
  eq(body.level,'MC','renew response uses current roster grade');
  eq(body.name,'Test Renamed','renew response uses current roster name');
  const renewed=sessionToken.verify(body.token,process.env.SESSION_SECRET);
  eq(renewed.level,'MC','renewed signed token contains current grade');
  eq(renewed.origin,'pillbox','renewed signed token preserves app origin');

  // Permission revoked at renewal => 403.
  allow=false;
  out=await renew.handler({httpMethod:'POST',body:JSON.stringify({token:old,app:'pillbox'})});
  eq(out.statusCode,403,'renew refuses a user whose Pillbox permission was revoked');

  console.log(`✅ Pillbox backend transactions: ${checks} checks passed`);
})().catch(e=>{console.error(e);process.exit(1);});
