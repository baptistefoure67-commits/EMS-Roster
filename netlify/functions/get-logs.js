// ═══════════════════════════════════════════════════════════════════
// get-logs.js — seul moyen de lire les journaux d'action. Vérifie
// view_logs avant de renvoyer quoi que ce soit — jamais juste caché à
// l'écran, comme demandé explicitement dans le cahier des charges.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { LOGS_URL } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  if (!can(session.level, "view_logs")) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
  }

  try {
    const customToken = createFirebaseCustomToken({ clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: session.discordId, claims: { level: session.level } });
    const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const exchData = await exch.json();
    if (!exch.ok) throw new Error(exchData.error?.message || `${exch.status}`);
    const idToken = exchData.idToken;

    // Les 500 dernières entrées suffisent largement pour un usage
    // normal — évite de tout retélécharger si le journal grossit
    // beaucoup avec le temps.
    const res = await fetch(`${LOGS_URL}?auth=${idToken}&orderBy="$key"&limitToLast=500`);
    if (!res.ok) return json(502, { error: `Impossible de lire les journaux (${res.status}).` });
    const data = await res.json();
    let entries = data ? Object.entries(data).map(([key, v]) => ({ key, ...v })) : [];
    entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Filtres optionnels — appliqués ici plutôt que côté navigateur,
    // pour ne jamais avoir à faire confiance à un filtrage côté client
    // sur des données qui, elles, restent bien protégées en amont par
    // la vérification view_logs ci-dessus.
    const q = event.queryStringParameters || {};
    if (q.author) entries = entries.filter(e => (e.authorName||"").toLowerCase().includes(q.author.toLowerCase()));
    if (q.target) entries = entries.filter(e => (e.targetName||"").toLowerCase().includes(q.target.toLowerCase()));
    if (q.actionType) entries = entries.filter(e => e.action === q.actionType);
    if (q.dateFrom) entries = entries.filter(e => (e.createdAt||0) >= Number(q.dateFrom));
    if (q.dateTo) entries = entries.filter(e => (e.createdAt||0) <= Number(q.dateTo));
    if (q.search) {
      const s = q.search.toLowerCase();
      entries = entries.filter(e => JSON.stringify(e).toLowerCase().includes(s));
    }

    return json(200, { entries });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
