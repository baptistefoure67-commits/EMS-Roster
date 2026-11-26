// ping-history.js — historique des ajouts / retraits dans les listes de ping.
// Lit les logs côté serveur (jamais directement depuis le navigateur) et ne renvoie
// QUE les entrées « liste_ping ». Permission requise : voir le Roster.
const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { canFor } = require("./permissions");
const { LOGS_URL } = require("./logs");

function json(statusCode, obj){ return { statusCode, headers:{"Content-Type":"application/json"}, body:JSON.stringify(obj) }; }
async function getIdToken(session, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: session.discordId, claims: { level: session.level, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ token: customToken, returnSecureToken:true }),
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}
function pickPingEntries(raw, limit=100){
  return Object.entries(raw||{})
    .filter(([,v])=>v && v.action==="liste_ping")
    .map(([key,v])=>({ key, createdAt:v.createdAt||0, authorName:v.authorName||null, targetName:v.targetName||null, details:v.details||"" }))
    .sort((a,b)=>b.createdAt-a.createdAt)
    .slice(0,limit);
}
exports.pickPingEntries = pickPingEntries;
exports.handler = async function(event){
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if(!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) return json(500,{error:"Configuration manquante côté serveur."});
  if(event.httpMethod!=="POST") return json(405,{error:"Méthode non autorisée."});
  let body; try{ body=JSON.parse(event.body||"{}"); }catch(e){ return json(400,{error:"Requête invalide."}); }
  const session = verify(body.token, SESSION_SECRET);
  if(!session) return json(401,{error:"Session invalide ou expirée — reconnecte-toi avec Discord."});
  try{
    const idToken = await getIdToken(session, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    if(!(await canFor(session,"view_roster",idToken))) return json(403,{error:`Permission refusée (${session.level}) — voir le Roster requis.`});
    // Les clés de logs commencent par l'horodatage : on lit les plus récentes.
    const url = `${LOGS_URL}?auth=${idToken}&orderBy=${encodeURIComponent('"$key"')}&limitToLast=600`;
    const res = await fetch(url);
    if(!res.ok) return json(502,{error:`Lecture de l'historique impossible (${res.status}).`});
    const raw = await res.json().catch(()=>({}));
    return json(200,{ ok:true, entries:pickPingEntries(raw,100) });
  }catch(err){ return json(500,{error:`Erreur inattendue : ${err.message}`}); }
};
