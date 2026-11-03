// Import automatique des validations de formations ET de recrutements
// copiées depuis Discord ("⚡ Importer les activités Discord").
// - parse le collage côté SERVEUR (la prévisualisation et l'import utilisent la même logique)
// - associe formateur/recruteur + employé formé/recruté au Roster actuel
// - anti-doublon déterministe (formateur + élève + type), avec RE-VÉRIFICATION
//   contre la dernière version Firebase juste avant d'écrire quoi que ce soit
//   (section 13 du cahier des charges : deux personnes qui importent en même
//   temps ne doivent jamais faire gonfler un compteur en double)
// - Formation Opération => ajoute l'employé à la sélection Opération
// - toute formation/recrutement => ajoute +1 au compteur Formations/Recrutements
//   si le formateur est actuellement MF/RF
// - garde un historique complet dans rosterFormationExperience, une entrée
//   par événement (clé = empreinte), jamais un remplacement global du nœud —
//   deux imports simultanés sur des événements DIFFÉRENTS ne s'écrasent donc
//   jamais l'un l'autre
// - le compteur hebdomadaire (activiteSuivi) est mis à jour par écriture
//   CONDITIONNELLE (ETag Firebase, avec nouvelles tentatives) pour ne jamais
//   perdre l'incrément d'une autre session qui aurait écrit entre-temps

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
const TYPE_LABELS = { operation:'Opération', copilote:'Co-Pilote', pilote:'Pilote', mup:'MUP', recrutement:'Recrutement', unknown:'Formation non reconnue' };
const COMMIT_ATTEMPTS = 3;

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

// --- Lecture/écriture conditionnelle (même motif que activite-close.js) ---
async function getWithEtag(url, idToken){
  const res = await fetch(`${url}?auth=${idToken}`, { headers: { 'X-Firebase-ETag': 'true' } });
  if(!res.ok) throw new Error(`lecture ${res.status}`);
  const etag = res.headers && res.headers.get ? res.headers.get('etag') : null;
  const value = await res.json().catch(()=>null);
  return { value, etag };
}
async function putIfMatch(url, idToken, body, etag){
  const headers = { 'Content-Type':'application/json' };
  if(etag) headers['if-match'] = etag;
  return fetch(`${url}?auth=${idToken}`, { method:'PUT', headers, body:JSON.stringify(body) });
}

function norm(value){
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[’‘`´]/g,"'")
    .replace(/[^\p{L}\p{N}' -]+/gu,' ')
    .replace(/\s+/g,' ').trim().toLowerCase();
}
// (01/11, corrigé) Grades connus, pour extraire le tag [MP]/[MC]/... AVANT
// qu'il ne soit jeté par cleanDisplayName — jusqu'ici ce tag était
// complètement ignoré, ce qui a permis une vraie fausse correspondance :
// "@[MP] Aaliyah Akada" associé par erreur à "Leyah Akada" (MC, pas MP),
// uniquement parce que le nom de famille se ressemblait. Le tag de grade,
// quand il est présent et reconnu, sert maintenant de garde-fou sur la
// correspondance approximative (jamais sur une correspondance exacte par
// nom/alias, qui reste prioritaire et fiable).
const KNOWN_GRADES=['STG','A','INF','M','MF','MP','MLP','MUP','RF','RP','RL','MC','ADD','CD','D','DG'];
function extractGradeTag(value){
  const s=String(value||'').trim();
  const m=s.match(/^@?\s*\[([^\]]+)\]/);
  if(!m) return null;
  const g=m[1].trim().toUpperCase();
  return KNOWN_GRADES.includes(g)?g:null;
}
function cleanDisplayName(value){
  let s=String(value||'').normalize('NFKC').trim();
  s=s.replace(/^#{1,6}\s*/,'').trim();
  s=s.replace(/^\[([^\]]+)\]\([^)]*\)$/,'$1').trim();
  s=s.replace(/^(?:\*{1,3}|_{1,3}|~{2}|`)+|(?:\*{1,3}|_{1,3}|~{2}|`)+$/g,'').trim();
  s=s.replace(/^@+\s*/,'');
  s=s.replace(/^\[[^\]]+\]\s*/,'');
  s=s.replace(/\s*\[[^\]]+\]\s*,?\s*$/,'');
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
  const today=s.match(/^(?:Aujourd['’]hui\s+[àa]\s+)?(\d{1,2}):(\d{2})$/i);
  if(today){
    const d=new Date(nowMs); d.setHours(Number(today[1]),Number(today[2]),0,0); return d.getTime();
  }
  return null;
}
function formationTypeFromLine(line){
  const s=norm(line).replace(/-/g,' ');
  if(!s.includes('formation') || !/\bvalid/.test(s)) return null;
  const after=(s.split(/\bformation\b/,2)[1]||'').replace(/'/g,' ').trim();
  if(/^(?:d\s+)?(?:operations?|ope|ops|op)\b/.test(after)) return 'operation';
  if(/^(?:co\s*pilote|copilote)\b/.test(after)) return 'copilote';
  // (01/11, corrigé) "M.U.P" (avec points) devient "m u p" une fois
  // normalisé (norm() remplace la ponctuation par des espaces) — la
  // regex cherchait "mup" collé et ratait ce cas très courant côté
  // Discord. Tolère maintenant 0 ou plusieurs espaces entre les lettres.
  if(/^m\s*u\s*p\b/.test(after)) return 'mup';
  if(/^pilote\b/.test(after)) return 'pilote';
  return 'unknown';
}
function formationKeyFromLine(line,type){
  if(type!=='unknown') return type;
  const s=norm(line).replace(/-/g,' ');
  const m=s.match(/\bformation\b\s*(.*?)\s*\bvalid\w*/);
  const label=(m&&m[1]?m[1]:'inconnue').replace(/\s+/g,' ').trim().slice(0,180);
  return `unknown:${label||'inconnue'}`;
}
// Recrutement : contrairement à "Formation … Validée" (toujours le même
// ordre), le texte Discord pour un recrutement varie beaucoup plus dans
// l'ordre des mots — le nom de la personne recrutée peut être avant OU
// après "Recrutement", avec ou sans "Validé". On teste donc plusieurs
// formes, de la plus précise à la plus permissive.
function isRecruitmentLine(line){
  return /\brecrutement\b/i.test(line);
}
function recruitmentTraineeFromLine(line){
  const raw=String(line||'').trim();
  let m=raw.match(/^(.*?)\s+Recrutement\b/i);
  if(m && cleanDisplayName(m[1])) return cleanDisplayName(m[1]);
  // \w ne matche pas les lettres accentuées (é, è...) en JS — "effectué"
  // ou "Validée" seraient donc coupés en plein milieu sans [\p{L}] ici.
  m=raw.match(/\bRecrutement\b\s*(?:effectu[\p{L}]*)?\s*(?:de\s+)?:?\s*(.+)$/iu);
  if(m){
    let rest=m[1].trim();
    rest=rest.replace(/\bvalid[\p{L}]*\s*:?\s*$/iu,'').trim();
    const name=cleanDisplayName(rest);
    if(name) return name;
  }
  return null;
}
// Un motif date/heure "pur" : toute la ligne n'est que ça, rien d'autre
// (sert à détecter le format Discord en 2 lignes : le nom seul, puis
// l'heure seule juste en dessous — cas réel du cahier des charges).
const BARE_DATE_RE=/^(?:(?:\d{1,2}\/\d{1,2}\/\d{4})\s+(?:\d{1,2}:\d{2})|(?:Hier\s+[àa]\s+\d{1,2}:\d{2})|(?:Aujourd['’]hui\s+[àa]\s+\d{1,2}:\d{2})|(?:\d{1,2}:\d{2}))$/i;
function looksLikeActivityLine(line){
  return !!formationTypeFromLine(line) || isRecruitmentLine(line);
}
function parseDiscordFormationText(text, nowMs=Date.now()){
  const lines=String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const records=[]; const ignored=[];
  let author=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const headerLine=line.replace(/^#{1,6}\s*/,'').trim();
    // Format sur UNE ligne : "[ADD] Baptiste Fore — 17:43" (ou date complète,
    // Hier/Aujourd'hui…), nom et date collés ensemble.
    const hm=headerLine.match(/^(.+?)(?:\s*[,;]?\s*[—–-]\s*|\s*)?((?:\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2})|(?:Hier\s+[àa]\s+\d{1,2}:\d{2})|(?:Aujourd['’]hui\s+[àa]\s+\d{1,2}:\d{2})|(?:\d{1,2}:\d{2}))\s*$/i);
    if(hm && hm[1].trim()){
      const name=cleanDisplayName(hm[1]);
      author=name?{name,dateLabel:hm[2].trim(),timestamp:parseDateLabel(hm[2],nowMs),raw:line}:null;
      continue;
    }
    // Format sur DEUX lignes : le nom seul sur cette ligne, l'heure/date
    // seule sur la ligne suivante — exactement ce que colle Discord pour
    // un message du jour :
    //   [ADD] Baptiste Fore
    //   17:43
    if(!BARE_DATE_RE.test(headerLine) && !looksLikeActivityLine(line) && i+1<lines.length && BARE_DATE_RE.test(lines[i+1].trim())){
      const name=cleanDisplayName(headerLine);
      if(name){
        const dateLine=lines[i+1].trim();
        author={name,dateLabel:dateLine,timestamp:parseDateLabel(dateLine,nowMs),raw:`${line} / ${dateLine}`};
        i++; // consomme aussi la ligne de date
        continue;
      }
    }
    const formationType=formationTypeFromLine(line);
    const isRecruitment=!formationType && isRecruitmentLine(line);
    if(!formationType && !isRecruitment){ ignored.push({lineNumber:i+1,raw:line,reason:'not_activity'}); continue; }
    if(!author){ ignored.push({lineNumber:i+1,raw:line,reason:'missing_author'}); continue; }
    let type, trainee, traineeTagGrade=null, formationKey;
    if(formationType){
      const rawMatch=line.match(/^(.*?)\s+Formation\b/i);
      const rawTraineeText=rawMatch?rawMatch[1]:'';
      traineeTagGrade=extractGradeTag(rawTraineeText);
      trainee=cleanDisplayName(rawTraineeText);
      type=formationType;
      formationKey=formationKeyFromLine(line,type);
    } else {
      trainee=recruitmentTraineeFromLine(line);
      type='recrutement';
      formationKey='recrutement';
    }
    if(!trainee){ ignored.push({lineNumber:i+1,raw:line,reason:'missing_trainee'}); continue; }
    records.push({
      lineNumber:i+1, trainerName:author.name, traineeName:trainee, traineeTagGrade, type, typeLabel:TYPE_LABELS[type], formationKey,
      dateLabel:author.dateLabel, occurredAt:author.timestamp, rawAuthorLine:author.raw, rawFormationLine:line,
    });
  }
  return {records,ignored};
}
function employeeKey(e){ return e?.idUnique ? `id:${e.idUnique}` : `name:${norm(e?.name)}`; }
function employeeIdentity(e){ return String(e?.discordId||e?.idUnique||e?.id||norm(e?.name)); }
function aliasesFor(e){ return [e?.name,...(Array.isArray(e?.aliases)?e.aliases:[])].filter(Boolean).map(norm); }
// Distance de Levenshtein simple (pas de dépendance externe) — sert
// UNIQUEMENT de tout dernier recours (section 2, point 5 : "correspondance
// raisonnablement proche"), jamais en priorité sur un nom exact ou un alias.
function levenshtein(a,b){
  if(a===b) return 0;
  const al=a.length, bl=b.length;
  if(!al) return bl; if(!bl) return al;
  let prev=new Array(bl+1); for(let j=0;j<=bl;j++) prev[j]=j;
  for(let i=1;i<=al;i++){
    const cur=[i];
    for(let j=1;j<=bl;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      cur[j]=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost);
    }
    prev=cur;
  }
  return prev[bl];
}
function matchEmployee(name, employees, expectedGrade=null){
  const needle=norm(name);
  if(!needle) return {employee:null,ambiguous:false,candidates:[]};
  const active=(employees||[]).filter(e=>!e.licencie);
  const exact=active.filter(e=>aliasesFor(e).includes(needle));
  if(exact.length===1) return {employee:exact[0],ambiguous:false,candidates:exact};
  if(exact.length>1) return {employee:null,ambiguous:true,candidates:exact};
  // Dernier recours : distance d'édition courte par rapport au nom
  // normalisé de la personne (jamais les alias, pour rester prévisible).
  // Seuil volontairement serré (une variante mineure, pas une approximation
  // large) — et seulement si UN SEUL employé tombe dans ce seuil.
  const threshold=needle.length>=8?3:(needle.length>=5?2:1);
  // Un nom clairement TRONQUÉ (préfixe exact d'un autre nom, mais
  // sensiblement plus court) n'est jamais une "petite variation" sûre —
  // n'importe quel nom commençant pareil collerait, ce n'est pas une
  // correspondance, c'est une devinette. On l'exclut explicitement, même
  // si sa distance d'édition brute passerait le seuil.
  const isRiskyTruncation=(a,b)=>{
    const [shorter,longer]=a.length<=b.length?[a,b]:[b,a];
    return shorter.length>=4 && longer.length-shorter.length>=2 && longer.startsWith(shorter);
  };
  let close=active.filter(e=>{
    const otherName=norm(e.name);
    return levenshtein(needle,otherName)<=threshold && !isRiskyTruncation(needle,otherName);
  });
  // (01/11, corrigé) Quand le message Discord annonce un grade (ex: "[MP]")
  // et que ce grade est reconnu, un candidat trouvé par approximation dont
  // le grade NE correspond PAS à celui annoncé est écarté — un nom de
  // famille qui se ressemble ne suffit jamais à lui seul si la personne
  // trouvée n'a manifestement pas le bon grade. Jamais appliqué à la
  // correspondance exacte (par nom/alias), seulement à ce dernier recours,
  // déjà plus incertain par nature.
  if(expectedGrade && close.length>1){
    const gradeFiltered=close.filter(e=>String(e.grade||'').toUpperCase()===expectedGrade);
    if(gradeFiltered.length) close=gradeFiltered;
  } else if(expectedGrade && close.length===1 && String(close[0].grade||'').toUpperCase()!==expectedGrade){
    close=[];
  }
  if(close.length===1) return {employee:close[0],ambiguous:false,candidates:close};
  return {employee:null,ambiguous:close.length>1,candidates:close};
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
    const traineeMatch=matchEmployee(r.traineeName,employees,r.traineeTagGrade||null);
    const trainer=trainerMatch.employee, trainee=traineeMatch.employee;
    const fingerprint=(trainer&&trainee)?fingerprintFor(trainer,trainee,r.type,r.formationKey):null;
    const duplicate=!!(fingerprint&&hist[fingerprint]);
    const importable=!!(trainer&&trainee&&!duplicate);
    const activityEligible=!!(trainer&&TRAINER_GRADES.has(String(trainer.grade||'').toUpperCase()));
    return {...r,
      trainer:trainer?pickEmployee(trainer):null, trainee:trainee?pickEmployee(trainee):null,
      trainerAmbiguous:trainerMatch.ambiguous, traineeAmbiguous:traineeMatch.ambiguous,
      fingerprint, duplicate, importable, activityEligible,
      reason: !trainer ? (trainerMatch.ambiguous?'Formateur/recruteur ambigu':'Formateur/recruteur introuvable') : !trainee ? (traineeMatch.ambiguous?'Employé concerné ambigu':'Employé concerné introuvable') : duplicate ? 'Déjà importée' : null,
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
    const cur=groups.get(key)||{trainerName:r.trainerName,trainerDiscordId:r.trainerDiscordId||'',total:0,operation:0,copilote:0,pilote:0,mup:0,recrutement:0,unknown:0,latestAt:0};
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
    recruitments:enriched.filter(r=>r.importable&&r.type==='recrutement').length,
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

// Recalcule, à partir d'une liste de nouveaux enregistrements DÉJÀ validés
// (formateur/trainee connus, pas doublon au moment du calcul), les deltas
// de compteurs par employé — fonction PURE, appelée à chaque tentative de
// la boucle d'écriture conditionnelle, jamais de mutation partagée entre
// essais.
function creditsFor(newRecords){
  const credits={};
  for(const r of newRecords){
    if(!r.activityEligible) continue;
    const key=employeeKey(r.trainer);
    const field=r.type==='recrutement' ? 'recrutements' : 'formations';
    credits[key]=credits[key]||{formations:0,recrutements:0};
    credits[key][field]+=1;
  }
  return credits;
}
function applyCredits(activityData, credits){
  const next={...activityData};
  for(const [key,delta] of Object.entries(credits)){
    const rec={...(next[key]||{})};
    rec.formations=Math.max(0,Number(rec.formations)||0)+(delta.formations||0);
    rec.recrutements=Math.max(0,Number(rec.recrutements)||0)+(delta.recrutements||0);
    next[key]=rec;
  }
  return next;
}

// Fonction PURE qui construit le patch complet à partir d'enregistrements
// déjà enrichis — utilisée par les tests pour vérifier le calcul sans
// mock Firebase, ET par le handler pour la partie Opération/sélection
// (enjeu faible). La partie compteurs (activiteSuivi) et historique sont
// RÉÉCRITES par le handler lui-même avec protection ETag/par-clé — cette
// fonction donne seulement le calcul de référence (sans concurrence) pour
// que les deux restent cohérents et testables.
function buildCommitPatch(enriched, history, currentActivity, currentSpecial, currentFormationOperation, employees, session, now=Date.now()){
  const newRecords=(enriched||[]).filter(r=>r.importable);
  const nextHistory={...((history&&typeof history==='object')?history:{})};
  const selectedMap=new Map();
  const existingSelected=Array.isArray(currentSpecial?.selectedEmployees)?currentSpecial.selectedEmployees:[];
  existingSelected.forEach(e=>selectedMap.set(employeeIdentity(e),e));
  parseFormationOperationText(currentFormationOperation?.text||'').forEach(entry=>{
    const emp=matchFormationOperationEmployee(entry,employees);
    if(emp) selectedMap.set(employeeIdentity(emp),pickEmployee(emp));
  });
  for(const r of newRecords){
    nextHistory[r.fingerprint]={
      trainerId:r.trainer.id,trainerName:r.trainer.name,trainerDiscordId:r.trainer.discordId||'',trainerGrade:r.trainer.grade||'',
      traineeId:r.trainee.id,traineeName:r.trainee.name,traineeDiscordId:r.trainee.discordId||'',traineeGrade:r.trainee.grade||'',
      type:r.type,typeLabel:r.typeLabel,formationKey:r.formationKey||r.type,dateLabel:r.dateLabel||'',occurredAt:r.occurredAt||null,
      importedAt:now,importedByDiscordId:String(session?.discordId||''),importedByName:session?.name||'',
    };
    if(r.type==='operation') selectedMap.set(employeeIdentity(r.trainee),r.trainee);
  }
  const credits=creditsFor(newRecords);
  const activityData=applyCredits((currentActivity&&currentActivity.data)||{},credits);
  const patch={rosterFormationExperience:nextHistory};
  if(Object.keys(credits).length){
    const nextActivity={data:activityData,savedAt:now};
    if(currentActivity?.streak && Object.keys(currentActivity.streak).length) nextActivity.streak=currentActivity.streak;
    if(currentActivity?.weekFinishedAt) nextActivity.weekFinishedAt=currentActivity.weekFinishedAt;
    patch.activiteSuivi=nextActivity;
  }
  if(newRecords.some(r=>r.type==='operation')){
    const selectedEmployees=[...selectedMap.values()];
    patch.rosterEmsSpecialSelection={selectedEmployees,savedAt:now};
    patch.formationOperationList={text:buildFormationOperationText(selectedEmployees),savedAt:now};
  }
  return {patch,newRecords,activityData,trainerCredits:credits};
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
    if(!histRes.ok) return json(502,{error:`Historique des formations illisible (${histRes.status}) — import refusé pour ne pas écraser l'historique existant.`});
    if(!activityRes.ok) return json(502,{error:`Suivi d'activité illisible (${activityRes.status}) — import refusé pour ne pas écraser le suivi existant.`});
    if(!specialRes.ok) return json(502,{error:`Sélection Formation Opération illisible (${specialRes.status}) — import refusé pour ne pas l'écraser.`});
    if(!formationOperationRes.ok) return json(502,{error:`Liste Formation Opération illisible (${formationOperationRes.status}) — import refusé pour ne pas l'écraser.`});
    const roster=await rosterRes.json().catch(()=>null); const employees=Array.isArray(roster?.employees)?roster.employees:[];
    const history=(await histRes.json().catch(()=>null))||{};
    const currentActivity=(await activityRes.json().catch(()=>null))||{};
    const currentSpecial=(await specialRes.json().catch(()=>null))||{};
    const currentFormationOperation=(await formationOperationRes.json().catch(()=>null))||{};
    if(action==='history') return json(200,{ok:true,recent:recentHistory(history,50),stats:historyStats(history)});
    const parsed=parseDiscordFormationText(rawText);
    const enriched=enrichParsed(parsed,employees,history);
    const summary=summarize(enriched);
    if(action==='preview') return json(200,{ok:true,summary,records:enriched,ignored:parsed.ignored,recent:recentHistory(history,20),stats:historyStats(history)});
    if(action!=='commit') return json(400,{error:'Action inconnue.'});

    // --- RE-VÉRIFICATION ANTI-DOUBLON JUSTE AVANT D'ÉCRIRE (section 13) ---
    const freshHist=await getWithEtag(HISTORY_URL, idToken);
    const freshHistoryValue=(freshHist.value && typeof freshHist.value==='object') ? freshHist.value : {};
    const finalEnriched=enrichParsed(parsed,employees,freshHistoryValue);
    const newRecords=finalEnriched.filter(r=>r.importable);
    if(!newRecords.length){
      return json(200,{ok:true,summary:summarize(finalEnriched),imported:0,records:finalEnriched,recent:recentHistory(freshHistoryValue,20)});
    }

    const now=Date.now();
    const historyPatch={};
    for(const r of newRecords){
      historyPatch[`rosterFormationExperience/${r.fingerprint}`]={
        trainerId:r.trainer.id,trainerName:r.trainer.name,trainerDiscordId:r.trainer.discordId||'',trainerGrade:r.trainer.grade||'',
        traineeId:r.trainee.id,traineeName:r.trainee.name,traineeDiscordId:r.trainee.discordId||'',traineeGrade:r.trainee.grade||'',
        type:r.type,typeLabel:r.typeLabel,formationKey:r.formationKey||r.type,dateLabel:r.dateLabel||'',occurredAt:r.occurredAt||null,
        importedAt:now,importedByDiscordId:String(session?.discordId||''),importedByName:session?.name||'',
      };
    }
    const histWriteRes=await fetch(`${BASE}/.json?auth=${idToken}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(historyPatch)});
    if(!histWriteRes.ok){const t=await histWriteRes.text().catch(()=>'');return json(502,{error:`Import Firebase refusé (${histWriteRes.status}) : ${t.slice(0,180)}`});}

    const credits=creditsFor(newRecords);
    let activityData=currentActivity?.data||{};
    let activityWriteOk=!Object.keys(credits).length;
    if(Object.keys(credits).length){
      for(let attempt=0; attempt<COMMIT_ATTEMPTS && !activityWriteOk; attempt++){
        const cur=await getWithEtag(ACTIVITY_URL, idToken);
        const curData=(cur.value && typeof cur.value==='object' && cur.value.data) || {};
        activityData=applyCredits(curData, credits);
        const nextActivity={data:activityData, savedAt:Math.max(now,(cur.value&&cur.value.savedAt)||0)};
        if(cur.value && cur.value.streak) nextActivity.streak=cur.value.streak;
        if(cur.value && cur.value.weekFinishedAt) nextActivity.weekFinishedAt=cur.value.weekFinishedAt;
        const putRes=await putIfMatch(ACTIVITY_URL, idToken, nextActivity, cur.etag);
        if(putRes.ok){ activityWriteOk=true; break; }
        if(putRes.status!==412){ const t=await putRes.text().catch(()=>''); return json(502,{error:`Écriture du suivi d'activité refusée (${putRes.status}) : ${t.slice(0,180)}`}); }
      }
      if(!activityWriteOk) return json(502,{error:"Conflit d'écriture persistant sur le suivi d'activité (imports simultanés) — réessaie."});
    }

    const selectedMap=new Map();
    const existingSelected=Array.isArray(currentSpecial?.selectedEmployees)?currentSpecial.selectedEmployees:[];
    existingSelected.forEach(e=>selectedMap.set(employeeIdentity(e),e));
    parseFormationOperationText(currentFormationOperation?.text||'').forEach(entry=>{
      const emp=matchFormationOperationEmployee(entry,employees);
      if(emp) selectedMap.set(employeeIdentity(emp),pickEmployee(emp));
    });
    const newOperationRecords=newRecords.filter(r=>r.type==='operation');
    if(newOperationRecords.length){
      newOperationRecords.forEach(r=>selectedMap.set(employeeIdentity(r.trainee),r.trainee));
      const selectedEmployees=[...selectedMap.values()];
      const opPatch={
        rosterEmsSpecialSelection:{selectedEmployees,savedAt:now},
        formationOperationList:{text:buildFormationOperationText(selectedEmployees),savedAt:now},
      };
      await fetch(`${BASE}/.json?auth=${idToken}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(opPatch)}).catch(()=>{});
    }

    const finalHistoryForDisplay={...freshHistoryValue};
    for(const r of newRecords) finalHistoryForDisplay[r.fingerprint]=historyPatch[`rosterFormationExperience/${r.fingerprint}`];
    await logAction({action:'import_formations_discord',authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`${newRecords.length} activité(s) importée(s) (${summary.operations||0} opération(s), ${summary.recruitments||0} recrutement(s)), ${Object.keys(credits).length} crédit(s) Formateur`,idToken}).catch(()=>{});
    return json(200,{ok:true,summary:summarize(finalEnriched),imported:newRecords.length,records:finalEnriched,
      operationEmployeeIds:newOperationRecords.map(r=>r.trainee.id),
      activityData:Object.keys(credits).length?activityData:null,
      importResults:newRecords.map(r=>({type:r.type,typeLabel:r.typeLabel,trainerName:r.trainer.name,traineeName:r.trainee.name,activityCredited:r.activityEligible,operationAdded:r.type==='operation',unrecognized:r.type==='unknown'})),
      recent:recentHistory(finalHistoryForDisplay,30),stats:historyStats(finalHistoryForDisplay)});
  }catch(err){ return json(500,{error:err.message||String(err)}); }
};

exports._test={norm,cleanDisplayName,parseDateLabel,formationTypeFromLine,formationKeyFromLine,isRecruitmentLine,recruitmentTraineeFromLine,parseDiscordFormationText,matchEmployee,extractGradeTag,fingerprintFor,enrichParsed,summarize,employeeKey,parseFormationOperationText,matchFormationOperationEmployee,buildFormationOperationText,creditsFor,applyCredits,buildCommitPatch,historyStats,TYPE_LABELS};
