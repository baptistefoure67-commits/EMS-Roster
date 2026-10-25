// Demandes d'exceptions individuelles.
// Création : permission request_individual_permission.
// Traitement : permission regroupée manage_permissions.

const { verify } = require("./session-token");
const {
  can, canFor, loadPermissionContext, GRADE_PERMISSION_KEYS,
  canonicalPermissionName,
} = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");
const crypto = require("crypto");

const REQUESTS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionRequests.json";
const INDIVIDUAL_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions.json";

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, permissionsWrite: true, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

function reviewLayer(level){
  if(["CD","D","DG","OWNER"].includes(level)) return level;
  return "CD";
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
      if (!(await canFor(session, "request_individual_permission", idToken))) {
        return json(403, { error: `Permission refusée (${session.level}) — tu ne peux pas créer de demande.` }, corsHeaders);
      }
      const canonical = canonicalPermissionName(permissionName);
      if (!targetDiscordId || !GRADE_PERMISSION_KEYS.includes(canonical) || typeof requestedValue !== "boolean") {
        return json(400, { error: "Paramètres manquants ou permission non demandable." }, corsHeaders);
      }
      const entry = {
        targetDiscordId, targetName: targetName || null, permissionName: canonical, requestedValue,
        status: "pending",
        requestedByDiscordId: session.discordId, requestedByName: session.name,
        requestedAt: Date.now(),
      };
      const reqId = crypto.randomUUID();
      const res = await fetch(authedRequestsUrl(`/${reqId}.json`), { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(entry) });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec (${res.status}) : ${t.slice(0,200)}` }, corsHeaders); }
      await logAction({
        action: "demande_permission_creee", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId, targetName, details: `Permission "${canonical}" → ${requestedValue ? "AUTORISÉ" : "REFUSÉ"} demandé`, idToken,
      }).catch(()=>{});
      return json(200, { ok: true, requestId: reqId }, corsHeaders);
    }

    if (["approve", "refuse"].includes(action)) {
      if (!(await canFor(session, "manage_permissions", idToken))) {
        return json(403, { error: `Permission refusée (${session.level}) — il faut « Gérer les permissions ».` }, corsHeaders);
      }
      if (!requestId) return json(400, { error: "Identifiant de demande manquant." }, corsHeaders);
      const reqRes = await fetch(authedRequestsUrl(`/${requestId}.json`));
      const reqData = reqRes.ok ? await reqRes.json() : null;
      if (!reqData) return json(404, { error: "Demande introuvable." }, corsHeaders);
      if (reqData.status !== "pending") return json(409, { error: `Cette demande a déjà été traitée (statut : ${reqData.status}).` }, corsHeaders);
      const canonical = canonicalPermissionName(reqData.permissionName);
      if(!GRADE_PERMISSION_KEYS.includes(canonical)) return json(400, { error: "Cette ancienne demande concerne une permission qui n'est plus attribuable." }, corsHeaders);

      // Même règle que l'édition directe : le réviseur ne peut approuver
      // qu'une permission qu'il possède lui-même (OWNER excepté).
      // (24/10, audit) Mode strict : avant, une panne de lecture des
      // permissions fines du réviseur le laissait passer sur sa seule
      // permission de grade, potentiellement au-delà de ses droits réels.
      if(session.level !== "OWNER"){
        let ctx;
        try{ ctx = await loadPermissionContext(idToken, {strict:true}); }
        catch(e){ return json(502, { error: "Permissions illisibles — approbation refusée pour ne pas valider au-delà de tes droits réels." }, corsHeaders); }
        if(!can(session.level, canonical, ctx.custom, session.discordId, ctx.individual)){
          return json(403, { error: `Tu ne peux pas approuver « ${canonical} » : cette permission dépasse tes propres droits.` }, corsHeaders);
        }
      }

      if (action === "approve") {
        const layer = reviewLayer(session.level);
        // (24/10, audit) Lecture + écriture CIBLÉES sur cette seule
        // personne — avant, toute la branche rosterIndividualPermissions
        // était relue puis réécrite en entier ; une panne de lecture suivie
        // d'une écriture réussie pouvait effacer les exceptions de tout le
        // monde pour ne garder que cette approbation.
        const personUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(reqData.targetDiscordId)}.json?auth=${idToken}`;
        const indivRes = await fetch(personUrl);
        if (!indivRes.ok) return json(502, { error: `Permissions individuelles illisibles (${indivRes.status}) — approbation refusée pour ne pas écraser les réglages existants.` }, corsHeaders);
        const person = (await indivRes.json().catch(()=>null)) || {};
        person[canonical] = person[canonical] || { CD: null, D: null, DG: null, OWNER: null };
        person[canonical][layer] = reqData.requestedValue;
        const saveIndivRes = await fetch(personUrl, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(person) });
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
        details: `Permission "${canonical}" (demandée par ${reqData.requestedByName})`, idToken,
      }).catch(()=>{});
      return json(200, { ok: true }, corsHeaders);
    }

    if (action === "cancel") {
      if (!requestId) return json(400, { error: "Identifiant de demande manquant." }, corsHeaders);
      const reqRes = await fetch(authedRequestsUrl(`/${requestId}.json`));
      const reqData = reqRes.ok ? await reqRes.json() : null;
      if (!reqData) return json(404, { error: "Demande introuvable." }, corsHeaders);
      if (reqData.requestedByDiscordId !== session.discordId) return json(403, { error: "Tu ne peux annuler que tes propres demandes." }, corsHeaders);
      if (reqData.status !== "pending") return json(409, { error: "Cette demande a déjà été traitée." }, corsHeaders);
      await fetch(authedRequestsUrl(`/${requestId}.json`), { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ status: "cancelled" }) });
      return json(200, { ok: true }, corsHeaders);
    }

    if (action === "delete") {
      if (!(await canFor(session, "manage_permissions", idToken))) {
        return json(403, { error: `Permission refusée (${session.level}) — il faut « Gérer les permissions » pour supprimer une demande.` }, corsHeaders);
      }
      if (!requestId) return json(400, { error: "Identifiant de demande manquant." }, corsHeaders);
      const reqRes = await fetch(authedRequestsUrl(`/${requestId}.json`));
      const reqData = reqRes.ok ? await reqRes.json() : null;
      if (!reqData) return json(404, { error: "Demande introuvable." }, corsHeaders);
      if (reqData.status === "pending") {
        return json(409, { error: "Une demande encore en attente ne peut pas être supprimée. Traite-la ou annule-la d’abord." }, corsHeaders);
      }

      const delRes = await fetch(authedRequestsUrl(`/${requestId}.json`), { method: "DELETE" });
      if (!delRes.ok) {
        const t = await delRes.text().catch(()=>"");
        return json(502, { error: `Échec de la suppression (${delRes.status}) : ${t.slice(0,200)}` }, corsHeaders);
      }

      await logAction({
        action: "demande_permission_supprimee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: reqData.targetDiscordId, targetName: reqData.targetName,
        details: `Demande ${reqData.status} supprimée de l’historique — permission "${canonicalPermissionName(reqData.permissionName)}" (demandée par ${reqData.requestedByName || "?"})`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, deleted: true }, corsHeaders);
    }

    return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
