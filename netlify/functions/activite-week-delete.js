// ═══════════════════════════════════════════════════════════════════
// activite-week-delete.js (demandé — "je veux pouvoir supprimer des
// semaines") — supprime une entrée de rosterActiviteWeekHistory
// (Formateur ou Psychologue). Même garde-fous que
// pillbox-delete-week.js : archivée avant d'être supprimée (jamais une
// perte réelle), ETag pour éviter une suppression concurrente, même
// permission que la réouverture (reopen_roster_week — CD et au-dessus,
// ajustable par exception individuelle).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const HIST_URL = `${BASE}/rosterActiviteWeekHistory`;
const ARCHIVE_URL = `${BASE}/rosterActiviteWeekHistoryArchive`;
const INDIVIDUAL_URL = `${BASE}/rosterIndividualPermissions.json`;

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

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const { token, weekKey, scope } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." }, corsHeaders);
  if (!weekKey || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(weekKey)) return json(400, { error: "Semaine invalide." }, corsHeaders);
  if (!["formateur", "psychologue"].includes(scope)) return json(400, { error: "Portée invalide." }, corsHeaders);

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "reopen_roster_week", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus (ou exception individuelle).` }, corsHeaders);
    }

    const entryUrl = `${HIST_URL}/${weekKey}/${scope}.json?auth=${idToken}`;
    // Archive AVANT de supprimer — comme pour les semaines de paie,
    // "supprimer" ne détruit jamais vraiment rien.
    const existingRes = await fetch(entryUrl, { headers: { "X-Firebase-ETag": "true" } });
    if (!existingRes.ok) {
      const t = await existingRes.text().catch(()=>"");
      return json(502, { error: `Lecture Firebase impossible (${existingRes.status}) : aucune suppression exécutée. ${t.slice(0,160)}` }, corsHeaders);
    }
    const existing = await existingRes.json();
    if (!existing) return json(404, { error: "Semaine introuvable pour cette portée." }, corsHeaders);
    const sourceEtag = existingRes.headers?.get?.("etag") || null;
    if (!sourceEtag) return json(502, { error: "Firebase n'a pas fourni d'ETag : suppression annulée pour éviter une écriture concurrente." }, corsHeaders);

    const archiveUrl = `${ARCHIVE_URL}/${weekKey}-${scope}/${Date.now()}.json?auth=${idToken}`;
    const archiveRes = await fetch(archiveUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...existing, deletedFromMainHistory: true }) });
    if (!archiveRes.ok) {
      const t = await archiveRes.text().catch(()=>"");
      return json(502, { error: `Archive impossible (${archiveRes.status}) : suppression ANNULÉE. ${t.slice(0,160)}` }, corsHeaders);
    }

    const delRes = await fetch(entryUrl, { method: "DELETE", headers: { "If-Match": sourceEtag } });
    if (!delRes.ok) {
      const t = await delRes.text().catch(()=>"");
      if (delRes.status === 412) return json(409, { error: "La semaine a changé pendant la suppression : opération annulée. Recharge l'historique puis réessaie." }, corsHeaders);
      return json(502, { error: `Échec de la suppression (${delRes.status}) : ${t.slice(0,200)}` }, corsHeaders);
    }

    await logAction({
      action: "semaine_activite_supprimee",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Semaine du ${weekKey} (${scope}) — archivée avant suppression, rien perdu`, idToken,
    }).catch(()=>{});

    return json(200, { ok: true }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(obj) };
}
