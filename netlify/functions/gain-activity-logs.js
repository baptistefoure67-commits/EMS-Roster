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
 if(!['users','logs'].includes(action))return json(400,{error:'Action inconnue'});
 try{
  const token=await getToken(session);
  if(action==='users'){
   const [roster,permissions]=await Promise.all([
     fetchDb('rosterEmsData',token),fetchDb('rosterIndividualPermissions',token)
   ]);
   return json(200,{ok:true,users:allowedUsers(roster,permissions)});
  }
  const filter=String(body.discordId||'').trim();
  if(filter&&!/^[0-9]{15,22}$/.test(filter))return json(400,{error:'Identifiant utilisateur invalide'});
  // Les 5 000 dernières actions : filtre par utilisateur appliqué côté serveur,
  // avec fenêtre de 30 jours. Ne retourne jamais les captures ni les messages.
  const qs='&orderBy=%22%24key%22&limitToLast=5000';
  const data=await fetchDb('gainTemps/activityLogs',token,qs);
  const cutoff=Date.now()-RETENTION;
  let entries=Object.entries(data)
    .filter(([,e])=>e&&Number(e.createdAt)>=cutoff&&Number(e.createdAt)<=Date.now()+60000)
    .map(([id,e])=>({id,createdAt:Number(e.createdAt)||0,action:String(e.action||''),category:String(e.category||''),outcome:String(e.outcome||''),count:Number(e.count)||0,plate:String(e.plate||''),actorDiscordId:String(e.actorDiscordId||''),actorName:String(e.actorName||''),actorGrade:String(e.actorGrade||''),origin:String(e.origin||'')}));
  if(filter)entries=entries.filter(e=>e.actorDiscordId===filter);
  entries.sort((a,b)=>b.createdAt-a.createdAt);
  return json(200,{ok:true,entries:entries.slice(0,1000),periodDays:LAST_DAYS,totalMatched:entries.length,limited:entries.length>1000});
 }catch(e){return json(e.statusCode||502,{error:e.message||'Journal indisponible'});}
};
exports._test={allowedUsers,gainDecision};
