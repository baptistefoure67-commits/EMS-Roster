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
const { can, canFor, LEVELS, OWNER_DISCORD_ID, INDIVIDUAL_DECISION_AUTHORITY_ORDER, buildEffectivePermissions } = require("./permissions");
// (12/10) Inventaire RÉEL des permissions (source unique : permissions.js)
const ALL_PERMISSION_KEYS = [...new Set(LEVELS.flatMap(l => Object.keys(buildEffectivePermissions()[l] || {})))];
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
    if (!(await canFor(session, "manage_individual_permissions"))) {
      return json(403, { error: `Permission refusée (${session.level}) — il faut la permission « Gérer les exceptions individuelles ».` }, corsHeaders);
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
      return json(200, { individualPermissions: all || {}, effectiveByGrade, allPermissions: ALL_PERMISSION_KEYS }, corsHeaders);
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
  // (12/10) Vérification COMPLÈTE : une exception individuelle accordée à
  // quelqu'un pour « Gérer les exceptions individuelles » fonctionne
  // maintenant réellement (avant, seul le grade comptait).
  if (!(await canFor(session, "manage_individual_permissions"))) {
    return json(403, { error: `Permission refusée (${session.level}) — il faut la permission « Gérer les exceptions individuelles ».` }, corsHeaders);
  }
  if (!targetDiscordId) return json(400, { error: "Paramètres manquants." }, corsHeaders);
  if (targetDiscordId === OWNER_DISCORD_ID) {
    return json(403, { error: "OWNER ne peut jamais être la cible d'une exception individuelle (protection spéciale)." }, corsHeaders);
  }
  // (12/10) Personne (sauf le Concepteur) ne peut modifier SES PROPRES
  // permissions — sinon une seule exception suffirait à s'en donner d'autres.
  if (String(targetDiscordId) === String(session.discordId) && session.level !== "OWNER") {
    return json(403, { error: "Tu ne peux pas modifier tes propres permissions." }, corsHeaders);
  }
  const isBatch = action === "setAll" || action === "clearAll";
  if (!isBatch && (typeof permissionName !== "string" || !ALL_PERMISSION_KEYS.includes(permissionName))) {
    return json(400, { error: `Permission inconnue : "${permissionName}".` }, corsHeaders);
  }
  // (13/10, section 7) owner_delegate est le seul droit qui équivaut à
  // TOUT le reste — ni un D ni un DG (même avec manage_individual_permissions)
  // ne peut l'accorder ou le retirer : seul le Concepteur (OWNER) réel.
  if (!isBatch && permissionName === "owner_delegate" && session.level !== "OWNER") {
    return json(403, { error: "Seul le Concepteur (OWNER) peut accorder ou retirer les droits OWNER délégués." }, corsHeaders);
  }

  // Couche d'écriture = niveau réel de l'auteur (jamais choisie par le
  // client). OWNER écrit à la couche DG. (12/10) Un MC/ADD à qui on a
  // accordé cette permission individuellement écrit à la couche la plus
  // basse (CD) — toujours écrasable par un D ou un DG.
  const effectiveLayer = session.level === "OWNER" ? "DG" : (DECISION_LEVELS.includes(session.level) ? session.level : "CD");
  const authorRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(effectiveLayer); // 0=DG,1=D,2=CD
  const cancellableLayers = DECISION_LEVELS.filter(l => INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(l) >= authorRank);

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedUrl = `${INDIVIDUAL_URL}?auth=${idToken}`;
    const res = await fetch(authedUrl);
    const current = (res.ok ? (await res.json()) : null) || {};
    current[targetDiscordId] = current[targetDiscordId] || {};
    const beforePerson = JSON.parse(JSON.stringify(current[targetDiscordId]));
    const ensure = (perm) => { current[targetDiscordId][perm] = current[targetDiscordId][perm] || { CD: null, D: null, DG: null }; return current[targetDiscordId][perm]; };

    let logActionName, details;
    if (action === "set") {
      if (typeof value !== "boolean") return json(400, { error: "Valeur invalide (true/false attendu)." }, corsHeaders);
      ensure(permissionName)[effectiveLayer] = value;
      logActionName = "exception_individuelle_definie"; details = `Permission "${permissionName}" -> ${value ? "Autorisé" : "Refusé"} (couche ${effectiveLayer})`;
    } else if (action === "cancel") {
      if (!cancelLayer || !DECISION_LEVELS.includes(cancelLayer)) return json(400, { error: "Couche à annuler invalide." }, corsHeaders);
      if (!cancellableLayers.includes(cancelLayer)) {
        return json(403, { error: `Un ${session.level} ne peut pas annuler une décision de rang supérieur (${cancelLayer}).` }, corsHeaders);
      }
      ensure(permissionName)[cancelLayer] = null;
      logActionName = "exception_individuelle_annulee"; details = `Permission "${permissionName}" (couche ${cancelLayer} effacée)`;
    } else if (action === "setAll") {
      // « Tout sélectionner » accorde toutes les permissions connues,
      // y compris le Mode troll, dans une seule écriture atomique.
      ALL_PERMISSION_KEYS.forEach(perm => { ensure(perm)[effectiveLayer] = true; });
      logActionName = "exceptions_individuelles_tout_selectionner"; details = `${ALL_PERMISSION_KEYS.length} permissions autorisées, Mode troll inclus (couche ${effectiveLayer})`;
    } else if (action === "clearAll") {
      // « Tout retirer » : efface toutes les décisions que l'auteur a le
      // droit d'effacer (sa couche et celles en dessous) -> retour au grade.
      let n = 0;
      Object.keys(current[targetDiscordId]).forEach(perm => {
        const layers = current[targetDiscordId][perm] || {};
        cancellableLayers.forEach(l => { if (layers[l] === true || layers[l] === false) { layers[l] = null; n++; } });
      });
      logActionName = "exceptions_individuelles_tout_retirer"; details = `${n} décision(s) retirée(s) (couches ${cancellableLayers.join(", ")})`;
    } else {
      return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
    }

    const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current) });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }

    await logAction({
      action: logActionName,
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      targetDiscordId, details,
      oldValue: JSON.stringify(isBatch ? beforePerson : (beforePerson[permissionName] || null)),
      newValue: JSON.stringify(isBatch ? current[targetDiscordId] : current[targetDiscordId][permissionName]),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, current: isBatch ? null : current[targetDiscordId][permissionName], person: current[targetDiscordId] }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
