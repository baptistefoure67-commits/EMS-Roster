// Journal privé Gain de Temps — vérification propriétaire REELLE côté serveur.
const {verify}=require('./session-token');
const {createFirebaseCustomToken}=require('./firebase-token');
const BASE='https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app';
const OWNER_DISCORD_ID='861557966083850250';
const LOG_PATH='/gainTemps/activityLogs';
const RETENTION=30*86400000;
const json=(statusCode,obj)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(obj)});
exports.handler=async function(event){
 if(event.httpMethod!=='POST')return json(405,{error:'POST requis'});
 let body;try{body=JSON.parse(event.body||'{}');}catch(_){return json(400,{error:'Requête invalide'});}
 const session=verify(body.token,process.env.SESSION_SECRET);
 if(!session)return json(401,{error:'Session Roster invalide'});
 // Vérifie à la fois le niveau OWNER et le véritable ID, aucun droit délégué.
 if(String(session.discordId)!==OWNER_DISCORD_ID || session.level!=='OWNER')return json(403,{error:'Journal Gain de Temps réservé au propriétaire'});
 const {FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY,FIREBASE_WEB_API_KEY}=process.env;
 if(!FIREBASE_CLIENT_EMAIL||!FIREBASE_PRIVATE_KEY||!FIREBASE_WEB_API_KEY)return json(503,{error:'Configuration Firebase incomplète'});
 try{
  const custom=createFirebaseCustomToken({clientEmail:FIREBASE_CLIENT_EMAIL,privateKey:FIREBASE_PRIVATE_KEY,uid:session.discordId,claims:{server:true,audit:true}});
  const authRes=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true})});
  if(!authRes.ok)return json(502,{error:'Authentification Firebase impossible'});
  const idToken=(await authRes.json()).idToken;
  if(!idToken)return json(502,{error:'Jeton Firebase absent'});
  const qs=new URLSearchParams({auth:idToken,orderBy:'"$key"',limitToLast:'1000'});
  const r=await fetch(`${BASE}${LOG_PATH}.json?${qs}`);
  if(!r.ok)return json(502,{error:`Lecture journal Firebase refusée (${r.status})`});
  const payload=(await r.json())||{};
  const now=Date.now(),cutoff=now-RETENTION;
  let entries=Object.entries(payload).filter(([id,row])=>row&&row.createdAt>=cutoff).map(([id,row])=>({id,createdAt:Number(row.createdAt)||0,action:String(row.action||''),category:String(row.category||''),outcome:String(row.outcome||''),count:Number(row.count)||0,plate:String(row.plate||''),actorDiscordId:String(row.actorDiscordId||''),actorName:String(row.actorName||''),actorGrade:String(row.actorGrade||''),origin:String(row.origin||'')}));
  const filter=String(body.discordId||'').trim();if(filter){if(!/^[0-9]{15,22}$/.test(filter))return json(400,{error:'ID Discord invalide'});entries=entries.filter(e=>e.actorDiscordId===filter);}
  entries.sort((a,b)=>b.createdAt-a.createdAt);
  // Purge des entrées périmées : réservé à OWNER via jeton de serveur d'audit.
  const old=Object.entries(payload).filter(([,row])=>row&&row.createdAt<cutoff).slice(0,100);
  for(const [id] of old)if(/^ga_[0-9]{13}_[a-f0-9]{12}$/.test(id)){
    await fetch(`${BASE}${LOG_PATH}/${id}.json?auth=${encodeURIComponent(idToken)}`,{method:'DELETE'}).catch(()=>{});
  }
  return json(200,{ok:true,entries:entries.slice(0,500),retentionDays:30});
 }catch(e){return json(502,{error:'Journal indisponible'});}
};
