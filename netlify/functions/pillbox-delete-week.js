// ═══════════════════════════════════════════════════════════════════
// pillbox-delete-week.js — suppression d'une semaine de l'historique
// (09/09). Réservé à can(level, "delete_week") — ADD et au-dessus par
// défaut, ajustable via les exceptions individuelles. Avant existait
// un bouton "Supprimer" sans AUCUNE vérification — corrigé ici.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const WEEK_HISTORY_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxWeekHistory";
const ARCHIVE_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxWeekHistoryArchive";
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
  const { token, weekKey } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." }, corsHeaders);
  if (!weekKey || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(weekKey)) {
    return json(400, { error: "Semaine invalide." }, corsHeaders);
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "delete_week", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus (ou exception individuelle).` }, corsHeaders);
    }

    const weekUrl = `${WEEK_HISTORY_BASE}/${weekKey}.json?auth=${idToken}`;
    // Archive AVANT de supprimer — "supprimer" ne détruit donc jamais
    // vraiment rien, la donnée reste consultable dans
    // pillboxWeekHistoryArchive (section "je ne veux pas simplement
    // supprimer une semaine" du cahier des charges).
    const existingRes = await fetch(weekUrl);
    const existing = existingRes.ok ? await existingRes.json() : null;
    if (!existing) return json(404, { error: "Semaine introuvable." }, corsHeaders);

    const archiveUrl = `${ARCHIVE_BASE}/${weekKey}/${Date.now()}.json?auth=${idToken}`;
    await fetch(archiveUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...existing, deletedFromMainHistory: true }) });

    const delRes = await fetch(weekUrl, { method: "DELETE" });
    if (!delRes.ok) { const t = await delRes.text().catch(()=>""); return json(502, { error: `Échec de la suppression (${delRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }

    await logAction({
      action: "semaine_supprimee", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Semaine du ${weekKey} (archivée avant suppression, rien perdu)`, idToken,
    }).catch(()=>{});

    return json(200, { ok: true }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
