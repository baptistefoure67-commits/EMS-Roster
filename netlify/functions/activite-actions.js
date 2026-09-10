// ═══════════════════════════════════════════════════════════════════
// activite-actions.js — SEUL point de passage autorisé pour envoyer les
// données Formation/Psychologie (PPA, tests psy, formations,
// recrutements) vers Pillbox. Avant, ceci écrivait directement sur
// Firebase depuis le navigateur, sans aucune vérification — n'importe
// qui (MC compris) pouvait appeler l'adresse Firebase directement.
//
// Vérifie précisément (point 14 du cahier des charges) :
//   - scope "formateur"  → exige send_pillbox_formation
//   - scope "psychologue" → exige send_pillbox_psychologie
//   - scope "all" (ADD+ uniquement) → exige send_pillbox_all
//
// Ne fait JAMAIS confiance à une copie complète envoyée par le
// navigateur — relit toujours le cloud actuel et ne fusionne QUE les
// personnes du scope demandé, exactement comme le fait déjà le Roster
// côté client (même logique, mais maintenant revérifiée ici).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const ACTIVITE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/activiteSuivi.json";

const SCOPE_PERMISSION = {
  formateur: "send_pillbox_formation",
  psychologue: "send_pillbox_psychologie",
  all: "send_pillbox_all",
};
const SCOPE_GRADES = {
  formateur: ["MF", "RF"],
  psychologue: ["MP", "RP"],
  all: ["MF", "RF", "MP", "RP"],
};

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

function activiteKeyFor(e){ return e.idUnique ? `id:${e.idUnique}` : `name:${String(e.name || "").trim().toLowerCase()}`; }

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, scope, activiteData, activiteStreak, closeWeek, action, targetKey } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  // Réinitialisation manuelle d'un suivi d'inactivité (10/09) — action
  // distincte du reste (pas un envoi de données, juste une remise à
  // zéro ciblée) — vérifiée avec sa propre permission, jamais juste un
  // bouton caché côté interface.
  if (action === "resetStreak") {
    if (!can(session.level, "reset_activite_streak")) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
    }
    if (!targetKey || !["formateur", "psychologue"].includes(scope)) {
      return json(400, { error: "Paramètres manquants ou invalides." });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
      const cur = curRes.ok ? await curRes.json().catch(()=>null) : null;
      const mergedStreak = { ...((cur && cur.streak) || {}) };
      mergedStreak[targetKey] = { streak: 0, lastSignaledThreshold: 0 };
      const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: (cur && cur.data) || {}, streak: mergedStreak, savedAt: Date.now() }),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de la réinitialisation (${saveRes.status}) : ${t.slice(0,200)}` }); }

      await logAction({
        action: "reinitialisation_manuelle_suivi",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        details: `Suivi ${scope} réinitialisé pour ${targetKey}`,
        idToken,
      }).catch(()=>{});

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  const permissionNeeded = SCOPE_PERMISSION[scope];
  if (!permissionNeeded) return json(400, { error: `Portée invalide : "${scope}".` });
  if (!can(session.level, permissionNeeded)) {
    return json(403, { error: `Permission refusée (${session.level}) — "${scope}" nécessite ${permissionNeeded}.` });
  }
  if (!activiteData || typeof activiteData !== "object") {
    return json(400, { error: "Données d'activité manquantes ou invalides." });
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    // Relit le Roster ACTUEL pour savoir qui appartient vraiment aux
    // grades du scope demandé — jamais une liste envoyée par le
    // navigateur (elle pourrait prétendre que n'importe qui est MF/RF).
    const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    const employees = (rosterData && rosterData.employees) || [];
    const grades = SCOPE_GRADES[scope];
    const relevantKeys = new Set(
      employees.filter(e => !e.licencie && grades.includes((e.grade || "").toUpperCase())).map(activiteKeyFor)
    );

    // Relit le cloud actuel et ne fusionne QUE les clés autorisées pour
    // ce scope précis — jamais un écrasement complet.
    const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
    const cur = curRes.ok ? await curRes.json().catch(()=>null) : null;
    const mergedData = { ...((cur && cur.data) || {}) };
    const mergedStreak = { ...((cur && cur.streak) || {}) };

    // Instantané AVANT écrasement (09/09) — sert uniquement si
    // closeWeek est demandé, pour garder une vraie trace consultable
    // et réouvrable plus tard (voir roster-week-history.js).
    const beforeSnapshot = {};
    if (closeWeek) {
      relevantKeys.forEach(key => {
        beforeSnapshot[key] = { data: mergedData[key] || null, streak: mergedStreak[key] || null };
      });
    }

    relevantKeys.forEach(key => {
      if (activiteData[key] !== undefined) mergedData[key] = activiteData[key];
      if (activiteStreak && activiteStreak[key] !== undefined) mergedStreak[key] = activiteStreak[key];
    });

    // "streak" peut légitimement finir vide (personne n'a encore de
    // série enregistrée) — dans ce cas, envoyer null plutôt qu'un objet
    // vide {}, car la règle Firebase exige l'un OU l'autre (jamais un
    // objet sans aucune clé). "data" reste toujours tel quel : la règle
    // du dessus exige qu'il existe, jamais null (09/09).
    const streakToSend = Object.keys(mergedStreak).length ? mergedStreak : null;
    const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: mergedData, streak: streakToSend, savedAt: Date.now() }),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    let weekKey = null;
    if (closeWeek) {
      // Clé de semaine = date du jour de la clôture (aucune notion de
      // "début de semaine" n'existait avant côté Roster pour
      // Formateur/Psychologue — on prend simplement la date réelle de
      // clôture, ce qui reste un identifiant stable et unique par jour).
      const d = new Date();
      weekKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const historyEntry = {
        type: scope, closedAt: Date.now(),
        closedByDiscordId: session.discordId, closedByName: session.name, closedByLevel: session.level,
        before: beforeSnapshot,
        after: Object.fromEntries([...relevantKeys].map(k => [k, { data: mergedData[k]||null, streak: mergedStreak[k]||null }])),
        reopened: false,
      };
      const histUrl = `https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteWeekHistory/${weekKey}/${scope}.json?auth=${idToken}`;
      // Archive l'ancienne entrée du jour avant d'écraser (au cas où
      // la même journée serait re-clôturée plusieurs fois) — jamais de
      // perte, même dans ce cas rare.
      try{
        const existingRes = await fetch(histUrl);
        const existing = existingRes.ok ? await existingRes.json() : null;
        if(existing){
          const archiveUrl = `https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteWeekHistoryArchive/${weekKey}-${scope}/${Date.now()}.json?auth=${idToken}`;
          await fetch(archiveUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(existing) });
        }
      }catch(e){ /* non bloquant */ }
      await fetch(histUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(historyEntry) }).catch(()=>{});
    }

    await logAction({
      action: closeWeek ? "cloture_semaine_activite" : "envoi_pillbox",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Portée : ${scope} (${relevantKeys.size} personne(s))${weekKey ? ` — semaine ${weekKey}` : ""}`,
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, data: mergedData, streak: mergedStreak, weekKey });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
