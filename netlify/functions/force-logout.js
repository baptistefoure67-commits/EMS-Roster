// ═══════════════════════════════════════════════════════════════════
// force-logout.js — déconnexion forcée, EN DEUX PORTÉES SÉPARÉES
// depuis le 10/10 (demandé) : "roster" et "pillbox". Déconnecter
// quelqu'un du Roster ne le déconnecte plus automatiquement de
// Pillbox, et inversement — deux listes, deux boutons, deux horodatages
// distincts, mais la même fonction serveur pour les deux (comme avant).
//
// scope détermine le chemin Firebase utilisé :
//   "roster"  -> rosterForcedLogouts  (chemin historique, réutilisé)
//   "pillbox" -> pillboxForcedLogouts (nouveau)
// Les deux outils n'appellent QUE leur propre portée pour "check" —
// le Roster vérifie "roster", Pillbox vérifie "pillbox" — mais le
// bouton de déclenchement des DEUX portées vit uniquement dans le
// Roster (demandé), Pillbox n'a plus d'interface pour ça.
//
// Actions :
//   - "kick"  : enregistre un horodatage de déconnexion forcée pour une
//               personne, dans la portée demandée. Autorisé uniquement si
//               la permission effective "force_logout" est vraie (ADD+ par
//               défaut, mais les exceptions individuelles sont respectées).
//   - "check" : donnée à n'importe quelle session valide (pas besoin de
//               force_logout pour ÇA — tout le monde doit pouvoir
//               vérifier si lui-même a été déconnecté), dans la portée
//               demandée. Renvoie kickedAt (ou null) pour le discordId
//               de LA session appelante uniquement — jamais un tiers.
//   - "caps"  : capacités effectives de la session (inchangé).
//
// Jamais un vrai "bannissement" : une fois le prochain contrôle (poll)
// détecté côté client, la page redemande une connexion Discord — rien
// n'empêche cette personne de se reconnecter tout de suite après,
// volontairement. C'est une déconnexion immédiate, pas un blocage.
//
// Blague Concepteur (10/10, demandé) : le Concepteur reste
// sélectionnable dans les deux listes exprès, mais intouchable dans
// les deux portées — une tentative de le déconnecter (Roster OU
// Pillbox) se retourne contre l'auteur, dans cette même portée
// uniquement, sans que la réponse de l'appel ne le révèle.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can, loadPermissionContext, OWNER_DISCORD_ID, effectivePermissionsFor, isTrollAdmin } = require("./permissions");
const { createFirebaseCustomToken } = require("./firebase-token");
const { logAction } = require("./logs");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const KICKS_URL_BY_SCOPE = {
  roster: `${BASE}/rosterForcedLogouts.json`,
  pillbox: `${BASE}/pillboxForcedLogouts.json`,
};
function kicksUrlFor(scope){
  return KICKS_URL_BY_SCOPE[scope] || KICKS_URL_BY_SCOPE.roster; // repli "roster" si absent (anciens appels)
}

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, server: true } });
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
  const scope = body.scope === "pillbox" ? "pillbox" : "roster"; // repli "roster" par défaut
  const KICKS_URL = kicksUrlFor(scope);

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    if (action === "check") {
      const res = await fetch(`${KICKS_URL.replace(".json", `/${session.discordId}.json`)}?auth=${idToken}`);
      const data = res.ok ? (await res.json()) : null;
      const kickedAt = typeof data === "number" ? data : (data && typeof data === "object" ? data.at : null);
      const reason = (data && typeof data === "object") ? (data.reason || null) : null;
      return json(200, { kickedAt: kickedAt || null, reason }, corsHeaders);
    }

    if (action === "caps") {
      // (12/10) Carte COMPLÈTE des droits effectifs (grade + matrice
      // modifiée + exceptions individuelles) : le Roster s'en sert pour
      // TOUS ses boutons et onglets, au lieu de grades écrits en dur.
      const perms = await effectivePermissionsFor(session, idToken);
      // isTrollAdmin = accès à l'onglet Mode troll (permission manage_troll ; le Concepteur l'a toujours)
      return json(200, { ...perms, perms, isTrollAdmin: perms.manage_troll === true, isTrollOwner: isTrollAdmin(session) }, corsHeaders);
    }

    if (action === "kick") {
      // (24/10, audit) Mode strict : avant, une panne de lecture des
      // permissions fines retombait silencieusement sur la permission de
      // grade, pouvant laisser passer quelqu'un à qui ce droit a été
      // retiré individuellement.
      let ctx;
      try{ ctx = await loadPermissionContext(idToken, {strict:true}); }
      catch(e){ return json(502, { error: "Permissions illisibles — action refusée." }, corsHeaders); }
      if (!can(session.level, "force_logout", ctx.custom, session.discordId, ctx.individual)) {
        return json(403, { error: `Permission refusée (${session.level}) — il faut la permission "Déconnexion forcée" (grade ou exception individuelle).` }, corsHeaders);
      }
      if (!targetDiscordId) return json(400, { error: "Cible manquante." }, corsHeaders);
      const isTargetingOwner = targetDiscordId === OWNER_DISCORD_ID;
      const effectiveTarget = isTargetingOwner ? session.discordId : targetDiscordId;
      const writeToken = await getFirebaseIdToken(session.discordId, "D", FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const isOwnerKickingAaronOnRoster = session.discordId === OWNER_DISCORD_ID && targetDiscordId === "873209274023690303" && scope === "roster";
      const payload = isTargetingOwner
        ? { at: Date.now(), reason: (session.discordId === "873209274023690303" && scope === "roster") ? "tried_to_kick_owner_aaron_roster" : "tried_to_kick_owner" }
        : isOwnerKickingAaronOnRoster
          ? { at: Date.now(), reason: "owner_kicked_aaron_roster" }
          : { at: Date.now() };
      const res = await fetch(`${KICKS_URL.replace(".json", `/${effectiveTarget}.json`)}?auth=${writeToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${res.status}) : ${t.slice(0,200)}` }, corsHeaders); }
      await logAction({
        action: "deconnexion_forcee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: effectiveTarget,
        details: `[${scope === "pillbox" ? "Pillbox" : "Roster"}] ${isTargetingOwner ? "Tentative de déconnexion du Concepteur — retournée contre l'auteur (blague)" : "Déconnexion forcée déclenchée"}`,
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
