const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const proxyModule = require(path.join(ROOT, 'netlify/functions/pillbox-proxy.js'));
const signalementModule = require(path.join(ROOT, 'netlify/functions/signalement-actions.js'));
const { sign } = require(path.join(ROOT, 'netlify/functions/session-token.js'));

const t = proxyModule._test;

function fakeResponse(status, data, extraHeaders={}){
  const headersMap = new Map(Object.entries(extraHeaders).map(([k,v])=>[k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get(name){ return headersMap.get(String(name).toLowerCase()) || null; } },
    async json(){ return data; },
    async text(){ return typeof data === 'string' ? data : JSON.stringify(data); },
    clone(){ return this; },
  };
}

function setupEnv(secret){
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.SESSION_SECRET = secret;
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({type:'pkcs8',format:'pem'});
  process.env.FIREBASE_WEB_API_KEY = 'fake-web-key';
}

function token(level, secret, id=`id-${level}`){
  return sign({discordId:id,name:`Test ${level}`,level,exp:Date.now()+60_000}, secret);
}

function commonPermissionFetch(url){
  const u=String(url);
  if(u.includes('identitytoolkit.googleapis.com')) return fakeResponse(200,{idToken:'firebase-id-token'});
  if(u.includes('/rosterPermissionsOverride.json')) return fakeResponse(200,null);
  if(u.includes('/rosterIndividualPermissions.json')) return fakeResponse(200,null);
  return null;
}

async function testPersistentCounter(){
  let stored = null;
  let etagN = 1;
  let puts = 0;
  const oldFetch = global.fetch;
  global.fetch = async (url, opts={})=>{
    if(opts.method === 'PUT'){
      const ifMatch = opts.headers && (opts.headers['if-match'] || opts.headers['If-Match']);
      const currentEtag = `\"${etagN}\"`;
      if(ifMatch && ifMatch !== currentEtag) return fakeResponse(412, {error:'etag mismatch'}, {etag:currentEtag});
      stored = JSON.parse(opts.body);
      puts++;
      etagN++;
      return fakeResponse(200, stored, {etag:`\"${etagN}\"`});
    }
    return fakeResponse(200, stored, {etag:`\"${etagN}\"`});
  };
  try{
    const url = 'https://example.test/state.json?auth=test';
    const first = await t.ensureAutomaticSignalementState(url, ()=>0.8); // => 3
    assert.strictEqual(first.state.nextAutomaticReportIn, 3);
    const second = await t.ensureAutomaticSignalementState(url, ()=>0.0); // ne doit PAS reroll à 1
    assert.strictEqual(second.state.nextAutomaticReportIn, 3);
    assert.strictEqual(puts, 1, 'un rechargement ne doit pas réinitialiser/réécrire le compteur');
  } finally { global.fetch = oldFetch; }
}

function testEligibleGradesAndWeightedRandom(){
  const roster = {employees:[
    {id:'mf',name:'MF',grade:'MF',licencie:false},
    {id:'mp',name:'MP',grade:'MP',licencie:false},
    {id:'mlp',name:'MLP',grade:'MLP',licencie:false},
    {id:'rf',name:'RF',grade:'RF',licencie:false},
    {id:'rp',name:'RP',grade:'RP',licencie:false},
    {id:'rl',name:'RL',grade:'RL',licencie:false},
    {id:'mc',name:'MC',grade:'MC',licencie:false},
    {id:'add',name:'ADD',grade:'ADD',licencie:false},
    {id:'m',name:'M',grade:'M',licencie:false},
    {id:'cd',name:'CD',grade:'CD',licencie:false},
    {id:'fired',name:'Fired',grade:'MC',licencie:true},
  ]};
  const eligible = t.automaticSignalementEligibleEmployees(roster);
  assert.deepStrictEqual(eligible.map(e=>e.personGrade), ['MF','MP','MLP','RF','RP','RL','MC','ADD']);

  const pool = [
    {employeeKey:'a',personName:'A'},
    {employeeKey:'b',personName:'B'},
    {employeeKey:'c',personName:'C'},
  ];
  const avoided = t.chooseWeightedAutomaticSignalementEmployee(pool, ['a'], ()=>0.5);
  assert.strictEqual(avoided.employeeKey, 'b', 'le dernier tiré doit être fortement défavorisé');
  const stillPossible = t.chooseWeightedAutomaticSignalementEmployee(pool, ['a'], ()=>0.01);
  assert.strictEqual(stillPossible.employeeKey, 'a', 'le dernier tiré doit rester possible');
}

function testManualCandidatePriority(){
  const eligible = [
    {employeeKey:'roster:1',personId:'101',personName:'Alpha',personGrade:'MF'},
    {employeeKey:'roster:2',personId:'102',personName:'Bravo',personGrade:'MC'},
  ];
  const now = Date.now();
  const signalements = {
    automatic:{personId:'101',personName:'Alpha',source:'automatic_payroll_check',createdAt:now+500},
    deferred:{personId:'102',personName:'Bravo',createdAt:now+400,deferredUntil:now+60_000},
    oldManual:{personId:'101',personName:'Alpha',createdAt:now+100},
    newestManual:{personId:'102',personName:'Bravo',createdAt:now+300},
  };
  let found = t.findExistingManualSignalementForPayroll(signalements, eligible, [], now);
  assert.strictEqual(found.key,'newestManual','le plus récent signalement manuel éligible doit passer avant le hasard');

  found = t.findExistingManualSignalementForPayroll(signalements, eligible, ['newestManual'], now);
  assert.strictEqual(found.key,'oldManual','une clé manuelle déjà utilisée ne doit pas être consommée deux fois');
}

async function testPillboxManualSelectionRemovedServerSide(){
  const secret='test-secret-manual-removed';
  setupEnv(secret);
  const oldFetch = global.fetch;
  global.fetch = async (url)=>{
    const common=commonPermissionFetch(url);
    if(common) return common;
    throw new Error(`fetch inattendu pendant test suppression choix manuel: ${url}`);
  };
  try{
    for(const level of ['ADD','CD','D','DG','OWNER']){
      const res = await proxyModule.handler({
        httpMethod:'POST',
        headers:{'x-pillbox-session':token(level,secret)},
        body:JSON.stringify({
          action:'processAutomaticPayrollSignalementOnAnalysis',
          weekKey:'2026-10-31',
          selectionMethod:'owner_selected',
          selectedEmployeeKey:'roster:target',
        }),
      });
      assert.strictEqual(res.statusCode,403,`${level} ne doit plus pouvoir choisir une cible depuis Pillbox`);
      assert.match(JSON.parse(res.body).error,/Roster/i);
    }
  } finally { global.fetch = oldFetch; }
}


async function testAnalyzeCounterIsIdempotentPerWeek(){
  const secret='test-secret-idempotent-analyze';
  setupEnv(secret);
  let state={version:1,nextAutomaticReportIn:3,recentRandomEmployeeKeys:[],usedManualSignalementKeys:[],weeks:{}};
  let etag='"1"';
  let statePuts=0;
  const oldFetch=global.fetch;
  global.fetch=async (url,opts={})=>{
    const common=commonPermissionFetch(url);
    if(common) return common;
    const u=String(url);
    if(u.includes('/pillboxWeekHistoryArchive/__automaticPayrollSignalement/production/state.json')){
      if(opts.method==='PUT'){
        state=JSON.parse(opts.body); statePuts++; etag=`"${statePuts+1}"`;
        return fakeResponse(200,state,{etag});
      }
      return fakeResponse(200,state,{etag});
    }
    throw new Error(`fetch inattendu pendant test idempotence analyse: ${url}`);
  };
  try{
    const req=()=>proxyModule.handler({
      httpMethod:'POST',headers:{'x-pillbox-session':token('ADD',secret)},
      body:JSON.stringify({action:'processAutomaticPayrollSignalementOnAnalysis',weekKey:'2026-10-31'}),
    });
    const first=await req();
    assert.strictEqual(first.statusCode,200,first.body);
    assert.strictEqual(state.nextAutomaticReportIn,2,'le premier clic Analyser doit décrémenter 3→2');
    assert.strictEqual(statePuts,1);
    const second=await req();
    assert.strictEqual(second.statusCode,200,second.body);
    assert.strictEqual(state.nextAutomaticReportIn,2,'recliquer sur la même semaine ne doit pas décrémenter une deuxième fois');
    assert.strictEqual(statePuts,1,'la même semaine déjà traitée ne doit pas réécrire le compteur');
  } finally { global.fetch=oldFetch; }
}

async function testExistingRosterSignalementWins(){
  const secret='test-secret-manual-wins';
  setupEnv(secret);
  let state = {version:1,nextAutomaticReportIn:1,recentRandomEmployeeKeys:[],usedManualSignalementKeys:[],weeks:{}};
  let etag='\"1\"';
  let automaticWriteCount=0;
  const oldFetch=global.fetch;
  global.fetch=async (url,opts={})=>{
    const common=commonPermissionFetch(url);
    if(common) return common;
    const u=String(url);
    if(u.includes('/rosterEmsData.json')) return fakeResponse(200,{employees:[
      {id:'a',idUnique:'101',name:'Alpha',grade:'MF',licencie:false},
      {id:'b',idUnique:'102',name:'Bravo',grade:'MC',licencie:false},
    ]});
    if(u.includes('/signalements.json') && !u.includes('/automatic-payroll-')){
      return fakeResponse(200,{
        'manual-1':{personName:'Bravo',personId:'102',personGrade:'MC',category:'comportement',reason:'À discuter',createdAt:Date.now()},
      });
    }
    if(u.includes('/pillboxWeekHistoryArchive/__automaticPayrollSignalement/production/state.json')){
      if(opts.method==='PUT'){
        state=JSON.parse(opts.body); etag='\"2\"'; return fakeResponse(200,state,{etag});
      }
      return fakeResponse(200,state,{etag});
    }
    if(u.includes('/automatic-payroll-')){ automaticWriteCount++; return fakeResponse(200,{}); }
    if(u.includes('/rosterLogs/')) return fakeResponse(200,{});
    throw new Error(`fetch inattendu pendant test priorité manuel: ${url}`);
  };
  try{
    const res=await proxyModule.handler({
      httpMethod:'POST',headers:{'x-pillbox-session':token('ADD',secret)},
      body:JSON.stringify({action:'processAutomaticPayrollSignalementOnAnalysis',weekKey:'2026-10-31'}),
    });
    assert.strictEqual(res.statusCode,200,res.body);
    const out=JSON.parse(res.body);
    assert.strictEqual(out.created,false);
    assert.strictEqual(out.usedExistingManual,true);
    assert.strictEqual(out.signalementKey,'manual-1');
    assert.strictEqual(out.personName,'Bravo');
    assert.strictEqual(automaticWriteCount,0,'aucun signalement automatique ne doit être créé si un manuel du Roster est retenu');
    assert.strictEqual(state.weeks['2026-10-31'].status,'manual_existing');
    assert.ok(state.usedManualSignalementKeys.includes('manual-1'));
    assert.ok(state.nextAutomaticReportIn>=1 && state.nextAutomaticReportIn<=3);
  } finally { global.fetch=oldFetch; }
}

async function testFullAutomaticCreationWhenNoManual(){
  const secret='test-secret-full-create';
  setupEnv(secret);

  let state = {version:1,nextAutomaticReportIn:1,recentRandomEmployeeKeys:['roster:a'],usedManualSignalementKeys:[],weeks:{}};
  let etag = '\"1\"';
  let createdSignalement = null;
  const oldFetch = global.fetch;
  const oldRandom = Math.random;
  Math.random = ()=>0.5;
  global.fetch = async (url, opts={})=>{
    const common=commonPermissionFetch(url);
    if(common) return common;
    const u=String(url);
    if(u.includes('/rosterEmsData.json')) return fakeResponse(200,{employees:[
      {id:'a',idUnique:'101',name:'Alpha',grade:'MC',licencie:false},
      {id:'b',idUnique:'102',name:'Bravo',grade:'MF',licencie:false},
      {id:'c',idUnique:'103',name:'Charlie',grade:'CD',licencie:false},
    ]});
    if(u.includes('/signalements.json') && !u.includes('/automatic-payroll-')) return fakeResponse(200,{});
    if(u.includes('/pillboxWeekHistoryArchive/__automaticPayrollSignalement/production/state.json')){
      if(opts.method === 'PUT'){
        state = JSON.parse(opts.body); etag='\"2\"'; return fakeResponse(200,state,{etag});
      }
      return fakeResponse(200,state,{etag});
    }
    if(u.includes('/pillboxWeekHistoryArchive/__automaticPayrollSignalement/production/state/weeks/2026-10-31.json')){
      const week = JSON.parse(opts.body); state.weeks['2026-10-31']=week; return fakeResponse(200,week);
    }
    if(u.includes('/signalements/automatic-payroll-2026-10-31.json')){
      createdSignalement = JSON.parse(opts.body); return fakeResponse(200,createdSignalement);
    }
    if(u.includes('/rosterLogs/')) return fakeResponse(200,{name:'log'});
    throw new Error(`fetch inattendu pendant test création: ${url}`);
  };
  try{
    const res = await proxyModule.handler({
      httpMethod:'POST', headers:{'x-pillbox-session':token('ADD',secret,'add-user')},
      body:JSON.stringify({action:'processAutomaticPayrollSignalementOnAnalysis',weekKey:'2026-10-31'}),
    });
    assert.strictEqual(res.statusCode,200, res.body);
    const out=JSON.parse(res.body);
    assert.strictEqual(out.created,true);
    assert.strictEqual(out.usedExistingManual,false);
    assert.strictEqual(out.personName,'Bravo','Alpha, dernier tiré, doit être défavorisé avec ce RNG');
    assert.ok(createdSignalement);
    assert.strictEqual(createdSignalement.source,'automatic_payroll_check');
    assert.strictEqual(createdSignalement.category,'autre');
    assert.strictEqual(createdSignalement.reason,'Signalement automatique pour discuter avec cette personne.');
    assert.strictEqual(createdSignalement.personGrade,'MF');
    assert.strictEqual(createdSignalement.selectionMethod,'random');
    assert.ok(!('selectedBy' in createdSignalement));
    assert.strictEqual(state.weeks['2026-10-31'].status,'created');
  } finally { global.fetch = oldFetch; Math.random = oldRandom; }
}

async function testListSignalementsFilteringThroughHandler(){
  const secret='test-secret-list-filter';
  setupEnv(secret);
  const raw = {
    one:{personName:'Test',personId:'1',personGrade:'MC',category:'autre',reason:'Signalement automatique pour discuter avec cette personne.',createdAt:Date.now(),source:'automatic_payroll_check',selectionMethod:'random',selectedBy:'legacy-private-value'}
  };
  const oldFetch = global.fetch;
  global.fetch = async (url)=>{
    const u=String(url);
    if(u.includes('identitytoolkit.googleapis.com')) return fakeResponse(200,{idToken:'firebase-id-token'});
    if(u.includes('/rosterPermissionsOverride.json')) return fakeResponse(200,null);
    if(u.includes('/rosterIndividualPermissions.json')) return fakeResponse(200,null);
    if(u.includes('/signalements.json')) return fakeResponse(200,raw);
    throw new Error(`fetch inattendu pendant test list: ${url}`);
  };
  try{
    const res = await signalementModule.handler({
      httpMethod:'POST',
      body:JSON.stringify({token:token('MC',secret,'mc-user'),action:'listSignalements',payload:{}}),
    });
    assert.strictEqual(res.statusCode,200);
    const data=JSON.parse(res.body).signalements.one;
    assert.strictEqual(data.source,'automatic_payroll_check');
    assert.ok(!Object.prototype.hasOwnProperty.call(data,'selectionMethod'));
    assert.ok(!Object.prototype.hasOwnProperty.call(data,'selectedBy'));
  } finally { global.fetch = oldFetch; }
}

function testPillboxUiMovedToAnalyze(){
  const html = fs.readFileSync(path.join(ROOT,'__pillbox_for_test.html'),'utf8');
  assert.ok(html.includes('processAutomaticPayrollSignalementOnAnalysis'), 'Pillbox doit appeler le nouveau flux au clic Analyser');
  assert.ok(!html.includes('chooseAutomaticPayrollSignalementMode'), 'la fenêtre de choix manuel Owner ne doit plus exister');
  assert.ok(!html.includes('automaticSignalementOwnerModal'), 'aucune modale de choix manuel ne doit rester');
  const analyzeStart = html.indexOf("document.getElementById('analyzeBtn').addEventListener('click'");
  const analyzeEnd = html.indexOf('function tryAutoImportFromHash', analyzeStart);
  const analyzeBlock = html.slice(analyzeStart, analyzeEnd);
  assert.ok(analyzeBlock.includes('processAutomaticPayrollSignalementAfterAnalysis(key)'), 'le signalement doit être traité depuis le flux Analyser');
  const finishStart = html.indexOf('if(action==="finishWeek")');
  const finishBlock = html.slice(finishStart, finishStart + 18000);
  assert.ok(!finishBlock.includes('finalizeAutomaticPayrollSignalement'), 'la clôture ne doit plus tirer/créer le signalement');
}

(async()=>{
  await testPersistentCounter();
  testEligibleGradesAndWeightedRandom();
  testManualCandidatePriority();
  await testPillboxManualSelectionRemovedServerSide();
  await testAnalyzeCounterIsIdempotentPerWeek();
  await testExistingRosterSignalementWins();
  await testFullAutomaticCreationWhenNoManual();
  await testListSignalementsFilteringThroughHandler();
  testPillboxUiMovedToAnalyze();
  console.log('OK 9/9 — automatic payroll signalement tests passed');
})().catch(err=>{
  console.error(err);
  process.exit(1);
});
