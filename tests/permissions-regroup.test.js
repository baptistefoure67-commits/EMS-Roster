const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const FN = path.join(__dirname, '..', 'netlify', 'functions');
const perms = require(path.join(FN, 'permissions.js'));
const sessionToken = require(path.join(FN, 'session-token.js'));

let passed = 0, failed = 0;
async function test(name, fn){
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch(e){ failed++; console.error(`❌ ${name}\n   ${e.stack || e}`); }
}

function matrix(level, key){ return perms.can(level, key); }

// ----- Environment + mock Firebase for handler tests -----
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: {type:'pkcs8',format:'pem'}, publicKeyEncoding:{type:'spki',format:'pem'} });
process.env.SESSION_SECRET = 'test-secret-permissions-regroupees';
process.env.FIREBASE_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = privateKey;
process.env.FIREBASE_WEB_API_KEY = 'fake-api-key';

let db = {};
function resetDb(){
  db = {
    rosterPermissionsOverride: {},
    rosterIndividualPermissions: {},
    rosterPermissionRequests: {},
    rosterLogs: {},
  };
}
resetDb();

function jsonResponse(status, body){
  return { ok: status >= 200 && status < 300, status, async json(){ return body; }, async text(){ return typeof body === 'string' ? body : JSON.stringify(body); } };
}
function parseFirebasePath(url){
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const last = parts[parts.length-1] || '';
  if(last.endsWith('.json')) parts[parts.length-1] = last.slice(0,-5);
  return parts;
}
function getAt(parts){ let cur=db; for(const p of parts){ if(cur==null) return null; cur=cur[p]; } return cur == null ? null : cur; }
function setAt(parts, value){ let cur=db; for(let i=0;i<parts.length-1;i++){ cur[parts[i]] = cur[parts[i]] || {}; cur=cur[parts[i]]; } cur[parts[parts.length-1]] = value; }
function patchAt(parts, value){ const cur=getAt(parts)||{}; setAt(parts,{...cur,...value}); }

global.fetch = async function(url, options={}){
  const s = String(url);
  if(s.includes('identitytoolkit.googleapis.com')) return jsonResponse(200,{idToken:'IDTOKEN'});
  if(s.includes('firebasedatabase.app')){
    const parts=parseFirebasePath(s);
    const method=(options.method||'GET').toUpperCase();
    if(method==='GET') return jsonResponse(200,getAt(parts));
    if(method==='PUT'){ const body=JSON.parse(options.body||'null'); setAt(parts,body); return jsonResponse(200,body); }
    if(method==='PATCH'){ const body=JSON.parse(options.body||'{}'); patchAt(parts,body); return jsonResponse(200,getAt(parts)); }
    if(method==='POST'){
      // Logs use POST; a generated key is sufficient for tests.
      const body=JSON.parse(options.body||'{}');
      const key='mock_'+Math.random().toString(36).slice(2,8);
      const coll=getAt(parts)||{}; coll[key]=body; setAt(parts,coll);
      return jsonResponse(200,{name:key});
    }
    if(method==='DELETE'){ setAt(parts,null); return jsonResponse(200,null); }
  }
  throw new Error('Unexpected fetch: '+s);
};

function token(discordId, level, name='Test User'){
  return sessionToken.sign({ discordId, level, name, exp: Date.now()+3600000 }, process.env.SESSION_SECRET);
}
async function call(handler, method, body={}, query={}){
  const ev={ httpMethod:method, body: method==='GET' ? undefined : JSON.stringify(body), queryStringParameters: query };
  const res=await handler.handler(ev);
  let parsed={}; try{ parsed=JSON.parse(res.body||'{}'); }catch(e){}
  return {...res, json:parsed};
}

(async()=>{
  await test('Les nouvelles permissions regroupées existent', ()=>{
    for(const key of ['manage_psychologue_category','manage_formateur_category','sync_pillbox_complete','manage_pay_weeks'])
      assert(perms.GRADE_PERMISSION_KEYS.includes(key), key);
  });

  await test('Les anciennes clés pointent vers les nouvelles', ()=>{
    assert.equal(perms.canonicalPermissionName('manage_ppa'),'manage_psychologue_category');
    assert.equal(perms.canonicalPermissionName('manage_psy'),'manage_psychologue_category');
    assert.equal(perms.canonicalPermissionName('manage_formations'),'manage_formateur_category');
    assert.equal(perms.canonicalPermissionName('manage_recruitments'),'manage_formateur_category');
    assert.equal(perms.canonicalPermissionName('send_pillbox_all'),'sync_pillbox_complete');
    assert.equal(perms.canonicalPermissionName('view_member_history'),'view_logs');
    assert.equal(perms.canonicalPermissionName('manage_individual_permissions'),'manage_permissions');
    assert.equal(perms.canonicalPermissionName('review_permission_requests'),'manage_permissions');
    assert.equal(perms.canonicalPermissionName('delete_week'),'manage_pay_weeks');
    assert.equal(perms.canonicalPermissionName('reopen_week'),'manage_pay_weeks');
  });

  await test('Matrice MC conforme au tableau fourni', ()=>{
    assert.equal(matrix('MC','view_roster'),true);
    assert.equal(matrix('MC','manage_roster'),false);
    assert.equal(matrix('MC','manage_psychologue_category'),true);
    assert.equal(matrix('MC','manage_formateur_category'),true);
    assert.equal(matrix('MC','manage_retrogradation'),true);
    assert.equal(matrix('MC','sync_pillbox_complete'),true);
    assert.equal(matrix('MC','view_logs'),true);
    assert.equal(matrix('MC','manage_permissions'),false);
    assert.equal(matrix('MC','manage_pay_weeks'),false);
    assert.equal(matrix('MC','force_logout'),false);
  });

  await test('Matrice ADD/CD conforme : semaines, absences, logout et activité', ()=>{
    for(const level of ['ADD','CD']){
      assert.equal(matrix(level,'manage_roster'),true, level);
      assert.equal(matrix(level,'manage_pay_weeks'),true, level);
      assert.equal(matrix(level,'manage_absences'),true, level);
      assert.equal(matrix(level,'force_logout'),true, level);
      assert.equal(matrix(level,'reset_activite_streak'),true, level);
      assert.equal(matrix(level,'reopen_roster_week'),true, level);
      assert.equal(matrix(level,'modify_role_label'),false, level);
      assert.equal(matrix(level,'manage_permissions'),false, level);
    }
  });

  await test('Matrice D conforme : réglages avancés mais pas gestion permissions par défaut', ()=>{
    assert.equal(matrix('D','modify_role_label'),true);
    assert.equal(matrix('D','manage_advanced_settings'),true);
    assert.equal(matrix('D','manage_pay_rules'),true);
    assert.equal(matrix('D','cancel_lower_decisions'),true);
    assert.equal(matrix('D','manage_permissions'),false);
  });

  await test('DG a toutes les permissions de grade', ()=>{
    for(const p of perms.GRADE_PERMISSION_KEYS) assert.equal(matrix('DG',p),true,p);
  });

  await test('OWNER-only et permissions individuelles spéciales sont bien isolées', ()=>{
    assert.equal(matrix('DG','delete_logs'),false);
    assert.equal(matrix('DG','owner_delegate'),false);
    assert.equal(matrix('DG','manage_troll'),false);
    assert.equal(matrix('OWNER','delete_logs'),true);
    assert.equal(matrix('OWNER','owner_delegate'),true);
    assert.equal(matrix('OWNER','manage_troll'),true);
    assert(!perms.GRADE_PERMISSION_KEYS.includes('delete_logs'));
    assert(!perms.INDIVIDUAL_PERMISSION_KEYS.includes('delete_logs'));
    assert(perms.INDIVIDUAL_PERMISSION_KEYS.includes('owner_delegate'));
    assert(perms.INDIVIDUAL_PERMISSION_KEYS.includes('manage_troll'));
  });

  await test('Droits OWNER délégués donnent tout sauf suppression des logs', ()=>{
    const ind={u1:{owner_delegate:{DG:true,D:null,CD:null}}};
    assert.equal(perms.can('MC','manage_pay_rules',null,'u1',ind),true);
    assert.equal(perms.can('MC','manage_troll',null,'u1',ind),true);
    assert.equal(perms.can('MC','delete_logs',null,'u1',ind),false);
  });

  await test('Anciennes décisions individuelles restent comprises', ()=>{
    const ind={u1:{manage_individual_permissions:{DG:null,D:true,CD:null}}};
    assert.equal(perms.can('D','manage_permissions',null,'u1',ind),true);
  });

  await test('Anciennes overrides de semaine migrent vers manage_pay_weeks', ()=>{
    const table=perms.buildEffectivePermissions({ADD:{delete_week:false,reopen_week:true}});
    // delete_week est la clé primaire sensible du groupe : false gagne.
    assert.equal(table.ADD.manage_pay_weeks,false);
  });

  await test('Un niveau ne peut éditer que son niveau ou inférieur', ()=>{
    assert.equal(perms.mayEditTargetLevel('D','ADD'),true);
    assert.equal(perms.mayEditTargetLevel('D','D'),true);
    assert.equal(perms.mayEditTargetLevel('D','DG'),false);
    assert.equal(perms.mayEditTargetLevel('MC','ADD'),false);
    assert.equal(perms.mayEditTargetLevel('OWNER','DG'),true);
  });

  const managePermissions = require(path.join(FN,'manage-permissions.js'));
  const manageIndividual = require(path.join(FN,'manage-individual-permissions.js'));
  const permissionRequests = require(path.join(FN,'permission-requests.js'));

  await test('D délégué manage_permissions ne peut pas modifier DG', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    const r=await call(managePermissions,'POST',{token:token('d1','D'),level:'DG',permissionName:'view_roster',value:false});
    assert.equal(r.statusCode,403);
  });

  await test('D délégué peut attribuer à ADD un droit qu’il possède', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    const r=await call(managePermissions,'POST',{token:token('d1','D'),level:'ADD',permissionName:'manage_pay_rules',value:true});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
    assert.equal(db.rosterPermissionsOverride.ADD.manage_pay_rules,true);
  });

  await test('Un non-OWNER ne peut pas modifier manage_permissions par grade', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    const r=await call(managePermissions,'POST',{token:token('d1','D'),level:'ADD',permissionName:'manage_permissions',value:true});
    assert.equal(r.statusCode,403);
  });

  await test('MC délégué manage_permissions ne peut pas attribuer un droit D+', async()=>{
    resetDb();
    db.rosterIndividualPermissions.m1={manage_permissions:{DG:null,D:null,CD:true}};
    const r=await call(managePermissions,'POST',{token:token('m1','MC'),level:'MC',permissionName:'manage_pay_rules',value:true});
    assert.equal(r.statusCode,403);
  });

  await test('Gestion individuelle : delete_logs est impossible à proposer', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    const r=await call(manageIndividual,'POST',{token:token('d1','D'),action:'set',targetDiscordId:'x2',permissionName:'delete_logs',value:true});
    assert.equal(r.statusCode,400);
  });

  await test('Gestion individuelle : DG ne peut pas accorder owner_delegate', async()=>{
    resetDb();
    const r=await call(manageIndividual,'POST',{token:token('dg1','DG'),action:'set',targetDiscordId:'x2',permissionName:'owner_delegate',value:true});
    assert.equal(r.statusCode,403);
  });

  await test('Gestion individuelle : OWNER peut accorder owner_delegate', async()=>{
    resetDb();
    const r=await call(manageIndividual,'POST',{token:token(perms.OWNER_DISCORD_ID,'OWNER'),action:'set',targetDiscordId:'x2',permissionName:'owner_delegate',value:true});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
    assert.equal(db.rosterIndividualPermissions.x2.owner_delegate.OWNER,true);
  });

  await test('Gestion individuelle : MC manager ne peut attribuer que ses propres droits', async()=>{
    resetDb();
    db.rosterIndividualPermissions.m1={manage_permissions:{DG:null,D:null,CD:true}};
    let r=await call(manageIndividual,'POST',{token:token('m1','MC'),action:'set',targetDiscordId:'x2',permissionName:'view_roster',value:true});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
    r=await call(manageIndividual,'POST',{token:token('m1','MC'),action:'set',targetDiscordId:'x2',permissionName:'manage_pay_rules',value:true});
    assert.equal(r.statusCode,403);
  });

  await test('Demande : owner_delegate et manage_troll ne sont pas demandables', async()=>{
    resetDb();
    for(const p of ['owner_delegate','manage_troll']){
      const r=await call(permissionRequests,'POST',{token:token('m1','MC'),action:'create',targetDiscordId:'x2',permissionName:p,requestedValue:true});
      assert.equal(r.statusCode,400,p+': '+JSON.stringify(r.json));
    }
  });

  await test('Demande normale reste possible pour MC', async()=>{
    resetDb();
    const r=await call(permissionRequests,'POST',{token:token('m1','MC'),action:'create',targetDiscordId:'x2',permissionName:'manage_pay_rules',requestedValue:true});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
  });

  await test('Suppression : une demande acceptée peut être supprimée par Gérer les permissions', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    db.rosterPermissionRequests.req1={
      targetDiscordId:'aaron', targetName:'Aaron Stopenski', permissionName:'manage_absences', requestedValue:true,
      status:'accepted', requestedByDiscordId:'aaron', requestedByName:'Aaron Stopenski', requestedAt:Date.now()-1000,
      reviewedByDiscordId:'owner1', reviewedByName:'Baptiste Fore', reviewedByLevel:'OWNER', reviewedAt:Date.now()-500,
    };
    const r=await call(permissionRequests,'POST',{token:token('d1','D'),action:'delete',requestId:'req1'});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
    assert.equal(db.rosterPermissionRequests.req1,null);
  });

  await test('Suppression : une demande en attente ne peut pas être supprimée', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    db.rosterPermissionRequests.reqPending={
      targetDiscordId:'x2', targetName:'X2', permissionName:'manage_absences', requestedValue:true,
      status:'pending', requestedByDiscordId:'m1', requestedByName:'MC', requestedAt:Date.now(),
    };
    const r=await call(permissionRequests,'POST',{token:token('d1','D'),action:'delete',requestId:'reqPending'});
    assert.equal(r.statusCode,409,JSON.stringify(r.json));
    assert(db.rosterPermissionRequests.reqPending);
  });

  await test('Suppression : sans Gérer les permissions elle est refusée', async()=>{
    resetDb();
    db.rosterPermissionRequests.req2={
      targetDiscordId:'x2', targetName:'X2', permissionName:'manage_absences', requestedValue:true,
      status:'refused', requestedByDiscordId:'m1', requestedByName:'MC', requestedAt:Date.now(),
    };
    const r=await call(permissionRequests,'POST',{token:token('m1','MC'),action:'delete',requestId:'req2'});
    assert.equal(r.statusCode,403,JSON.stringify(r.json));
    assert(db.rosterPermissionRequests.req2);
  });

  await test('Suppression : effacer l’historique ne retire pas la permission déjà appliquée', async()=>{
    resetDb();
    db.rosterIndividualPermissions.d1={manage_permissions:{DG:null,D:true,CD:null}};
    db.rosterIndividualPermissions.aaron={manage_absences:{DG:null,D:true,CD:null}};
    db.rosterPermissionRequests.req3={
      targetDiscordId:'aaron', targetName:'Aaron Stopenski', permissionName:'manage_absences', requestedValue:true,
      status:'accepted', requestedByDiscordId:'aaron', requestedByName:'Aaron Stopenski', requestedAt:Date.now(),
    };
    const before=JSON.parse(JSON.stringify(db.rosterIndividualPermissions.aaron));
    const r=await call(permissionRequests,'POST',{token:token('d1','D'),action:'delete',requestId:'req3'});
    assert.equal(r.statusCode,200,JSON.stringify(r.json));
    assert.deepEqual(db.rosterIndividualPermissions.aaron,before);
  });

  await test('Interface affiche une corbeille pour les demandes traitées', ()=>{
    const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8') + '\n' + fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
    assert(html.includes('data-req-delete'));
    assert(html.includes('La permission déjà appliquée ne sera PAS retirée'));
  });

  await test('Interface actuelle contient seulement les libellés regroupés', ()=>{
    const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8') + '\n' + fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
    for(const label of ['Gérer la catégorie Psychologue','Gérer la catégorie Formateur','Synchronisation complète avec Pillbox','Gérer les semaines de paie (réouvrir / supprimer)']) assert(html.includes(label),label);
    const activeSection=html.slice(html.indexOf('const PERMISSION_LABEL = {'),html.indexOf('const EDITABLE_LEVELS ='));
    for(const old of ['Gérer les PPA','Gérer le suivi Psychologue','Envoyer Formation vers Pillbox','Envoyer Psychologie vers Pillbox','Envoyer TOUT vers Pillbox','Consulter l\'historique d\'un membre','Supprimer une semaine de paie']) assert(!activeSection.includes(old),old);
    assert(!activeSection.includes('Supprimer une entrée de log'));
  });

  await test('Règles Firebase renforcées pour permissions et logs', ()=>{
    const rules=JSON.parse(fs.readFileSync(path.join(__dirname,'..','firebase-rules.permissions-regroupees.json'),'utf8')).rules;
    for(const key of ['rosterPermissionsOverride','rosterIndividualPermissions','rosterPermissionRequests']) assert(String(rules[key]['.write']).includes('auth.token.server'),key);
    assert.equal(rules.rosterLogs['.write'],undefined);
    assert(String(rules.rosterLogs.$logId['.write']).includes("auth.token.level == 'OWNER'"));
  });

  console.log(`\nRésultat : ${passed} test(s) réussi(s), ${failed} échec(s).`);
  if(failed) process.exit(1);
})();
