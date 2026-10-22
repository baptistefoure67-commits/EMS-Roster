// Renouvellement automatique des sessions Roster/Pillbox.
// Une session encore valide peut être renouvelée, mais le grade/niveau réel
// est relu depuis le Roster avant de signer le nouveau jeton.
const { sign, verifyDetailed, TOKEN_LIFETIME_MS } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { resolveUserLevel, can, loadPermissionContext } = require("./permissions");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";

async function firebaseIdToken(session){
  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if(!FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) throw new Error("Configuration Firebase manquante.");
  const customToken = createFirebaseCustomToken({
    clientEmail:FIREBASE_CLIENT_EMAIL, privateKey:FIREBASE_PRIVATE_KEY,
    uid:`renew:${session.discordId}`, claims:{server:true, level:session.level}
  });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token:customToken, returnSecureToken:true})
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok || !data.idToken) throw new Error(data.error?.message || `Firebase ${res.status}`);
  return data.idToken;
}

exports.handler = async function(event){
  const headers = {
    "Content-Type":"application/json",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"POST, OPTIONS",
    "Cache-Control":"no-store"
  };
  if(event.httpMethod === "OPTIONS") return {statusCode:204, headers, body:""};
  if(event.httpMethod !== "POST") return json(405,{error:"Méthode non autorisée."},headers);
  const { SESSION_SECRET } = process.env;
  if(!SESSION_SECRET) return json(500,{error:"Configuration manquante côté serveur."},headers);
  let body;
  try{ body=JSON.parse(event.body || "{}"); }
  catch(e){ return json(400,{error:"Requête invalide."},headers); }
  const result = verifyDetailed(body.token, SESSION_SECRET);
  if(!result.payload){
    return json(401,{error:"Session Discord invalide ou expirée — reconnecte-toi.",code:result.reason},headers);
  }
  const oldSession = result.payload;
  try{
    const idToken = await firebaseIdToken(oldSession);
    const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
    if(!rosterRes.ok) return json(503,{error:"Impossible de revérifier ton grade actuel — session non renouvelée."},headers);
    const roster = await rosterRes.json();
    const employees = Array.isArray(roster?.employees) ? roster.employees : [];
    const emp = employees.find(e=>String(e?.discordId||"")===String(oldSession.discordId) && !e?.licencie) || null;
    const currentLevel = resolveUserLevel(String(oldSession.discordId), emp?.grade || null);
    if(!currentLevel){
      return json(401,{error:"Ton grade actuel ne donne plus accès à cette session — reconnecte-toi."},headers);
    }
    const app = body.app === "pillbox" || oldSession.origin === "pillbox" ? "pillbox" : "roster";
    if(app === "pillbox"){
      let permCtx;
      try{ permCtx = await loadPermissionContext(idToken, {strict:true}); }
      catch(e){ return json(503,{error:"Permissions Pillbox momentanément indisponibles — session non renouvelée."},headers); }
      if(!can(currentLevel, "use_pillbox_terminal", permCtx.custom, String(oldSession.discordId), permCtx.individual)){
        return json(403,{error:"Ton accès au Terminal Paie a été retiré."},headers);
      }
    }
    const name = emp?.name || oldSession.name;
    const expiresAt = Date.now()+TOKEN_LIFETIME_MS;
    const token = sign({
      discordId:String(oldSession.discordId), name, level:currentLevel, origin:app, exp:expiresAt
    }, SESSION_SECRET);
    return json(200,{token, expiresAt, name, level:currentLevel},headers);
  }catch(err){
    return json(503,{error:`Impossible de revérifier la session : ${err.message}`},headers);
  }
};

function json(statusCode,obj,headers){
  return {statusCode,headers,body:JSON.stringify(obj)};
}
