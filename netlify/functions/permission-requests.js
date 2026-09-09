// ═══════════════════════════════════════════════════════════════════
// permission-requests.js — workflow de demande pour les ADD (09/09) :
// un ADD ne peut jamais modifier directement une exception
// individuelle (voir manage-individual-permissions.js, réservé
// CD+) — il peut seulement PROPOSER, via ce fichier. Un CD minimum
// doit accepter ; un DG/OWNER peut aussi traiter directement une
// demande (rang supérieur), ou annuler une décision déjà prise par un
// CD via manage-individual-permissions.js (pas ici).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");
const crypto = require("crypto");

const REQUESTS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionRequests.json";
const INDIVIDUAL_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions.json";

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

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const { token, action, targetDiscordId, targetName, permissionName, requestedValue, requestId, message } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedRequestsUrl = (path) => `${REQUESTS_URL.replace(".json", path)}?auth=${idToken}`;

    if (action === "create") {
      if (!can(session.level, "request_individual_permission")) {
        return json(403, { error: `Permission refusée (${session.level}) — seuls les ADD peuvent créer une demande.` }, corsHeaders);
      }
      if (!targetDiscordId || typeof permissionName !== "string" || typeof requestedValue !== "boolean") {
        return json(400, { error: "Paramètres manquants." }, corsHeaders);
      }
      const entry = {
        targetDiscordId, targetName: targetName || null, permissionName, requestedValue,
        status: "pending",
        requestedByDiscordId: session.discordId, requestedByName: session.name,
        requestedAt: Date.now(),
      };
      const reqId = crypto.randomUUID();
      const res = await fetch(authedRequestsUrl(`/${reqId}.json`), { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(entry) });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec (${res.status}) : ${t.slice(0,200)}` }, corsHeaders); }

      await logAction({
        action: "demande_permission_creee", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId, targetName, details: `Permission "${permissionName}" → ${requestedValue ? "AUTORISÉ" : "REFUSÉ"} demandé`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, requestId: reqId }, corsHeaders);
    }

    if (["approve", "refuse"].includes(action)) {
      if (!can(session.level, "review_permission_requests")) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus.` }, corsHeaders);
      }
      if (!requestId) return json(400, { error: "Identifiant de demande manquant." }, corsHeaders);

      const reqRes = await fetch(authedRequestsUrl(`/${requestId}.json`));
      const reqData = reqRes.ok ? await reqRes.json() : null;
      if (!reqData) return json(404, { error: "Demande introuvable." }, corsHeaders);
      if (reqData.status !== "pending") return json(409, { error: `Cette demande a déjà été traitée (statut : ${reqData.status}).` }, corsHeaders);

      if (action === "approve") {
        // Applique réellement l'exception individuelle — à la couche
        // CD (ou D/DG si c'est un rang supérieur qui traite la demande
        // directement), exactement comme un appel manuel à
        // manage-individual-permissions.js.
        const effectiveLayer = session.level === "OWNER" ? "DG" : session.level;
        const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
        const current = indivRes.ok ? (await indivRes.json()) || {} : {};
        current[reqData.targetDiscordId] = current[reqData.targetDiscordId] || {};
        current[reqData.targetDiscordId][reqData.permissionName] = current[reqData.targetDiscordId][reqData.permissionName] || { CD: null, D: null, DG: null };
        if (effectiveLayer in current[reqData.targetDiscordId][reqData.permissionName]) {
          current[reqData.targetDiscordId][reqData.permissionName][effectiveLayer] = reqData.requestedValue;
        }
        const saveIndivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(current) });
        if (!saveIndivRes.ok) { const t = await saveIndivRes.text().catch(()=>""); return json(502, { error: `Échec de l'application (${saveIndivRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }
      }

      const patch = {
        status: action === "approve" ? "accepted" : "refused",
        reviewedByDiscordId: session.discordId, reviewedByName: session.name, reviewedByLevel: session.level,
        reviewedAt: Date.now(), reviewMessage: message || null,
      };
      await fetch(authedRequestsUrl(`/${requestId}.json`), { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(patch) });

      await logAction({
        action: action === "approve" ? "demande_permission_acceptee" : "demande_permission_refusee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: reqData.targetDiscordId, targetName: reqData.targetName,
        details: `Permission "${reqData.permissionName}" (demandée par ${reqData.requestedByName})`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true }, corsHeaders);
    }

    if (action === "cancel") {
      // L'auteur ADD annule sa propre demande, tant qu'elle est encore
      // en attente.
      if (!requestId) return json(400, { error: "Identifiant de demande manquant." }, corsHeaders);
      const reqRes = await fetch(authedRequestsUrl(`/${requestId}.json`));
      const reqData = reqRes.ok ? await reqRes.json() : null;
      if (!reqData) return json(404, { error: "Demande introuvable." }, corsHeaders);
      if (reqData.requestedByDiscordId !== session.discordId) {
        return json(403, { error: "Tu ne peux annuler que tes propres demandes." }, corsHeaders);
      }
      if (reqData.status !== "pending") return json(409, { error: "Cette demande a déjà été traitée." }, corsHeaders);
      await fetch(authedRequestsUrl(`/${requestId}.json`), { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ status: "cancelled" }) });
      return json(200, { ok: true }, corsHeaders);
    }

    return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
