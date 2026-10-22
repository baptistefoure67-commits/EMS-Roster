// Roster disaster backup / restore — 22/10/2026
// Ctrl+Alt+B / Ctrl+Alt+R côté client. Toutes les lectures/écritures passent
// par le serveur et la permission manage_roster_backup.
const { verifyDetailed } = require('./session-token');
const { canFor, OWNER_DISCORD_ID } = require('./permissions');
const { createFirebaseCustomToken } = require('./firebase-token');
const { logAction } = require('./logs');

const BASE='https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app';
const FORMAT='EMS_ROSTER_FULL_BACKUP';
const VERSION=1;

// État persistant réellement utile à une reprise du Roster.
const RESTORE_PATHS=[
  'rosterEmsData','rosterAbsences','rosterEmsSpecialSelection','rosterFormationExperience','activiteSuivi',
  'rosterActiviteClosures','rosterActiviteLastClosure','rosterActiviteWeekHistory','rosterActiviteWeekHistoryArchive',
  'rosterAbsenceAlertDecisions','signalementPropositions','signalements','rosterGradeLabels',
  'rosterPermissionsOverride','rosterIndividualPermissions','rosterPermissionRequests',
  'payRulesConfig','payRulesConfigHistory','rosterAnimPrefs','formationOperationList','discordIdsList','rosterPillboxSyncMeta'
];
// Conservé dans le fichier pour diagnostic, mais jamais réinjecté lors d'une restauration.
const INFO_ONLY_PATHS=[];
const EXCLUDED_PATHS=['rosterPresence','pillboxPresence','rosterForcedLogouts','pillboxForcedLogouts','pillboxLiveUpDecisions','pillboxLiveUpSessions','signalements_test','pillboxWeekHistory','pillboxWeekHistoryArchive','rosterDisasterBackups','rosterLogs','trollJokes','trollMedia'];

function json(statusCode,obj){return {statusCode,headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)};}
async function privilegedToken(){
  const {FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY,FIREBASE_WEB_API_KEY}=process.env;
  if(!FIREBASE_CLIENT_EMAIL||!FIREBASE_PRIVATE_KEY||!FIREBASE_WEB_API_KEY) throw new Error('Configuration Firebase serveur manquante.');
  const custom=createFirebaseCustomToken({clientEmail:FIREBASE_CLIENT_EMAIL,privateKey:FIREBASE_PRIVATE_KEY,uid:'service:roster-backup',claims:{level:'OWNER',server:true,trollService:true}});
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true})});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error?.message||`Firebase auth ${r.status}`); return d.idToken;
}
async function readPath(path,idToken,etag=false){
  const r=await fetch(`${BASE}/${path}.json?auth=${idToken}`,{headers:etag?{'X-Firebase-ETag':'true'}:{}});
  if(!r.ok) throw new Error(`Lecture ${path} impossible (${r.status})`);
  return {value:await r.json(),etag:r.headers.get('etag')};
}
async function readMany(paths,idToken,{strict=false}={}){
  // IMPORTANT : les lectures sont faites en parallèle. La première version les
  // faisait l'une après l'autre (20+ appels Firebase), ce qui pouvait dépasser
  // le temps d'exécution Netlify et finir en 502 malgré un code valide.
  const entries=await Promise.all(paths.map(async p=>{
    try{return [p,(await readPath(p,idToken)).value];}
    catch(e){if(strict) throw new Error(`Backup incomplet : ${e.message}`);return [p,{__backupReadError:e.message}];}
  }));
  return Object.fromEntries(entries);
}
function validBackup(b){return !!(b&&b.backupFormat===FORMAT&&Number(b.version)===VERSION&&b.sections&&typeof b.sections==='object');}
function countObj(v){return Array.isArray(v)?v.length:(v&&typeof v==='object'?Object.keys(v).length:(v==null?0:1));}
function rosterEmployees(sec){return Array.isArray(sec?.rosterEmsData?.employees)?sec.rosterEmsData.employees:[];}
function employeeKey(e){return String(e?.discordId||e?.idUnique||e?.id||e?.name||'').trim().toLowerCase();}
function diffSummary(current,incoming){
  const a=rosterEmployees(current), b=rosterEmployees(incoming), am=new Map(a.map(e=>[employeeKey(e),e])), bm=new Map(b.map(e=>[employeeKey(e),e]));
  const added=[],removed=[],gradeChanges=[],modified=[];
  for(const [k,e] of bm){ if(!am.has(k)) added.push(e.name||k); else {const old=am.get(k); if(String(old.grade||'')!==String(e.grade||'')) gradeChanges.push(`${e.name||old.name}: ${old.grade||'?'} → ${e.grade||'?'}`); if(JSON.stringify(old)!==JSON.stringify(e)) modified.push(e.name||k);} }
  for(const [k,e] of am) if(!bm.has(k)) removed.push(e.name||k);
  const counts={}; for(const p of RESTORE_PATHS) counts[p]={current:countObj(current[p]),backup:countObj(incoming[p])};
  const activeBefore=a.filter(e=>!e?.licencie).length,activeAfter=b.filter(e=>!e?.licencie).length;
  const dropPct=activeBefore>0&&activeAfter<activeBefore?Math.round((activeBefore-activeAfter)/activeBefore*1000)/10:0;
  return {employees:{before:a.length,after:b.length,activeBefore,activeAfter,added,removed,gradeChanges,modifiedCount:modified.length,dropPct,abnormal:(activeBefore>=4&&activeAfter<activeBefore*.5)||(activeBefore>=15&&activeAfter<=5)||(a.length>=4&&b.length===0)},counts};
}
function preserveOwnerAuthority(current,incoming,session){
  if(String(session.discordId)===OWNER_DISCORD_ID||session.level==='OWNER') return incoming;
  const out=JSON.parse(JSON.stringify(incoming||{}));
  const curInd=current.rosterIndividualPermissions||{}, nextInd=out.rosterIndividualPermissions||{};
  for(const [uid,perms] of Object.entries(curInd)) for(const [perm,entry] of Object.entries(perms||{})) if(entry&&Object.prototype.hasOwnProperty.call(entry,'OWNER')){
    nextInd[uid]=nextInd[uid]||{}; nextInd[uid][perm]=nextInd[uid][perm]||{}; nextInd[uid][perm].OWNER=entry.OWNER;
  }
  out.rosterIndividualPermissions=nextInd;
  if(out.rosterPermissionsOverride&&out.rosterPermissionsOverride.OWNER) delete out.rosterPermissionsOverride.OWNER;
  return out;
}
function cleanIncomingSections(sections){const out={}; for(const p of RESTORE_PATHS) if(Object.prototype.hasOwnProperty.call(sections,p)&&!(sections[p]&&sections[p].__backupReadError)) out[p]=sections[p]; return out;}

exports.handler=async event=>{
  if(event.httpMethod!=='POST') return json(405,{error:'POST requis.'});
  const {SESSION_SECRET}=process.env; let body={}; try{body=JSON.parse(event.body||'{}');}catch(e){return json(400,{error:'JSON invalide.'});}
  const session=verifyDetailed(body.token||'',SESSION_SECRET||'').payload; if(!session)return json(401,{error:'Session invalide ou expirée.'});
  if(!['CD','D','DG','OWNER'].includes(String(session.level||''))) return json(403,{error:'Sauvegarde/restauration réservée aux CD, D, DG et OWNER.'});
  if(!(await canFor(session,'manage_roster_backup'))) return json(403,{error:'Permission « Sauvegarde / restauration complète du Roster » requise.'});
  try{
    const idToken=await privilegedToken();
    if(body.action==='export'){
      const restoreSections=await readMany(RESTORE_PATHS,idToken,{strict:true});
      const infoSections=await readMany(INFO_ONLY_PATHS,idToken);
      const sections={...restoreSections,...infoSections};
      const backup={backupFormat:FORMAT,version:VERSION,createdAt:new Date().toISOString(),createdAtMs:Date.now(),createdBy:{discordId:String(session.discordId||''),name:session.name||'',level:session.level||''},sections,restorePaths:RESTORE_PATHS,infoOnlyPaths:INFO_ONLY_PATHS,excludedPaths:EXCLUDED_PATHS,notes:['Les données persistantes nécessaires à la reprise du Roster sont incluses.','Les logs et le mode troll (blagues + médias) sont volontairement exclus : les médias sont stockés en morceaux pouvant dépasser la limite de réponse Netlify si on les regroupe dans un seul backup.','Présences, sessions, kicks, états temps réel, historiques Pillbox et sauvegardes de catastrophe précédentes sont volontairement exclus de la restauration.']};
      await logAction({action:'export_backup_roster',authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`Backup complet v${VERSION} exporté`,idToken}).catch(()=>{});
      return json(200,{ok:true,backup});
    }
    if(!validBackup(body.backup)) return json(400,{error:'Fichier inconnu/corrompu ou version de backup non prise en charge.'});
    const incoming=cleanIncomingSections(body.backup.sections);
    if(!incoming.rosterEmsData||!Array.isArray(incoming.rosterEmsData.employees)) return json(400,{error:'Le backup ne contient pas un Roster employés valide.'});
    const current=await readMany(RESTORE_PATHS,idToken,{strict:true}); const summary=diffSummary(current,incoming);
    if(body.action==='preview') return json(200,{ok:true,summary,protectedOwnerLayer:session.level!=='OWNER'});
    if(body.action!=='restore') return json(400,{error:'Action inconnue.'});
    if(body.confirm!==true) return json(400,{error:'Confirmation explicite requise.'});
    // Compare-and-check : si le Roster change pendant la préparation, on arrête.
    const before=await readPath('rosterEmsData',idToken,true); const expectedEtag=before.etag;
    const snapshot={backupFormat:'EMS_ROSTER_SERVER_SNAPSHOT',version:1,createdAt:new Date().toISOString(),createdBy:{discordId:String(session.discordId||''),name:session.name||'',level:session.level||''},sections:current};
    const snapKey=`${Date.now()}_${String(session.discordId||'unknown').replace(/[^0-9A-Za-z_-]/g,'')}`;
    const sr=await fetch(`${BASE}/rosterDisasterBackups/${snapKey}.json?auth=${idToken}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
    if(!sr.ok) return json(502,{error:`Snapshot de sécurité impossible (${sr.status}) — restauration annulée.`});
    const check=await readPath('rosterEmsData',idToken,true); if(expectedEtag&&check.etag&&expectedEtag!==check.etag) return json(409,{error:'Le Roster a changé pendant la préparation. Rien n’a été restauré ; recommence.'});
    // Vérifie aussi les autres branches restaurables : on préfère annuler plutôt que
    // d'écraser une absence/formation/permission modifiée pendant la prévisualisation.
    const latest=await readMany(RESTORE_PATHS,idToken,{strict:true});
    for(const p of RESTORE_PATHS){
      if(JSON.stringify(latest[p])!==JSON.stringify(current[p])) return json(409,{error:`La donnée « ${p} » a changé pendant la préparation. Rien n’a été restauré ; recommence.`});
    }
    const safeIncoming=preserveOwnerAuthority(current,incoming,session);
    const rr=await fetch(`${BASE}/.json?auth=${idToken}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(safeIncoming)});
    if(!rr.ok){const t=await rr.text().catch(()=>'');return json(502,{error:`Restauration Firebase refusée (${rr.status}) : ${t.slice(0,180)}`});}
    await logAction({action:'restauration_backup_roster',authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`Backup v${body.backup.version} restauré ; snapshot ${snapKey}`,idToken}).catch(()=>{});
    return json(200,{ok:true,summary,snapshotKey:snapKey,ownerLayerPreserved:session.level!=='OWNER'});
  }catch(err){return json(500,{error:err.message||String(err)});}
};

module.exports={handler:exports.handler,RESTORE_PATHS,INFO_ONLY_PATHS,EXCLUDED_PATHS,FORMAT,VERSION,diffSummary,preserveOwnerAuthority};
