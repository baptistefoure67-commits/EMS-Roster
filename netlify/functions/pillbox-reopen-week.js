// ═══════════════════════════════════════════════════════════════════
// pillbox-reopen-week.js — réouverture d'une semaine de paie clôturée
// (09/09). Réservé à can(level, "reopen_week") — CD et au-dessus par
// défaut, ajustable via les exceptions individuelles comme tout le
// reste. Vérifié ici, jamais seulement caché côté interface.
//
// Ne supprime JAMAIS rien : l'ancienne version reste dans
// pillboxWeekHistory tel quel (juste marquée "reopened"), et sera de
// toute façon archivée automatiquement dans pillboxWeekHistoryArchive
// dès que la semaine sera re-clôturée (voir saveWeekToHistory côté
// Pillbox) — aucune perte de données possible.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const WEEK_HISTORY_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxWeekHistory";
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

    // Vérifie la permission avec les VRAIES exceptions individuelles
    // (jamais juste le grade brut) — un CD pourrait très bien s'être
    // vu retirer cette permission individuellement, ou un MC se
    // l'être vue accordée.
    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "reopen_week", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus (ou exception individuelle).` }, corsHeaders);
    }

    const weekUrl = `${WEEK_HISTORY_BASE}/${weekKey}.json?auth=${idToken}`;
    const weekRes = await fetch(weekUrl);
    const weekData = weekRes.ok ? await weekRes.json() : null;
    if (!weekData) return json(404, { error: "Semaine introuvable." }, corsHeaders);

    // Marque la semaine "réouverte" — ne touche PAS à summary ni
    // sessionSnapshot, qui restent tels quels tant que la semaine
    // n'est pas re-clôturée pour de vrai.
    const patch = { reopened: true, reopenedByDiscordId: session.discordId, reopenedByName: session.name, reopenedByLevel: session.level, reopenedAt: Date.now() };
    await fetch(weekUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });

    await logAction({
      action: "semaine_reouverte", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Semaine du ${weekKey}`, idToken,
    }).catch(()=>{});

    // Renvoie le sessionSnapshot complet — c'est lui que Pillbox va
    // restaurer dans les champs de travail (même mécanisme que
    // restoreFromLocalStorage, juste une source différente).
    return json(200, { ok: true, weekData }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
