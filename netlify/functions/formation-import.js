// Import automatique des validations de formations copiées depuis Discord.
// - parse le collage côté SERVEUR (la prévisualisation et l'import utilisent la même logique)
// - associe formateur + employé formé au Roster actuel
// - anti-doublon déterministe (formateur + élève + type)
// - Formation Opération => ajoute l'employé à la sélection Opération
// - toute formation => ajoute +1 au compteur Formations si le formateur est actuellement MF/RF
// - garde un historique complet dans rosterFormationExperience

const crypto = require('crypto');
const { verify } = require('./session-token');
const { createFirebaseCustomToken } = require('./firebase-token');
const { canFor } = require('./permissions');
const { logAction } = require('./logs');

const BASE = 'https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app';
const ROSTER_URL = `${BASE}/rosterEmsData.json`;
const HISTORY_URL = `${BASE}/rosterFormationExperience.json`;
const ACTIVITY_URL = `${BASE}/activiteSuivi.json`;
const SPECIAL_URL = `${BASE}/rosterEmsSpecialSelection.json`;
const FORMATION_OPERATION_URL = `${BASE}/formationOperationList.json`;
const MAX_TEXT = 200000;
const TRAINER_GRADES = new Set(['MF','RF']);
const TYPE_LABELS = { operation:'Opération', copilote:'Co-Pilote', pilote:'Pilote', mup:'MUP', unknown:'Formation non reconnue' };

function json(statusCode, obj){ return { statusCode, headers:{'Content-Type':'application/json'}, body:JSON.stringify(obj) }; }

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid:String(discordId), claims:{ level, server:true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:customToken,returnSecureToken:true}),
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

function norm(value){
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[’‘`´]/g,"'")
    .replace(/[^\p{L}\p{N}' -]+/gu,' ')
    .replace(/\s+/g,' ').trim().toLowerCase();
}
function cleanDisplayName(value){
  let s=String(value||'').normalize('NFKC').trim();
  // Exports Discord/Markdown : titres ###, gras **nom**, italique _nom_, code `nom`.
  s=s.replace(/^#{1,6}\s*/,'').trim();
  // Si le nom lui-même est un lien Markdown, conserver uniquement le libellé.
  s=s.replace(/^\[([^\]]+)\]\([^)]*\)$/,'$1').trim();
  s=s.replace(/^(?:\*{1,3}|_{1,3}|~{2}|`)+|(?:\*{1,3}|_{1,3}|~{2}|`)+$/g,'').trim();
  s=s.replace(/^@+\s*/,'');
  s=s.replace(/^\[[^\]]+\]\s*/,''); // grade/role devant le nom
  s=s.replace(/\s*\[[^\]]+\]\s*,?\s*$/,''); // tag serveur après le nom
  s=s.replace(/^[,;:\-–—\s]+|[,;:\-–—\s]+$/g,'').replace(/\s+/g,' ').trim();
  return s;
}
function parseDateLabel(label, nowMs=Date.now()){
  const s=String(label||'').trim();
  const m=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if(m){
    const [,d,mo,y,h,mi]=m;
    const ts=new Date(Number(y),Number(mo)-1,Number(d),Number(h),Number(mi),0,0).getTime();
    return Number.isFinite(ts)?ts:null;
  }
  const rel=s.match(/^Hier\s+[àa]\s+(\d{1,2}):(\d{2})$/i);
  if(rel){
    const d=new Date(nowMs); d.setDate(d.getDate()-1); d.setHours(Number(rel[1]),Number(rel[2]),0,0); return d.getTime();
  }
  return null;
}
function formationTypeFromLine(line){
  const s=norm(line).replace(/-/g,' ');
  if(!s.includes('formation') || !/\bvalid/.test(s)) return null;
  // On regarde d'abord ce qui suit le mot « formation ». Le but est
  // volontairement conservateur : plusieurs écritures usuelles de
  // Formation Opération sont acceptées, mais un typo douteux devient
  // « unknown » au lieu d'être pris à tort pour une Opération.
  const after=(s.split(/\bformation\b/,2)[1]||'').replace(/'/g,' ').trim();
  if(/^(?:d\s+)?(?:operations?|ope|ops|op)\b/.test(after)) return 'operation';
  if(/^(?:co\s*pilote|copilote)\b/.test(after)) return 'copilote';
  if(/^mup\b/.test(after)) return 'mup';
  if(/^pilote\b/.test(after)) return 'pilote';
  // Une ligne « Formation … Validée » reste une vraie formation à compter
  // pour le formateur, même si son libellé n'est pas reconnu. Elle ne doit
  // simplement JAMAIS cocher la Formation Opération automatiquement.
  return 'unknown';
}
function formationKeyFromLine(line,type){
  if(type!=='unknown') return type;
  const s=norm(line).replace(/-/g,' ');
  const m=s.match(/\bformation\b\s*(.*?)\s*\bvalid\w*/);
  const label=(m&&m[1]?m[1]:'inconnue').replace(/\s+/g,' ').trim();
  return `unknown:${label||'inconnue'}`;
}
function parseDiscordFormationText(text, nowMs=Date.now()){
  const lines=String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const records=[]; const ignored=[];
  let author=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    // En-tête Discord : accepte plusieurs exports :
    //   [RF] Djam Mas — 18/10/2026 22:05
    //   ### [RF] Djam Mas18/10/2026 22:05  (Markdown, date collée au nom)
    //   [RF] Djam Mas — Hier à 22:40
    const headerLine=line.replace(/^#{1,6}\s*/,'').trim();
    const hm=headerLine.match(/^(.+?)(?:\s*[,;]?\s*[—–-]\s*|\s*)?((?:\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2})|(?:Hier\s+[àa]\s+\d{1,2}:\d{2}))\s*$/i);
    if(hm){
      const name=cleanDisplayName(hm[1]);
      author=name?{name,dateLabel:hm[2].trim(),timestamp:parseDateLabel(hm[2],nowMs),raw:line}:null;
      continue;
    }
    const type=formationTypeFromLine(line);
    if(!type){ ignored.push({lineNumber:i+1,raw:line,reason:'not_formation'}); continue; }
    const idx=norm(line).indexOf('formation');
    // index norm != index raw quand accents/Unicode ; on cherche directement en raw.
    const rawMatch=line.match(/^(.*?)\s+Formation\b/i);
    const trainee=cleanDisplayName(rawMatch?rawMatch[1]:'');
    if(!author){ ignored.push({lineNumber:i+1,raw:line,reason:'missing_author'}); continue; }
    if(!trainee){ ignored.push({lineNumber:i+1,raw:line,reason:'missing_trainee'}); continue; }
    records.push({
      lineNumber:i+1, trainerName:author.name, traineeName:trainee, type, typeLabel:TYPE_LABELS[type], formationKey:formationKeyFromLine(line,type),
      dateLabel:author.dateLabel, occurredAt:author.timestamp, rawAuthorLine:author.raw, rawFormationLine:line,
    });
  }
  return {records,ignored};
}
function employeeKey(e){ return e?.idUnique ? `id:${e.idUnique}` : `name:${norm(e?.name)}`; }
function employeeIdentity(e){ return String(e?.discordId||e?.idUnique||e?.id||norm(e?.name)); }
function aliasesFor(e){ return [e?.name,...(Array.isArray(e?.aliases)?e.aliases:[])].filter(Boolean).map(norm); }
function matchEmployee(name, employees){
  const needle=norm(name);
  if(!needle) return {employee:null,ambiguous:false,candidates:[]};
  const candidates=(employees||[]).filter(e=>!e.licencie && aliasesFor(e).includes(needle));
  if(candidates.length===1) return {employee:candidates[0],ambiguous:false,candidates};
  return {employee:null,ambiguous:candidates.length>1,candidates};
}
function fingerprintFor(trainer, trainee, type, formationKey=''){
  const key=type==='unknown' ? (formationKey||type) : type;
  const raw=`${employeeIdentity(trainer)}|${employeeIdentity(trainee)}|${key}`.toLowerCase();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0,32);
}
function enrichParsed(parsed, employees, history){
  const hist=(history&&typeof history==='object')?history:{};
  return parsed.records.map(r=>{
    const trainerMatch=matchEmployee(r.trainerName,employees);
    const traineeMatch=matchEmployee(r.traineeName,employees);
    const trainer=trainerMatch.employee, trainee=traineeMatch.employee;
    const fingerprint=(trainer&&trainee)?fingerprintFor(trainer,trainee,r.type,r.formationKey):null;
    const duplicate=!!(fingerprint&&hist[fingerprint]);
    const importable=!!(trainer&&trainee&&!duplicate);
    const activityEligible=!!(trainer&&TRAINER_GRADES.has(String(trainer.grade||'').toUpperCase()));
    return {...r,
      trainer:trainer?pickEmployee(trainer):null, trainee:trainee?pickEmployee(trainee):null,
      trainerAmbiguous:trainerMatch.ambiguous, traineeAmbiguous:traineeMatch.ambiguous,
      fingerprint, duplicate, importable, activityEligible,
      reason: !trainer ? (trainerMatch.ambiguous?'Formateur ambigu':'Formateur introuvable') : !trainee ? (traineeMatch.ambiguous?'Employé formé ambigu':'Employé formé introuvable') : duplicate ? 'Déjà importée' : null,
    };
  });
}
function pickEmployee(e){ return {id:e.id,name:e.name,discordId:e.discordId||'',idUnique:e.idUnique||null,grade:e.grade||'',role:e.role||''}; }
function recentHistory(history, limit=30){
  return Object.entries((history&&typeof history==='object')?history:{})
    .map(([id,r])=>({id,...r})).filter(r=>r&&r.type)
    .sort((a,b)=>(Number(b.occurredAt)||Number(b.importedAt)||0)-(Number(a.occurredAt)||Number(a.importedAt)||0))
    .slice(0,limit);
}
function historyStats(history){
  const groups=new Map();
  for(const r of Object.values((history&&typeof history==='object')?history:{})){
    if(!r||!r.trainerName||!r.type) continue;
    const key=String(r.trainerDiscordId||r.trainerId||norm(r.trainerName));
    const cur=groups.get(key)||{trainerName:r.trainerName,trainerDiscordId:r.trainerDiscordId||'',total:0,operation:0,copilote:0,pilote:0,mup:0,unknown:0,latestAt:0};
    cur.total++; if(Object.prototype.hasOwnProperty.call(cur,r.type)) cur[r.type]++;
    cur.latestAt=Math.max(cur.latestAt,Number(r.occurredAt)||Number(r.importedAt)||0); groups.set(key,cur);
  }
  return [...groups.values()].sort((a,b)=>b.total-a.total||b.latestAt-a.latestAt||a.trainerName.localeCompare(b.trainerName,'fr'));
}
function summarize(enriched){
  return {
    detected:enriched.length,
    importable:enriched.filter(r=>r.importable).length,
    duplicates:enriched.filter(r=>r.duplicate).length,
    unresolved:enriched.filter(r=>!r.trainer||!r.trainee).length,
    operations:enriched.filter(r=>r.importable&&r.type==='operation').length,
    unrecognized:enriched.filter(r=>r.importable&&r.type==='unknown').length,
    activityCredits:enriched.filter(r=>r.importable&&r.activityEligible).length,
    historyOnlyCredits:enriched.filter(r=>r.importable&&!r.activityEligible).length,
  };
}

function parseFormationOperationText(text){
  return String(text||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const idx=line.indexOf(':');
    if(idx>=0) return {name:line.slice(0,idx).trim(),idUnique:line.slice(idx+1).trim()};
    if(/^\d+$/.test(line)) return {name:'',idUnique:line};
    return {name:line,idUnique:''};
  });
}
function matchFormationOperationEmployee(entry,employees){
  if(entry?.idUnique){
    const byId=(employees||[]).find(e=>!e.licencie&&e.idUnique&&String(e.idUnique)===String(entry.idUnique));
    if(byId) return byId;
  }
  if(entry?.name){
    const n=norm(entry.name);
    const candidates=(employees||[]).filter(e=>!e.licencie&&norm(e.name)===n);
    if(candidates.length===1) return candidates[0];
  }
  return null;
}
function buildFormationOperationText(selectedEmployees){
  return [...selectedEmployees].filter(e=>e&&!e.licencie).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'fr')).map(e=>e.idUnique?`${e.name} : ${e.idUnique}`:e.name).filter(Boolean).join('\n');
}

function buildCommitPatch(enriched, history, currentActivity, currentSpecial, currentFormationOperation, employees, session, now=Date.now()){
  const newRecords=(enriched||[]).filter(r=>r.importable);
  const nextHistory={...((history&&typeof history==='object')?history:{})};
  const activityData={...((currentActivity&&currentActivity.data)||{})};
  const activityStreak={...((currentActivity&&currentActivity.streak)||{})};
  const selectedMap=new Map();
  const existingSelected=Array.isArray(currentSpecial?.selectedEmployees)?currentSpecial.selectedEmployees:[];
  existingSelected.forEach(e=>selectedMap.set(employeeIdentity(e),e));
  // Préserve aussi la liste réellement utilisée par Pillbox, même si la
  // sélection Roster était momentanément en retard sur le cloud.
  parseFormationOperationText(currentFormationOperation?.text||'').forEach(entry=>{
    const emp=matchFormationOperationEmployee(entry,employees);
    if(emp) selectedMap.set(employeeIdentity(emp),pickEmployee(emp));
  });
  const trainerCredits={};
  for(const r of newRecords){
    nextHistory[r.fingerprint]={
      trainerId:r.trainer.id,trainerName:r.trainer.name,trainerDiscordId:r.trainer.discordId||'',trainerGrade:r.trainer.grade||'',
      traineeId:r.trainee.id,traineeName:r.trainee.name,traineeDiscordId:r.trainee.discordId||'',traineeGrade:r.trainee.grade||'',
      type:r.type,typeLabel:r.typeLabel,formationKey:r.formationKey||r.type,dateLabel:r.dateLabel||'',occurredAt:r.occurredAt||null,
      importedAt:now,importedByDiscordId:String(session?.discordId||''),importedByName:session?.name||'',
    };
    if(r.type==='operation') selectedMap.set(employeeIdentity(r.trainee),r.trainee);
    if(r.activityEligible){
      const key=employeeKey(r.trainer); const rec={...(activityData[key]||{})};
      rec.formations=Math.max(0,Number(rec.formations)||0)+1;
      if(!Object.prototype.hasOwnProperty.call(rec,'recrutements')) rec.recrutements=0;
      activityData[key]=rec; trainerCredits[key]=(trainerCredits[key]||0)+1;
    }
  }
  const patch={rosterFormationExperience:nextHistory};
  if(Object.keys(trainerCredits).length){
    const nextActivity={data:activityData,savedAt:now};
    if(Object.keys(activityStreak).length) nextActivity.streak=activityStreak;
    if(currentActivity?.weekFinishedAt) nextActivity.weekFinishedAt=currentActivity.weekFinishedAt;
    patch.activiteSuivi=nextActivity;
  }
  if(newRecords.some(r=>r.type==='operation')){
    const selectedEmployees=[...selectedMap.values()];
    patch.rosterEmsSpecialSelection={selectedEmployees,savedAt:now};
    // C'est CETTE branche que Pillbox lit dans hasFormationOperation().
    // L'import Opération la met donc à jour immédiatement : aucun besoin
    // d'attendre le prochain clic « Synchroniser avec Pillbox ».
    patch.formationOperationList={text:buildFormationOperationText(selectedEmployees),savedAt:now};
  }
  return {patch,newRecords,activityData,trainerCredits};
}

exports.handler=async function(event){
  const {SESSION_SECRET,FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY,FIREBASE_WEB_API_KEY}=process.env;
  if(!SESSION_SECRET||!FIREBASE_CLIENT_EMAIL||!FIREBASE_PRIVATE_KEY||!FIREBASE_WEB_API_KEY) return json(500,{error:'Configuration serveur manquante.'});
  if(event.httpMethod!=='POST') return json(405,{error:'POST requis.'});
  let body={}; try{body=JSON.parse(event.body||'{}');}catch(e){return json(400,{error:'JSON invalide.'});}
  const session=verify(body.token,SESSION_SECRET); if(!session) return json(401,{error:'Session invalide ou expirée.'});
  if(!(await canFor(session,'manage_formateur_category'))) return json(403,{error:'Permission « Gérer la catégorie Formateur » requise.'});
  const action=String(body.action||'preview');
  const rawText=String(body.text||'');
  if(rawText.length>MAX_TEXT) return json(413,{error:'Collage trop volumineux.'});
  try{
    const idToken=await getFirebaseIdToken(session.discordId,session.level,FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY,FIREBASE_WEB_API_KEY);
    const auth=url=>`${url}?auth=${idToken}`;
    const [rosterRes,histRes,activityRes,specialRes,formationOperationRes]=await Promise.all([
      fetch(auth(ROSTER_URL)),fetch(auth(HISTORY_URL)),fetch(auth(ACTIVITY_URL)),fetch(auth(SPECIAL_URL)),fetch(auth(FORMATION_OPERATION_URL)),
    ]);
    if(!rosterRes.ok) return json(502,{error:`Roster illisible (${rosterRes.status}).`});
    const roster=await rosterRes.json().catch(()=>null); const employees=Array.isArray(roster?.employees)?roster.employees:[];
    const history=histRes.ok?(await histRes.json().catch(()=>null)||{}):{};
    const currentActivity=activityRes.ok?(await activityRes.json().catch(()=>null)||{}):{};
    const currentSpecial=specialRes.ok?(await specialRes.json().catch(()=>null)||{}):{};
    const currentFormationOperation=formationOperationRes.ok?(await formationOperationRes.json().catch(()=>null)||{}):{};
    if(action==='history') return json(200,{ok:true,recent:recentHistory(history,50),stats:historyStats(history)});
    const parsed=parseDiscordFormationText(rawText);
    const enriched=enrichParsed(parsed,employees,history);
    const summary=summarize(enriched);
    if(action==='preview') return json(200,{ok:true,summary,records:enriched,ignored:parsed.ignored,recent:recentHistory(history,20),stats:historyStats(history)});
    if(action!=='commit') return json(400,{error:'Action inconnue.'});
    const built=buildCommitPatch(enriched,history,currentActivity,currentSpecial,currentFormationOperation,employees,session,Date.now());
    const {patch,newRecords,activityData,trainerCredits}=built;
    if(!newRecords.length) return json(200,{ok:true,summary,imported:0,records:enriched,recent:recentHistory(history,20)});
    const saveRes=await fetch(`${BASE}/.json?auth=${idToken}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
    if(!saveRes.ok){const t=await saveRes.text().catch(()=>'');return json(502,{error:`Import Firebase refusé (${saveRes.status}) : ${t.slice(0,180)}`});}
    await logAction({action:'import_formations_discord',authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`${newRecords.length} formation(s) importée(s), ${summary.operations} opération(s), ${summary.activityCredits} crédit(s) Formateur`,idToken}).catch(()=>{});
    return json(200,{ok:true,summary,imported:newRecords.length,records:enriched,operationEmployeeIds:newRecords.filter(r=>r.type==='operation').map(r=>r.trainee.id),activityData:Object.keys(trainerCredits).length?activityData:null,importResults:newRecords.map(r=>({type:r.type,typeLabel:r.typeLabel,trainerName:r.trainer.name,traineeName:r.trainee.name,activityCredited:r.activityEligible,operationAdded:r.type==='operation',unrecognized:r.type==='unknown'})),recent:recentHistory(patch.rosterFormationExperience,30),stats:historyStats(patch.rosterFormationExperience)});
  }catch(err){ return json(500,{error:err.message||String(err)}); }
};

exports._test={norm,cleanDisplayName,parseDateLabel,formationTypeFromLine,formationKeyFromLine,parseDiscordFormationText,matchEmployee,fingerprintFor,enrichParsed,summarize,employeeKey,parseFormationOperationText,matchFormationOperationEmployee,buildFormationOperationText,buildCommitPatch,historyStats,TYPE_LABELS};
