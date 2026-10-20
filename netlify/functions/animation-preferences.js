// Gestion sécurisée des préférences individuelles d'animation.
// Seuls l'Owner, le Directeur Général et le Directeur peuvent verrouiller
// ou déverrouiller toutes les animations d'une autre personne.
const crypto = require("crypto");
const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { logAction } = require("./logs");

const ANIM_PREFS_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAnimPrefs";
const ALLOWED_LEVELS = new Set(["OWNER", "DG", "D"]);
const b64url = value => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function serviceAccountAccessToken(clientEmail, privateKey){
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const payload = b64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.database",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput); signer.end();
  const key = String(privateKey||"").replace(/\\n/g, "\n");
  const assertion = `${signingInput}.${b64url(signer.sign(key))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion}).toString(),
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok || !data.access_token) throw new Error("Impossible d'autoriser l'écriture sécurisée des préférences d'animation côté serveur.");
  return data.access_token;
}

async function userIdToken(session){
  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if(!FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) return null;
  const customToken = createFirebaseCustomToken({clientEmail:FIREBASE_CLIENT_EMAIL,privateKey:FIREBASE_PRIVATE_KEY,uid:String(session.discordId),claims:{level:session.level}});
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token:customToken,returnSecureToken:true}),
  });
  const data = await response.json().catch(()=>({}));
  return response.ok ? data.idToken : null;
}

exports.handler = async function(event){
  if(event.httpMethod !== "POST") return json(405,{error:"Méthode non autorisée."});
  let body;
  try{ body=JSON.parse(event.body||"{}"); }catch(e){ return json(400,{error:"Requête JSON invalide."}); }
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if(!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return json(500,{error:"Configuration serveur incomplète pour gérer les animations."});
  const session = verify(body.token, SESSION_SECRET);
  if(!session) return json(401,{error:"Session expirée ou invalide — reconnecte-toi avec Discord."});

  const action = String(body.action||"");
  const targetDiscordId = String(body.targetDiscordId||"").trim();
  if(!/^\d{5,25}$/.test(targetDiscordId)) return json(400,{error:"ID Discord cible invalide."});

  // Chacun peut modifier uniquement sa préférence personnelle, et uniquement
  // si aucun verrou individuel administrateur n'est actif.
  if(action === "setEnabled"){
    if(String(session.discordId) !== targetDiscordId) return json(403,{error:"Tu peux modifier uniquement ton propre réglage d'animations."});
    if(typeof body.enabled !== "boolean") return json(400,{error:"Valeur d'animation invalide."});
    try{
      const accessToken = await serviceAccountAccessToken(FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY);
      const url = `${ANIM_PREFS_BASE}/${encodeURIComponent(targetDiscordId)}.json`;
      const headers = {"Authorization":`Bearer ${accessToken}`};
      const currentResponse = await fetch(url,{headers});
      if(!currentResponse.ok) return json(502,{error:`Impossible de lire le verrou des animations (${currentResponse.status}).`});
      const current = await currentResponse.json().catch(()=>null);
      if(current && current.lockedByOwner === true) return json(423,{error:"Les animations de ce compte sont verrouillées par l'Owner, le Directeur Général ou le Directeur."});
      const patch = {enabled:body.enabled,updatedAt:Date.now(),updatedByDiscordId:String(session.discordId),updatedByName:String(session.name||"")};
      const response = await fetch(url,{method:"PATCH",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(patch)});
      if(!response.ok){
        const details = await response.text().catch(()=>"");
        return json(502,{error:`Firebase a refusé la mise à jour des animations (${response.status}). ${details.slice(0,160)}`});
      }
      return json(200,{ok:true,action,targetDiscordId,enabled:body.enabled});
    }catch(error){
      return json(500,{error:error.message||"Erreur serveur lors de la modification de la préférence d'animation."});
    }
  }

  // Le statut et la modification du verrou sont réservés exclusivement à
  // OWNER, DG et D — pas à CD, ADD ou aux permissions individuelles ordinaires.
  if(!ALLOWED_LEVELS.has(String(session.level))) return json(403,{error:"Action réservée à l'Owner, au Directeur Général et au Directeur."});
  if(!["lock","unlock","status"].includes(action)) return json(400,{error:"Action d'animation inconnue."});

  try{
    const accessToken = await serviceAccountAccessToken(FIREBASE_CLIENT_EMAIL,FIREBASE_PRIVATE_KEY);
    const url = `${ANIM_PREFS_BASE}/${encodeURIComponent(targetDiscordId)}.json`;
    const headers = {"Authorization":`Bearer ${accessToken}`};

    if(action === "status"){
      const response = await fetch(url,{headers});
      if(!response.ok) return json(502,{error:`Impossible de lire l'état des animations (${response.status}).`});
      const preference = await response.json().catch(()=>null);
      return json(200,{ok:true,action,targetDiscordId,preference:preference||{enabled:true,lockedByOwner:false}});
    }

    // Écriture serveur avec jeton de compte de service : l'autorisation de
    // l'acteur a déjà été vérifiée ci-dessus, pas de dépendance à l'UI.
    const patch = action === "lock"
      ? {enabled:false,lockedByOwner:true,updatedAt:Date.now(),updatedByDiscordId:String(session.discordId),updatedByName:String(session.name||""),updatedByLevel:String(session.level)}
      : {lockedByOwner:false,updatedAt:Date.now(),updatedByDiscordId:String(session.discordId),updatedByName:String(session.name||""),updatedByLevel:String(session.level)};
    const response = await fetch(url,{method:"PATCH",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(patch)});
    if(!response.ok){
      const details = await response.text().catch(()=>"");
      return json(502,{error:`Firebase a refusé la mise à jour des animations (${response.status}). ${details.slice(0,160)}`});
    }
    // Journal d'audit best-effort ; l'action elle-même ne dépend pas du log.
    try{
      const idToken = await userIdToken(session);
      if(idToken) await logAction({
        action:action === "lock" ? "animations_individuelles_bloquees" : "animations_individuelles_debloquees",
        authorDiscordId:session.discordId, authorName:session.name, authorLevel:session.level,
        targetDiscordId, details:action === "lock" ? "Toutes les animations Roster + Pillbox bloquées individuellement." : "Verrou individuel des animations levé.", idToken,
      });
    }catch(e){}
    return json(200,{ok:true,action,targetDiscordId});
  }catch(error){
    return json(500,{error:error.message||"Erreur serveur lors de la modification du verrou d'animation."});
  }
};
function json(statusCode,body){return {statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:JSON.stringify(body)};}
