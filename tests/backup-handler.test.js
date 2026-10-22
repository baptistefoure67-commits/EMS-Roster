const path = require('path');
const assert = require('assert');

const functionsDir = path.join(__dirname, '..', 'netlify', 'functions');
function fakeModule(file, exportsObj){
  const p = require.resolve(path.join(functionsDir, file));
  require.cache[p] = { id:p, filename:p, loaded:true, exports:exportsObj };
}

fakeModule('session-token.js', { verifyDetailed:()=>({payload:{discordId:'123456789',name:'Audit Test',level:'OWNER'}}) });
fakeModule('permissions.js', { canFor:async()=>true, OWNER_DISCORD_ID:'999999999' });
fakeModule('firebase-token.js', { createFirebaseCustomToken:()=> 'custom-token' });
fakeModule('logs.js', { logAction:async()=>({ok:true}) });

const state = {
  rosterEmsData:{employees:[{id:'1',name:'Alice',grade:'MC',discordId:'11',licencie:false}],savedAt:1761140000000},
  rosterAbsences:{}, rosterEmsSpecialSelection:{}, activiteSuivi:{data:{}},
  rosterActiviteClosures:{}, rosterActiviteLastClosure:{}, rosterActiviteWeekHistory:{}, rosterActiviteWeekHistoryArchive:{},
  rosterAbsenceAlertDecisions:{}, signalementPropositions:{}, signalements:{}, rosterGradeLabels:{},
  rosterPermissionsOverride:{}, rosterIndividualPermissions:{}, rosterPermissionRequests:{},
  payRulesConfig:{quotaStandard:70}, payRulesConfigHistory:{}, rosterAnimPrefs:{},
  formationOperationList:{text:'x'}, discordIdsList:{text:'Alice : 11'}, rosterPillboxSyncMeta:{lastSyncAt:1761140000000}
};
let snapshotPut = false;
let rootPatch = null;
function response(status, data, headers={}){
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async()=>data,
    text: async()=>typeof data === 'string' ? data : JSON.stringify(data),
    headers:{ get:key=>headers[String(key).toLowerCase()] || null }
  };
}

global.fetch = async (url, opts={})=>{
  if(String(url).startsWith('https://identitytoolkit.googleapis.com/')) return response(200,{idToken:'id-token'});
  const u = new URL(url);
  if(u.pathname.startsWith('/rosterDisasterBackups/') && opts.method === 'PUT'){
    snapshotPut = true;
    return response(200,{ok:true});
  }
  if(u.pathname === '/.json' && opts.method === 'PATCH'){
    rootPatch = JSON.parse(opts.body);
    Object.assign(state, rootPatch);
    return response(200,{ok:true});
  }
  const m = u.pathname.match(/^\/([^/]+)\.json$/);
  if(m) return response(200, state[m[1]] ?? null, {'etag':'"etag-1"'});
  throw new Error(`Fetch inattendu : ${url} ${opts.method||'GET'}`);
};

process.env.SESSION_SECRET = 'test';
process.env.FIREBASE_CLIENT_EMAIL = 'audit@example.com';
process.env.FIREBASE_PRIVATE_KEY = 'test-key';
process.env.FIREBASE_WEB_API_KEY = 'test-api-key';

const backupModule = require(path.join(functionsDir, 'roster-backup.js'));
let ok = 0;
function pass(name){ ok++; console.log(`✅ ${name}`); }

(async()=>{
  assert.equal(typeof backupModule.handler, 'function');
  pass('roster-backup exporte bien un handler Netlify');

  let res = await backupModule.handler({httpMethod:'POST',body:JSON.stringify({token:'x',action:'export'})});
  assert.equal(res.statusCode, 200, res.body);
  const backup = JSON.parse(res.body).backup;
  assert.ok(backup.sections.rosterEmsData);
  assert.ok(!('trollMedia' in backup.sections));
  assert.ok(!('trollJokes' in backup.sections));
  assert.ok(!('rosterLogs' in backup.sections));
  pass('export backup fonctionne sans les branches lourdes');

  res = await backupModule.handler({httpMethod:'POST',body:JSON.stringify({token:'x',action:'preview',backup})});
  assert.equal(res.statusCode, 200, res.body);
  pass('aperçu de restauration fonctionne');

  const changed = JSON.parse(JSON.stringify(backup));
  changed.sections.rosterEmsData.employees[0].grade = 'ADD';
  res = await backupModule.handler({httpMethod:'POST',body:JSON.stringify({token:'x',action:'restore',backup:changed,confirm:true})});
  assert.equal(res.statusCode, 200, res.body);
  const restored = JSON.parse(res.body);
  assert.equal(snapshotPut, true);
  assert.ok(restored.snapshotKey);
  assert.equal(rootPatch.rosterEmsData.employees[0].grade, 'ADD');
  pass('restauration crée le snapshot et renvoie snapshotKey');

  console.log(`\nBackup handler : ${ok} test(s) réussi(s), 0 échec.`);
})().catch(err=>{ console.error('❌',err); process.exit(1); });
