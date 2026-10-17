// Renouvellement automatique des sessions Roster/Pillbox.
// Ne permet pas de réanimer une session expirée : le jeton reçu doit encore
// être valide et signé par SESSION_SECRET. Seuls les mêmes claims sont repris.
const { sign, verifyDetailed, TOKEN_LIFETIME_MS } = require("./session-token");

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
  const session = result.payload;
  const token = sign({
    discordId:session.discordId,
    name:session.name,
    level:session.level,
    exp:Date.now()+TOKEN_LIFETIME_MS
  }, SESSION_SECRET);
  return json(200,{token, expiresAt:Date.now()+TOKEN_LIFETIME_MS},headers);
};

function json(statusCode,obj,headers){
  return {statusCode,headers,body:JSON.stringify(obj)};
}
