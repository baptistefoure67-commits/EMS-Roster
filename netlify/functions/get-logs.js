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
  // OWNER uniquement (delete_logs), totalement indépendante de
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
      // (24/10, bloc 2) Réservé dans les faits à OWNER et DG — OWNER passe
      // toujours (can() le laisse systématiquement passer), un DG a BESOIN
      // en plus de la vraie permission individuelle "delete_logs" (jamais
      // de grade seul, jamais déléguée plus bas que DG, voir permissions.js).
      if (session.level !== "OWNER" && session.level !== "DG") {
        return json(403, { error: `Permission refusée (${session.level}) — la suppression de logs est réservée à OWNER et DG.` });
      }
      let ctx;
      try{ ctx = await loadPermissionContext(idToken, {strict:true}); }
      catch(e){ return json(502, { error: "Permissions illisibles — suppression refusée." }); }
      if (!can(session.level, "delete_logs", ctx.custom, session.discordId, ctx.individual)) {
        return json(403, { error: `Permission refusée (${session.level}) — la permission individuelle "Supprimer un log" doit t'être accordée.` });
      }

      const entryRes = await fetch(`${LOGS_URL.replace(".json", `/${logKey}.json`)}?auth=${idToken}`);
      if (!entryRes.ok) return json(502, { error: `Lecture impossible (${entryRes.status}).` });
      const entry = await entryRes.json();
      if (!entry) return json(404, { error: "Cette entrée n'existe plus (déjà supprimée ?)." });

      // (14/10, précisé) Jamais effacer discrètement ses PROPRES traces
      // d'administration. delete_logs n'est plus délégable : seul OWNER
      // peut atteindre ce bloc avec succès.
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

      // (24/10, bloc 2, point 18) Quand un DG supprime un log, OWNER garde
      // une petite trace CACHÉE de cette suppression — dans une branche à
      // part, jamais lue par get-logs.js pour l'affichage normal, visible
      // uniquement via une lecture OWNER directe de rosterLogsHiddenTrace.
      // Un DG qui supprime garde donc une trace que lui-même ne voit pas.
      if (session.level === "DG") {
        const hiddenKey = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        // Réutilise le jeton serveur déjà obtenu pour CETTE session DG
        // (déjà server:true, c'est ce que la règle Firebase exige pour
        // cette branche — pas besoin d'en fabriquer un second).
        await fetch(`${LOGS_URL.replace("rosterLogs.json", `rosterLogsHiddenTrace/${hiddenKey}.json`)}?auth=${idToken}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deletedByDiscordId: session.discordId, deletedByName: session.name, deletedByLevel: session.level,
            deletedEntry: entry, createdAt: Date.now(),
          }),
        }).catch(()=>{});
      }

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  // (24/10, bloc 2, point 18) Lecture OWNER de la trace cachée des
  // suppressions faites par un DG — jamais mélangée à la liste normale,
  // jamais visible par un DG (même celui qui a supprimé).
  if (event.queryStringParameters && event.queryStringParameters.hiddenTrace === "1") {
    if (session.level !== "OWNER") return json(403, { error: "Réservé à OWNER." });
    try {
      const idToken = await getIdToken(session, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const res = await fetch(`${LOGS_URL.replace("rosterLogs.json","rosterLogsHiddenTrace.json")}?auth=${idToken}`);
      if (!res.ok) return json(502, { error: `Lecture impossible (${res.status}).` });
      const data = await res.json();
      const entries = data ? Object.entries(data).map(([key, v]) => ({ key, ...v })).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)) : [];
      return json(200, { entries });
    } catch (err) { return json(500, { error: `Erreur inattendue : ${err.message}` }); }
  }

  if (!(await canFor(session, "view_logs"))) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
  }

  try {
    const customToken = createFirebaseCustomToken({ clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: session.discordId, claims: { level: session.level, server: true } });
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

    // (24/10, bloc 2, point 19) Conservation 13 jours : les entrées plus
    // vieilles ne sont jamais montrées, et sont supprimées en tâche de
    // fond (best-effort, jamais bloquant pour la lecture elle-même — pas
    // besoin d'une tâche planifiée séparée, le nettoyage se fait tout
    // seul à la prochaine consultation des logs).
    const RETENTION_MS = 13 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - RETENTION_MS;
    const expired = entries.filter(e => (e.createdAt || 0) < cutoff);
    entries = entries.filter(e => (e.createdAt || 0) >= cutoff);
    if (expired.length) {
      Promise.all(expired.map(e =>
        fetch(`${LOGS_URL.replace(".json", `/${e.key}.json`)}?auth=${idToken}`, { method: "DELETE" }).catch(()=>{})
      )).catch(()=>{});
    }

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
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: session.discordId, claims: { level: session.level, server: true } });
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
