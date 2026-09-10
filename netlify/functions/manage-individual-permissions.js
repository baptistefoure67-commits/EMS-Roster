// ═══════════════════════════════════════════════════════════════════
// manage-individual-permissions.js — exceptions individuelles par
// personne (09/09). Réservé à can(level, "manage_individual_permissions")
// — CD, D, DG, OWNER (les ADD passent obligatoirement par
// permission-requests.js, jamais ici directement).
//
// Chaque décision est enregistrée à la "couche" correspondant au
// niveau de son auteur (CD/D/DG) — la résolution finale (voir
// permissions.js, resolveIndividualDecision) prend toujours la couche
// la plus haute qui a une valeur, jamais juste la plus récente.
//
// OWNER ne peut JAMAIS être la CIBLE d'une exception individuelle
// (protection spéciale, section 14) — refusé ici explicitement, en
// plus du court-circuit déjà présent dans can().
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can, LEVELS, OWNER_DISCORD_ID, INDIVIDUAL_DECISION_AUTHORITY_ORDER, buildEffectivePermissions } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const INDIVIDUAL_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions.json";
const GRADE_OVERRIDE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionsOverride.json";
// "D" n'est volontairement PAS dans cette liste d'auteurs de décision
// individuelle : le cahier des charges (section 6) ne prévoit que
// DG/D/CD comme COUCHES de décision, mais D et DG partagent en
// pratique la même autorité fonctionnelle pour cette action précise —
// on enregistre la décision d'un D à la couche "D", celle d'un DG à
// la couche "DG", chacune avec sa propre priorité (DG > D > CD).
const DECISION_LEVELS = ["CD", "D", "DG"]; // qui PEUT décider, et à quelle couche ça s'enregistre

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
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  if (event.httpMethod === "GET") {
    const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
    const session = verify(token, SESSION_SECRET);
    if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);
    if (!can(session.level, "manage_individual_permissions")) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus.` }, corsHeaders);
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const res = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      const all = res.ok ? (await res.json()) : {};
      // La table par grade aussi (09/09) — pour que "Hériter" affiche
      // clairement ce que ça donne réellement pour le grade de la
      // personne, même pour un CD qui n'a pas accès à la page complète
      // de gestion des permissions par grade (réservée D+/OWNER).
      const gradeRes = await fetch(`${GRADE_OVERRIDE_URL}?auth=${idToken}`);
      const gradeOverrides = gradeRes.ok ? (await gradeRes.json()) : {};
      const effectiveByGrade = buildEffectivePermissions(gradeOverrides || {});
      return json(200, { individualPermissions: all || {}, effectiveByGrade }, corsHeaders);
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  // action: "set" (fixer une décision à ma propre couche) ou "cancel"
  // (effacer la décision d'une couche INFÉRIEURE ou ÉGALE à la mienne —
  // ex: un DG efface ce qu'un CD avait décidé).
  const { token, action, targetDiscordId, permissionName, value, cancelLayer } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);
  if (!can(session.level, "manage_individual_permissions")) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus.` }, corsHeaders);
  }
  if (!targetDiscordId || typeof permissionName !== "string") {
    return json(400, { error: "Paramètres manquants." }, corsHeaders);
  }
  if (targetDiscordId === OWNER_DISCORD_ID) {
    return json(403, { error: "OWNER ne peut jamais être la cible d'une exception individuelle (protection spéciale)." }, corsHeaders);
  }

  // La couche d'écriture est TOUJOURS celle du niveau réel de l'auteur
  // (jamais choisie par le client) — un CD écrit forcément à la couche
  // CD, un DG à la couche DG, etc. "D" et "DG" partagent la permission
  // manage_individual_permissions par héritage ; on écrit à la couche
  // exacte du niveau réel de la personne.
  const authorLayer = session.level; // "CD", "D", "DG", ou "OWNER" (OWNER agit alors à la couche DG, la plus haute normale)
  const effectiveLayer = authorLayer === "OWNER" ? "DG" : authorLayer;
  if (!DECISION_LEVELS.includes(effectiveLayer)) {
    return json(403, { error: `Niveau (${session.level}) non habilité à décider d'une exception individuelle.` }, corsHeaders);
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedUrl = `${INDIVIDUAL_URL}?auth=${idToken}`;

    const res = await fetch(authedUrl);
    const all = res.ok ? (await res.json()) : {};
    const current = all || {};
    current[targetDiscordId] = current[targetDiscordId] || {};
    current[targetDiscordId][permissionName] = current[targetDiscordId][permissionName] || { CD: null, D: null, DG: null };
    const before = { ...current[targetDiscordId][permissionName] };

    if (action === "set") {
      if (typeof value !== "boolean") return json(400, { error: "Valeur invalide (true/false attendu)." }, corsHeaders);
      current[targetDiscordId][permissionName][effectiveLayer] = value;
    } else if (action === "cancel") {
      // "cancel" efface la décision d'une couche précise — un DG peut
      // effacer CD ou D ou sa propre couche ; un D ne peut effacer que
      // CD ou sa propre couche (jamais DG, protégé par la vérification
      // de rang ci-dessous, section 10 du cahier des charges).
      if (!cancelLayer || !DECISION_LEVELS.includes(cancelLayer)) {
        return json(400, { error: "Couche à annuler invalide." }, corsHeaders);
      }
      const authorRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(effectiveLayer); // 0=DG,1=D,2=CD (plus petit = plus fort)
      const targetRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(cancelLayer);
      if (authorRank > targetRank) {
        return json(403, { error: `Un ${session.level} ne peut pas annuler une décision de rang supérieur (${cancelLayer}).` }, corsHeaders);
      }
      current[targetDiscordId][permissionName][cancelLayer] = null;
    } else {
      return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
    }

    const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current) });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }

    await logAction({
      action: action === "set" ? "exception_individuelle_definie" : "exception_individuelle_annulee",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      targetDiscordId, details: `Permission "${permissionName}"${action==="cancel" ? ` (couche ${cancelLayer} effacée)` : ""}`,
      oldValue: JSON.stringify(before), newValue: JSON.stringify(current[targetDiscordId][permissionName]),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, current: current[targetDiscordId][permissionName] }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
