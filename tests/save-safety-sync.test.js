const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8') + '\n' + fs.readFileSync(path.join(root,'app.js'),'utf8');
const proxy = fs.readFileSync(path.join(root,'netlify/functions/pillbox-proxy.js'),'utf8');
const protectedWrite = fs.readFileSync(path.join(root,'netlify/functions/protected-write.js'),'utf8');
const rules = JSON.parse(fs.readFileSync(path.join(root,'firebase-rules.permissions-regroupees.json'),'utf8'));

let passed=0;
function test(name, fn){
  try{ fn(); passed++; console.log(`✓ ${name}`); }
  catch(e){ console.error(`✕ ${name}: ${e.message}`); process.exitCode=1; }
}
function functionBody(name){
  const marker=`function ${name}`;
  const start=html.indexOf(marker); assert(start>=0,`fonction ${name} introuvable`);
  const open=html.indexOf('{',start); let depth=0, quote=null, esc=false, lineComment=false, blockComment=false;
  for(let i=open;i<html.length;i++){
    const c=html[i], n=html[i+1];
    if(lineComment){ if(c==='\n') lineComment=false; continue; }
    if(blockComment){ if(c==='*'&&n==='/'){blockComment=false;i++;} continue; }
    if(quote){ if(esc){esc=false;continue;} if(c==='\\'){esc=true;continue;} if(c===quote){quote=null;} continue; }
    if(c==='/'&&n==='/'){lineComment=true;i++;continue;} if(c==='/'&&n==='*'){blockComment=true;i++;continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='{') depth++; else if(c==='}' && --depth===0) return html.slice(start,i+1);
  }
  throw new Error(`fin ${name} introuvable`);
}

// Évalue les fonctions pures DIRECTEMENT extraites du vrai index.html.
const pure = [functionBody('employeeDiffKey'),functionBody('matchEmployeeForDiff'),functionBody('computeRosterEmployeeDiff')].join('\n');
const getDiff = new Function(`${pure}; return computeRosterEmployeeDiff;`)();
const emp=(name,grade='M',extra={})=>({id:name.toLowerCase().replace(/\s/g,'-'),name,discordId:String(100000+Math.floor(Math.random()*899999)),grade,licencie:false,...extra});

test('Aucun changement => aucun diff et aucun risque',()=>{
  const a={id:'1',name:'Aaron',discordId:'111111',grade:'ADD',licencie:false};
  const d=getDiff([a],[{...a}]);
  assert.equal(d.added.length,0); assert.equal(d.removed.length,0); assert.equal(d.gradeChanges.length,0); assert.equal(d.abnormal,false);
});
test('Nouvel employé détecté',()=>{
  const a={id:'1',name:'Aaron',discordId:'111111',grade:'ADD',licencie:false};
  const b={id:'2',name:'Baptiste',discordId:'222222',grade:'ADD',licencie:false};
  const d=getDiff([a],[a,b]); assert.deepEqual(d.added.map(x=>x.name),['Baptiste']);
});
test('Licenciement détecté',()=>{
  const a={id:'1',name:'Aaron',discordId:'111111',grade:'ADD',licencie:false};
  const d=getDiff([a],[{...a,licencie:true}]); assert.equal(d.licensed.length,1); assert.equal(d.licensed[0].name,'Aaron');
});
test('Changement de grade détecté',()=>{
  const a={id:'1',name:'Aaron',discordId:'111111',grade:'ADD',licencie:false};
  const d=getDiff([a],[{...a,grade:'CD'}]); assert.deepEqual(d.gradeChanges,[{name:'Aaron',from:'ADD',to:'CD'}]);
});
test('Suppression complète d’une fiche détectée',()=>{
  const a={id:'1',name:'Aaron',discordId:'111111',grade:'ADD',licencie:false};
  const d=getDiff([a],[]); assert.equal(d.removed.length,1);
});
test('Scénario incident: 60 employés -> 0 = alerte forte',()=>{
  const prev=Array.from({length:60},(_,i)=>({id:String(i),name:`E${i}`,discordId:String(100000+i),grade:'M',licencie:false}));
  const d=getDiff(prev,[]); assert.equal(d.abnormal,true); assert.equal(d.activeDropPct,100);
});
test('Baisse strictement supérieure à 50% = alerte',()=>{
  const prev=Array.from({length:60},(_,i)=>({id:String(i),name:`E${i}`,discordId:String(100000+i),grade:'M',licencie:false}));
  const d=getDiff(prev,prev.slice(0,29)); assert.equal(d.abnormal,true); assert(d.activeDropPct>50);
});
test('Baisse exactement de 50% ne déclenche pas le seuil >50%',()=>{
  const prev=Array.from({length:60},(_,i)=>({id:String(i),name:`E${i}`,discordId:String(100000+i),grade:'M',licencie:false}));
  const d=getDiff(prev,prev.slice(0,30)); assert.equal(d.activeDropPct,50); assert.equal(d.abnormal,false);
});

test('Fenêtre de confirmation présente',()=>assert(html.includes('id="rosterSaveReviewOverlay"')));
test('Le bouton Sauvegarder construit une revue avant écriture',()=>assert(html.includes('review=await buildRosterSaveReview()')));
test('Une baisse risquée exige un acquittement supplémentaire',()=>assert(html.includes('rosterSaveReviewRiskAck') && html.includes('confirmBtn.disabled=risk')));
test('saveState ne fait plus de fetch Firebase automatique',()=>{ const body=functionBody('saveState'); assert(!body.includes('fetch(')); assert(body.includes('rosterEmployeesDirty = true')); });
test('pushStateToCloudNow bloque les anciens appels automatiques',()=>{ const body=functionBody('pushStateToCloudNow'); assert(body.includes('blocked:true')); assert(!body.includes('method:"PUT"')); });
test('Aucun pagehide ne pousse silencieusement le Roster',()=>assert(!html.includes('addEventListener("pagehide", autoSaveOnLeave)')));
test('La sauvegarde confirmée passe par le serveur avec expectedSavedAt + CAS',()=>{ const body=functionBody('pushRosterSnapshotConfirmed'); assert(body.includes('replaceRosterSnapshot')); assert(body.includes('review.previousSavedAt')); assert(protectedWrite.includes('X-Firebase-ETag')); assert(protectedWrite.includes('if-match')); assert(protectedWrite.includes('status === 412')); });
test('La synchro Roster écrit les métadonnées Pillbox côté serveur',()=>assert(html.includes('syncPillboxRoster') && protectedWrite.includes('previousEmployeeCount') && protectedWrite.includes('dropPercent') && protectedWrite.includes('SYNC_META_URL')));
test('Les règles Firebase contiennent rosterPillboxSyncMeta',()=>assert(rules.rules.rosterPillboxSyncMeta));
test('Le proxy transmet rosterSyncMeta à Pillbox',()=>assert(proxy.includes('rosterSyncMeta') && proxy.includes('ROSTER_SYNC_META_URL')));

console.log(`\n${passed} test(s) réussi(s).`);
if(process.exitCode) process.exit(process.exitCode);
