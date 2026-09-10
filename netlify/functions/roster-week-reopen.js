// ═══════════════════════════════════════════════════════════════════
// roster-week-reopen.js — réouverture d'une semaine Formation/
// Psychologue clôturée côté Roster (09/09). Réservé à
// can(level, "reopen_roster_week") — CD et au-dessus par défaut,
// ajustable via les exceptions individuelles. Vérifié ici, jamais
// juste caché côté interface.
//
// Ne supprime ni ne recrée jamais rien : restaure l'état "avant
// clôture" dans activiteSuivi (pour permettre la correction), marque
// l'entrée d'historique "reopened", et archive systématiquement toute
// version écrasée plus tard (voir activite-actions.js) — jamais de
// perte de données.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const ACTIVITE_URL = `${BASE}/activiteSuivi.json`;
const INDIVIDUAL_URL = `${BASE}/rosterIndividualPermissions.json`;

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
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, weekKey, scope } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  if (!weekKey || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(weekKey)) return json(400, { error: "Semaine invalide." });
  if (!["formateur", "psychologue"].includes(scope)) return json(400, { error: "Portée invalide." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "reopen_roster_week", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus (ou exception individuelle).` });
    }

    const histUrl = `${BASE}/rosterActiviteWeekHistory/${weekKey}/${scope}.json?auth=${idToken}`;
    const histRes = await fetch(histUrl);
    const histEntry = histRes.ok ? await histRes.json() : null;
    if (!histEntry) return json(404, { error: "Semaine introuvable pour cette portée." });

    // Restaure l'état "avant clôture" dans activiteSuivi (LIVE), pour
    // que la personne puisse corriger normalement dans l'onglet
    // Formateur/Psychologue, exactement comme si la semaine n'avait
    // jamais été clôturée.
    const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
    const cur = curRes.ok ? await curRes.json().catch(()=>null) : null;
    const mergedData = { ...((cur && cur.data) || {}) };
    const mergedStreak = { ...((cur && cur.streak) || {}) };
    Object.entries(histEntry.before || {}).forEach(([key, snap]) => {
      if (snap.data) mergedData[key] = snap.data;
      if (snap.streak) mergedStreak[key] = snap.streak;
    });
    const streakToSend = Object.keys(mergedStreak).length ? mergedStreak : null;
    const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: mergedData, streak: streakToSend, savedAt: Date.now() }),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de la restauration (${saveRes.status}) : ${t.slice(0,200)}` }); }

    // Marque l'entrée d'historique "reopened" — jamais supprimée.
    await fetch(histUrl, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reopened: true, reopenedByDiscordId: session.discordId, reopenedByName: session.name, reopenedByLevel: session.level, reopenedAt: Date.now() }),
    });

    await logAction({
      action: "semaine_activite_reouverte",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Semaine du ${weekKey} (${scope})`, idToken,
    }).catch(()=>{});

    return json(200, { ok: true, restoredKeys: Object.keys(histEntry.before || {}) });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
