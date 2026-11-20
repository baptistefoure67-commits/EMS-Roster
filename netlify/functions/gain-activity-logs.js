// Journal privé du Gain de Temps : aucun accès depuis le navigateur à Firebase.
// L'ID du véritable OWNER est la même source que les règles du Roster.
const {verify}=require('./session-token');
const {createFirebaseCustomToken}=require('./firebase-token');
const {OWNER_DISCORD_ID}=require('./permissions');
const BASE='https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app';
const LOG_PATH='/gainTemps/activityLogs';
const LAST_DAYS=30;
const RETENTION=LAST_DAYS*86400000;
const ELIGIBLE_GRADES=new Set(['MF','MP','MLP','RF','RP','RL','MC','ADD','CD','D','DG']);
const json=(statusCode,obj)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(obj)});

function gainDecision(person){
 const v=person && person.use_gain_de_temps;
 if(!v||typeof v!=='object')return null;
 for(const layer of ['OWNER','DG','D','CD'])if(typeof v[layer]==='boolean')return v[layer];
 return null;
}
function allowedUsers(rosterData,individualData){
 const rows=Array.isArray(rosterData?.employees)?rosterData.employees:Object.values(rosterData?.employees||{});
 const seen=new Set();
 return rows.filter(e=>{
   const id=String(e?.discordId||'');
   if(!/^[0-9]{15,22}$/.test(id)||e?.licencie||String(e?.grade||'').toUpperCase()==='WDV')return false;
   if(!ELIGIBLE_GRADES.has(String(e?.grade||'').toUpperCase()))return false;
   if(id!==OWNER_DISCORD_ID&&gainDecision(individualData?.[id])!==true)return false;
   if(seen.has(id))return false;seen.add(id);return true;
 }).map(e=>({discordId:String(e.discordId),name:String(e.name||'Sans nom').slice(0,100),grade:String(e.grade||'').slice(0,15)}))
 .sort((a,b)=>a.name.localeCompare(b.name,'fr',{sensitivity:'base'}));
}
async function getToken(session){
 const {FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY,FIREBASE_WEB_API_KEY}=process.env;
 if(!FIREBASE_CLIENT_EMAIL||!FIREBASE_PRIVATE_KEY||!FIREBASE_WEB_API_KEY)throw Object.assign(new Error('Variables Firebase manquantes sur Netlify Roster'),{statusCode:503});
 const custom=createFirebaseCustomToken({clientEmail:FIREBASE_CLIENT_EMAIL,privateKey:FIREBASE_PRIVATE_KEY,uid:session.discordId,claims:{server:true,audit:true}});
 const res=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true})});
 if(!res.ok)throw Object.assign(new Error('Authentification Firebase refusée par le projet du Roster'),{statusCode:502});
 const token=(await res.json()).idToken;
 if(!token)throw Object.assign(new Error('Jeton Firebase absent'),{statusCode:502});
 return token;
}
async function fetchDb(path,token,query=''){
 const r=await fetch(`${BASE}/${path}.json?auth=${encodeURIComponent(token)}${query}`);
 if(!r.ok){
   const error=r.status===401||r.status===403?`Lecture Firebase refusée (${r.status}) : vérifie les règles gainTemps/activityLogs et le jeton d'audit`:`Lecture Firebase indisponible (${r.status})`;
   throw Object.assign(new Error(error),{statusCode:502});
 }
 return (await r.json())||{};
}
exports.handler=async function(event){
 if(event.httpMethod!=='POST')return json(405,{error:'POST requis'});
 let body;try{body=JSON.parse(event.body||'{}');}catch(_){return json(400,{error:'Requête invalide'});}
 const session=verify(body.token,process.env.SESSION_SECRET);
 if(!session)return json(401,{error:'Session Roster expirée : reconnecte-toi'});
 if(String(session.discordId)!==OWNER_DISCORD_ID||session.level!=='OWNER')return json(403,{error:'Journal Gain de Temps réservé au véritable OWNER'});
 const action=String(body.action||'logs');
 if(!['users','logs','diagnostic'].includes(action))return json(400,{error:'Action inconnue'});
 try{
  const token=await getToken(session);
  if(action==='diagnostic'){
   const db=await fetchDb('gainTemps/activityLogs',token,'&orderBy=%22%24key%22&limitToLast=2');
   const items=Object.values(db||{}).filter(x=>x&&typeof x==='object');
   const last=items.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
   return json(200,{ok:true,cloudRead:true,entriesFound:items.length,lastActionAt:last?.createdAt||null,server:'Roster',message:items.length?'Lecture Firebase confirmée. Vérifie la dernière action dans la liste.':'Lecture Firebase confirmée, mais aucune action Gain de Temps enregistrée.'});
  }
  if(action==='users'){
   const [roster,permissions]=await Promise.all([
     fetchDb('rosterEmsData',token),fetchDb('rosterIndividualPermissions',token)
   ]);
   return json(200,{ok:true,users:allowedUsers(roster,permissions)});
  }
  const filter=String(body.discordId||'').trim();
  if(!/^[0-9]{15,22}$/.test(filter))return json(400,{error:'Choisis un employé dans la liste des accès Gain de Temps'});
  const beforeTime=body.beforeTime==null?Infinity:Number(body.beforeTime);
  const beforeId=String(body.beforeId||'');
  if((beforeTime!==Infinity&&(!Number.isSafeInteger(beforeTime)||beforeTime<0))||(beforeId&&!/^ga_[0-9]{13}_[a-f0-9]{12}$/.test(beforeId)))return json(400,{error:'Pagination invalide'});
  // Retrouve TOUTES les actions de cet utilisateur avant d'appliquer la pagination.
  // Le filtre Firebase par acteur évite la troncature due aux actions des collègues.
  const qs=`&orderBy=%22actorDiscordId%22&equalTo=%22${filter}%22`;
  const data=await fetchDb('gainTemps/activityLogs',token,qs);
  const cutoff=Date.now()-RETENTION;
  const all=Object.entries(data)
    .filter(([,e])=>e&&Number(e.createdAt)>=cutoff&&Number(e.createdAt)<=Date.now()+60000&&String(e.actorDiscordId||'')===filter)
    .map(([id,e])=>({id,createdAt:Number(e.createdAt)||0,clientAt: /^ga_([0-9]{13})_/.test(id)?Number(id.match(/^ga_([0-9]{13})_/)[1]):null,action:String(e.action||''),category:String(e.category||''),target:String(e.target||''),detail:String(e.detail||''),outcome:String(e.outcome||''),count:Number(e.count)||0,plate:String(e.plate||''),actorDiscordId:String(e.actorDiscordId||''),actorName:String(e.actorName||''),actorGrade:String(e.actorGrade||''),origin:String(e.origin||'')}))
    .sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
  const matching=all.filter(e=>e.createdAt<beforeTime||(e.createdAt===beforeTime&&e.id<beforeId));
  const page=matching.slice(0,200),last=page[page.length-1];
  return json(200,{ok:true,entries:page,periodDays:LAST_DAYS,totalMatched:all.length,hasMore:matching.length>page.length,filteredBy:filter,nextBefore:matching.length>page.length?{beforeTime:last.createdAt,beforeId:last.id}:null});
 }catch(e){return json(e.statusCode||502,{error:e.message||'Journal indisponible'});}
};
exports._test={allowedUsers,gainDecision};
