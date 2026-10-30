const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const proxyModule = require(path.join(ROOT, 'netlify/functions/pillbox-proxy.js'));
const signalementModule = require(path.join(ROOT, 'netlify/functions/signalement-actions.js'));
const { sign } = require(path.join(ROOT, 'netlify/functions/session-token.js'));

const t = proxyModule._test;
const st = signalementModule._test;

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
    assert.strictEqual(puts, 1, 'le rechargement ne doit pas réinitialiser/réécrire le compteur');
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
  assert.strictEqual(avoided.employeeKey, 'b', 'le dernier tiré doit être fortement défavorisé dans ce tirage déterministe');
  const stillPossible = t.chooseWeightedAutomaticSignalementEmployee(pool, ['a'], ()=>0.01);
  assert.strictEqual(stillPossible.employeeKey, 'a', 'le dernier tiré doit rester possible (poids non nul)');
}

async function testOwnerSelectedServerGate(){
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.SESSION_SECRET = 'test-secret-owner-gate';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({type:'pkcs8',format:'pem'});
  process.env.FIREBASE_WEB_API_KEY = 'fake-web-key';

  const oldFetch = global.fetch;
  global.fetch = async (url, opts={})=>{
    if(String(url).includes('identitytoolkit.googleapis.com')) return fakeResponse(200,{idToken:'firebase-id-token'});
    if(String(url).includes('/rosterPermissionsOverride.json')) return fakeResponse(200,null);
    if(String(url).includes('/rosterIndividualPermissions.json')) return fakeResponse(200,null);
    throw new Error(`fetch inattendu pendant test gate: ${url}`);
  };
  try{
    for(const level of ['ADD','CD','D','DG']){
      const token = sign({discordId:`id-${level}`,name:`Test ${level}`,level,exp:Date.now()+60_000}, process.env.SESSION_SECRET);
      const res = await proxyModule.handler({
        httpMethod:'POST',
        headers:{'x-pillbox-session':token},
        body:JSON.stringify({
          action:'finalizeAutomaticPayrollSignalement',
          weekKey:'2026-10-31',
          selectionMethod:'owner_selected',
          selectedEmployeeKey:'roster:target',
        }),
      });
      assert.strictEqual(res.statusCode,403,`${level} doit être refusé côté serveur`);
      assert.match(JSON.parse(res.body).error,/Owner/i);
    }
  } finally { global.fetch = oldFetch; }
}

async function testListSignalementsFilteringThroughHandler(){
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.SESSION_SECRET = 'test-secret-list-filter';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({type:'pkcs8',format:'pem'});
  process.env.FIREBASE_WEB_API_KEY = 'fake-web-key';

  const raw = {
    one:{personName:'Test',personId:'1',personGrade:'MC',category:'autre',reason:'Signalement automatique pour discuter avec cette personne.',createdAt:Date.now(),source:'automatic_payroll_check',selectionMethod:'owner_selected',selectedBy:'861557966083850250'}
  };
  const oldFetch = global.fetch;
  global.fetch = async (url, opts={})=>{
    const u=String(url);
    if(u.includes('identitytoolkit.googleapis.com')) return fakeResponse(200,{idToken:'firebase-id-token'});
    if(u.includes('/rosterPermissionsOverride.json')) return fakeResponse(200,null);
    if(u.includes('/rosterIndividualPermissions.json')) return fakeResponse(200,null);
    if(u.includes('/signalements.json')) return fakeResponse(200,raw);
    throw new Error(`fetch inattendu pendant test list: ${url}`);
  };
  try{
    const token = sign({discordId:'mc-user',name:'MC Test',level:'MC',exp:Date.now()+60_000}, process.env.SESSION_SECRET);
    const res = await signalementModule.handler({
      httpMethod:'POST',
      body:JSON.stringify({token,action:'listSignalements',payload:{}}),
    });
    assert.strictEqual(res.statusCode,200);
    const data=JSON.parse(res.body).signalements.one;
    assert.strictEqual(data.source,'automatic_payroll_check');
    assert.ok(!Object.prototype.hasOwnProperty.call(data,'selectionMethod'));
    assert.ok(!Object.prototype.hasOwnProperty.call(data,'selectedBy'));
  } finally { global.fetch = oldFetch; }
}


async function testFullAutomaticCreation(){
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.SESSION_SECRET = 'test-secret-full-create';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({type:'pkcs8',format:'pem'});
  process.env.FIREBASE_WEB_API_KEY = 'fake-web-key';

  let state = {version:1,nextAutomaticReportIn:1,recentRandomEmployeeKeys:['roster:a'],weeks:{}};
  let etag = '\"1\"';
  let createdSignalement = null;
  const oldFetch = global.fetch;
  const oldRandom = Math.random;
  Math.random = ()=>0.5;
  global.fetch = async (url, opts={})=>{
    const u=String(url);
    if(u.includes('identitytoolkit.googleapis.com')) return fakeResponse(200,{idToken:'firebase-id-token'});
    if(u.includes('/rosterPermissionsOverride.json')) return fakeResponse(200,null);
    if(u.includes('/rosterIndividualPermissions.json')) return fakeResponse(200,null);
    if(u.includes('/rosterEmsData.json')) return fakeResponse(200,{employees:[
      {id:'a',idUnique:'101',name:'Alpha',grade:'MC',licencie:false},
      {id:'b',idUnique:'102',name:'Bravo',grade:'MF',licencie:false},
      {id:'c',idUnique:'103',name:'Charlie',grade:'CD',licencie:false},
    ]});
    if(u.includes('/pillboxWeekHistoryArchive/__automaticPayrollSignalement/production/state.json')){
      if(opts.method === 'PUT'){
        const ifMatch = opts.headers && (opts.headers['if-match'] || opts.headers['If-Match']);
        if(ifMatch && ifMatch !== etag) return fakeResponse(412,{} ,{etag});
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
    const token = sign({discordId:'add-user',name:'ADD Test',level:'ADD',exp:Date.now()+60_000}, process.env.SESSION_SECRET);
    const res = await proxyModule.handler({
      httpMethod:'POST', headers:{'x-pillbox-session':token},
      body:JSON.stringify({action:'finalizeAutomaticPayrollSignalement',weekKey:'2026-10-31',selectionMethod:'random'}),
    });
    assert.strictEqual(res.statusCode,200, res.body);
    const out=JSON.parse(res.body);
    assert.strictEqual(out.created,true);
    assert.strictEqual(out.personName,'Bravo','le dernier tiré Alpha doit être défavorisé avec ce RNG');
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

(async()=>{
  await testPersistentCounter();
  testEligibleGradesAndWeightedRandom();
  await testOwnerSelectedServerGate();
  await testListSignalementsFilteringThroughHandler();
  await testFullAutomaticCreation();
  console.log('OK 5/5 — automatic payroll signalement tests passed');
})().catch(err=>{
  console.error(err);
  process.exit(1);
});
