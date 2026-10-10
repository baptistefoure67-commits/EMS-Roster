// ═══════════════════════════════════════════════════════════════════
// force-logout.js (10/10, demandé) — déconnexion forcée, partagée entre
// Pillbox et le Roster (les deux appellent cette même fonction, comme
// pillbox-verify-session/pillbox-presence le font déjà).
//
// Deux actions :
//   - "kick"  : enregistre un horodatage de déconnexion forcée pour une
//               personne (rosterForcedLogouts/{discordId} = Date.now()).
//               Réservé D, DG, OWNER (can "force_logout" — permissions.js).
//               Pillbox restreint lui-même ce bouton au seul Concepteur
//               (OWNER) côté interface, demandé explicitement — la
//               permission serveur reste D+ pour rester cohérente avec
//               ce que le Roster autorise, mais c'est bien l'écran
//               (showApp côté Pillbox) qui n'affiche le bouton qu'à OWNER.
//   - "check" : donnée à n'importe quelle session valide (pas besoin de
//               force_logout pour ÇA — tout le monde doit pouvoir
//               vérifier si lui-même a été déconnecté). Renvoie
//               kickedAt (ou null) pour le discordId de LA session
//               appelante uniquement — jamais celle d'un tiers.
//
// Jamais un vrai "bannissement" : une fois le prochain contrôle (poll)
// détecté côté client, la page redemande une connexion Discord — rien
// n'empêche cette personne de se reconnecter tout de suite après,
// volontairement. C'est une déconnexion immédiate, pas un blocage.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { createFirebaseCustomToken } = require("./firebase-token");
const { logAction } = require("./logs");

const KICKS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterForcedLogouts.json";

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

exports.handler = async function (event) {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const { token, action, targetDiscordId } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    if (action === "check") {
      // Accessible à toute session valide — chacun doit pouvoir vérifier
      // s'IL a été déconnecté, aucune permission spéciale requise ici.
      const res = await fetch(`${KICKS_URL.replace(".json", `/${session.discordId}.json`)}?auth=${idToken}`);
      const kickedAt = res.ok ? (await res.json()) : null;
      return json(200, { kickedAt: kickedAt || null }, corsHeaders);
    }

    if (action === "kick") {
      if (!can(session.level, "force_logout")) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé D, DG, Concepteur.` }, corsHeaders);
      }
      if (!targetDiscordId) return json(400, { error: "Cible manquante." }, corsHeaders);
      const res = await fetch(`${KICKS_URL.replace(".json", `/${targetDiscordId}.json`)}?auth=${idToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Date.now()),
      });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${res.status}) : ${t.slice(0,200)}` }, corsHeaders); }
      await logAction({
        action: "deconnexion_forcee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId,
        details: "Déconnexion forcée déclenchée",
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true }, corsHeaders);
    }

    return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(obj) };
}
