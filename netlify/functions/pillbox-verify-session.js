// ═══════════════════════════════════════════════════════════════════
// pillbox-verify-session.js — vérifie le jeton de session envoyé par
// Pillbox et renvoie le nom/niveau VÉRIFIÉS côté serveur (jamais ceux
// que le navigateur affirmerait tout seul). Utilisé pour enregistrer
// "Paie effectuée par" au moment de valider une semaine, ET pour
// journaliser cette clôture dans les logs du Roster (weekRange fourni
// = demande explicite du 19/09) — l'identité étant déjà vérifiée ici,
// pas besoin d'un aller-retour supplémentaire pour le log.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const session = verify(body.token, SESSION_SECRET);
  if (!session) {
    return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." }, corsHeaders);
  }

  if (body.weekRange) {
    // Génère un jeton Firebase authentifié pour pouvoir écrire dans
    // rosterLogs (qui exige désormais une vraie connexion, comme pour
    // toute autre journalisation — 19/09). Ne bloque jamais la clôture
    // de la semaine si l'un ou l'autre échoue.
    try {
      const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
      const firebaseToken = createFirebaseCustomToken({
        clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY,
        uid: `pillbox:${session.discordId}`, claims: { level: session.level },
      });
      const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: firebaseToken, returnSecureToken: true }),
      });
      const exchData = await exch.json();
      if (exch.ok) {
        await logAction({
          action: "semaine_terminee_pillbox",
          authorDiscordId: session.discordId,
          authorName: session.name,
          authorLevel: session.level,
          details: `Semaine ${body.weekRange}`,
          idToken: exchData.idToken,
        }).catch(() => {});
      }
    } catch (e) { /* échec silencieux — ne bloque jamais la clôture */ }
  }

  return json(200, { name: session.name, level: session.level }, corsHeaders);
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
