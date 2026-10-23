const assert=require('assert'), path=require('path');
const ROOT=path.resolve(__dirname,'..','netlify','functions');
process.env.SESSION_SECRET='link-secret';
process.env.FIREBASE_CLIENT_EMAIL='fake@test.invalid';
process.env.FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';
process.env.FIREBASE_WEB_API_KEY='fake-web';
const tokens=require(path.join(ROOT,'session-token.js'));
let checks=0; const ok=(v,m)=>{assert.ok(v,m);checks++;console.log('✅',m)}; const eq=(a,b,m)=>{assert.deepStrictEqual(a,b,m);checks++;console.log('✅',m)};
function resp(status,data,headers={}){return {ok:status>=200&&status<300,status,headers:{get:(k)=>headers[String(k).toLowerCase()]??headers[k]??null},async json(){return data;},async text(){return typeof data==='string'?data:JSON.stringify(data)}}}
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports}}
function fresh(file){const id=require.resolve(file);delete require.cache[id];return require(file)}
const permPath=path.join(ROOT,'permissions.js'), firePath=path.join(ROOT,'firebase-token.js'), logsPath=path.join(ROOT,'logs.js'), closePath=path.join(ROOT,'activite-close.js');
const actualPerms=fresh(permPath);
mock(firePath,{createFirebaseCustomToken:()=> 'custom'});
mock(logsPath,{logAction:async()=>({ok:true})});
mock(permPath,{...actualPerms,can:()=>true,canFor:async()=>true,loadPermissionContext:async()=>({custom:null,individual:null}),resolveIndividualDecision:()=>null});
let closeCalls=[];
mock(closePath,{closeActiviteWeekServer:async(args)=>{closeCalls.push(args);return {status:200,body:{ok:true,closed:true}}}});

const BASE='https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app';
const store={
  '/rosterEmsData.json':{employees:[
    {id:'1',idUnique:'101',name:'Djam Mas',discordId:'111111111111111111',grade:'RF',role:'',licencie:false},
    {id:'2',idUnique:'102',name:'Lea Salvatore',discordId:'222222222222222222',grade:'A',role:'',licencie:false},
    {id:'3',idUnique:'103',name:'BNVL Test',discordId:'333333333333333333',grade:'A',role:'',licencie:false},
  ],savedAt:Date.now()},
  '/discordIdsList.json':{text:'Employés: 999999999999999999',savedAt:Date.now()},
  '/rosterPillboxSyncMeta.json':null,
  '/activiteSuivi.json':{data:{},savedAt:Date.now()},
  '/rosterAbsences.json':null,
  '/rosterAbsenceAlertDecisions.json':null,
  '/rosterAnimPrefs/111111111111111111.json':{enabled:true,lockedByOwner:false},
  '/formationOperationList.json':null,
  '/pillboxWeekHistory.json':{},
  '/signalements.json':null,
  '/signalements_test.json':null,
  '/payRulesConfig.json':null,
  '/pillboxLiveUpSessions.json':{},
};
function urlPath(u){const x=new URL(String(u));return x.pathname.replace(/^\//,'/');}
let fetchLog=[];
global.fetch=async(url,opt={})=>{
  url=String(url); const method=opt.method||'GET'; fetchLog.push({url,method});
  if(url.includes('identitytoolkit.googleapis.com')) return resp(200,{idToken:'idtoken'});
  const p=urlPath(url);
  if(method==='GET'){
    // specific child week/live paths
    if(p.startsWith('/pillboxWeekHistory/') && p.endsWith('.json')){
      const key=p.slice('/pillboxWeekHistory/'.length,-5); return resp(200,store[`/pillboxWeekHistory/${key}.json`]??null);
    }
    if(p.startsWith('/pillboxLiveUpDecisions/')) return resp(200,null);
    return resp(200,store[p]??null);
  }
  if(method==='PUT' || method==='PATCH'){
    const data=JSON.parse(opt.body||'null');
    store[p]=data; return resp(200,data);
  }
  if(method==='DELETE'){delete store[p];return resp(200,null)}
  throw new Error(`unexpected ${method} ${url}`);
};

(async()=>{
  const rosterToken=tokens.sign({discordId:'111111111111111111',name:'Djam Mas',level:'ADD',origin:'roster',exp:Date.now()+600000},process.env.SESSION_SECRET);
  let protectedWrite=fresh(path.join(ROOT,'protected-write.js'));
  // Roster -> Pillbox: IDs/roles sync.
  let out=await protectedWrite.handler({httpMethod:'POST',body:JSON.stringify({token:rosterToken,action:'syncPillboxRoster',payload:{text:'Djam Mas: 111111111111111111\nLea Salvatore: 222222222222222222\nEmployés: 999999999999999999',employeeCount:3}})});
  eq(out.statusCode,200,'Roster synchronizes IDs/roles to Pillbox backend');
  ok(store['/discordIdsList.json'].text.includes('Employés: 999999999999999999'),'role reference survives Roster→Pillbox sync');
  ok(store['/rosterPillboxSyncMeta.json'].employeeCount===3,'Roster→Pillbox sync metadata records employee count');

  protectedWrite=fresh(path.join(ROOT,'protected-write.js'));
  out=await protectedWrite.handler({httpMethod:'POST',body:JSON.stringify({token:rosterToken,action:'syncFormationOperation',payload:{text:'Lea Salvatore'}})});
  eq(out.statusCode,200,'Roster synchronizes Formation Opération to Pillbox backend');
  eq(store['/formationOperationList.json'].text,'Lea Salvatore','Formation Opération cloud value is exact');

  const pillToken=tokens.sign({discordId:'111111111111111111',name:'Djam Mas',level:'ADD',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  let proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  out=await proxy.handler({httpMethod:'GET',headers:{'x-pillbox-session':pillToken},queryStringParameters:{}});
  eq(out.statusCode,200,'Pillbox can read synchronized Roster cloud state');
  let data=JSON.parse(out.body);
  eq(data.roster.employees.length,3,'Pillbox receives all active Roster employees');
  ok(data.discordIds.text.includes('Djam Mas: 111111111111111111'),'Pillbox rebuilds player Discord pings from Roster employees');
  ok(data.discordIds.text.includes('Employés: 999999999999999999'),'Pillbox keeps synced role ping reference');
  eq(data.formationOperation.text,'Lea Salvatore','Pillbox receives the Roster Formation Opération list');
  eq(data.animEnabled,true,'Pillbox receives shared Roster animation preference');

  // Lightweight pre-analysis history path: only the requested week is read after auth/permissions.
  fetchLog=[]; proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':pillToken},body:JSON.stringify({action:'getWeekHistoryEntry',weekKey:'2026-10-17'})});
  eq(out.statusCode,200,'Fast pre-analysis history endpoint succeeds');
  data=JSON.parse(out.body); eq(data.state,'absent','Fast pre-analysis history reports untreated week as absent');
  const firebaseReads=fetchLog.filter(x=>x.method==='GET'&&x.url.includes('firebasedatabase.app'));
  eq(firebaseReads.length,1,'Fast pre-analysis check reads only one Firebase data path');
  ok(firebaseReads[0].url.includes('/pillboxWeekHistory/2026-10-17.json'),'Fast pre-analysis check reads only current week history');

  store['/pillboxWeekHistory/2026-10-17.json']={processedAt:Date.now(),summary:{totalPaye:123}};
  fetchLog=[]; proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':pillToken},body:JSON.stringify({action:'getWeekHistoryEntry',weekKey:'2026-10-17'})});
  data=JSON.parse(out.body); eq(data.state,'found','Fast history endpoint detects already-treated week');
  eq(data.entry.summary.totalPaye,123,'Fast history endpoint returns exact current-week summary');

  // Pillbox live state -> cloud every polling tick.
  proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':pillToken},body:JSON.stringify({action:'pushLiveUpSession',weekKey:'2026-10-17',entries:[{category:'Promotion',employeeKey:'id:102',sentence:'Lea Salvatore est éligible',details:'A → INF',decided:null}]})});
  eq(out.statusCode,200,'Pillbox publishes live weekly decision state');
  const live=store['/pillboxLiveUpSessions/2026-10-17.json'];
  eq(live.operatorName,'Djam Mas','live session identifies current pay operator');
  eq(live.entries[0].employeeKey,'id:102','live session contains exact employee decision');

  // End of week -> Roster activity closure bridge.
  proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':pillToken},body:JSON.stringify({action:'weekFinished',weekKey:'2026-10-17',weekEndMs:Date.now(),absentIds:[],absentNames:[]})});
  eq(out.statusCode,200,'Pillbox end-of-week signal reaches Roster backend bridge');
  eq(closeCalls.length,1,'Roster activity closure is called exactly once');
  eq(closeCalls[0].weekKey,'2026-10-17','Roster closure receives the exact processed week');

  console.log(`✅ Roster↔Pillbox weekly integration: ${checks} checks passed`);
})().catch(e=>{console.error(e);process.exit(1)});
