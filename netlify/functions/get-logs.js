// ═══════════════════════════════════════════════════════════════════
// get-logs.js — seul moyen de lire les journaux d'action. Vérifie
// view_logs avant de renvoyer quoi que ce soit — jamais juste caché à
// l'écran, comme demandé explicitement dans le cahier des charges.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can, canFor, loadPermissionContext } = require("./permissions");
const { LOGS_URL, logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  // (13/10, section 5) Suppression d'une entrée de log — permission
  // INDIVIDUELLE dédiée (delete_logs), totalement indépendante de
  // view_logs, du Mode troll ou de tout autre droit. Jamais un simple
  // appel direct à cette fonction sans la permission réelle : can()
  // revérifie toujours côté serveur, jamais seulement masqué à l'écran.
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
    const { token, logKey } = body;
    const session = verify(token, SESSION_SECRET);
    if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
    if (!logKey || typeof logKey !== "string") return json(400, { error: "logKey manquant." });

    try {
      const idToken = await getIdToken(session, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const ctx = await loadPermissionContext(idToken);
      if (!can(session.level, "delete_logs", ctx.custom, session.discordId, ctx.individual)) {
        return json(403, { error: `Permission refusée (${session.level}) — la suppression de logs est réservée à OWNER, ou à une exception individuelle explicite.` });
      }

      const entryRes = await fetch(`${LOGS_URL.replace(".json", `/${logKey}.json`)}?auth=${idToken}`);
      if (!entryRes.ok) return json(502, { error: `Lecture impossible (${entryRes.status}).` });
      const entry = await entryRes.json();
      if (!entry) return json(404, { error: "Cette entrée n'existe plus (déjà supprimée ?)." });

      // (14/10, précisé) Jamais effacer discrètement ses PROPRES traces
      // d'administration — SAUF pour OWNER, qui garde l'autorité finale
      // sur l'intégralité du journal. La protection vise à empêcher
      // quelqu'un à qui delete_logs a été délégué individuellement de
      // masquer ses propres actions, pas à limiter OWNER lui-même.
      if (session.level !== "OWNER" && entry.authorDiscordId && entry.authorDiscordId === session.discordId) {
        return json(403, { error: "Impossible de supprimer une entrée dont tu es toi-même l'auteur (intégrité de l'audit)." });
      }

      const delRes = await fetch(`${LOGS_URL.replace(".json", `/${logKey}.json`)}?auth=${idToken}`, { method: "DELETE" });
      if (!delRes.ok) return json(502, { error: `Échec de la suppression (${delRes.status}).` });

      // Trace sécurisée de la suppression elle-même — auteur, date,
      // catégorie et élément concerné — dans le MÊME journal (protégé
      // par la même permission pour être re-supprimée à son tour).
      await logAction({
        action: "log_supprime",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: entry.targetDiscordId || null, targetName: entry.targetName || null,
        details: `Entrée "${entry.action}" du ${new Date(entry.createdAt||0).toLocaleString("fr-FR")} (auteur original : ${entry.authorName||"?"}) supprimée.`,
        idToken,
      }).catch(()=>{});

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  if (!(await canFor(session, "view_logs"))) {
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

async function getIdToken(session, clientEmail, privateKey, webApiKey) {
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: session.discordId, claims: { level: session.level } });
  const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const exchData = await exch.json();
  if (!exch.ok) throw new Error(exchData.error?.message || `${exch.status}`);
  return exchData.idToken;
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
