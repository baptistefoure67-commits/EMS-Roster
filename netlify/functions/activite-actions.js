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
  const { token, scope, activiteData, activiteStreak } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

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
    relevantKeys.forEach(key => {
      if (activiteData[key] !== undefined) mergedData[key] = activiteData[key];
      if (activiteStreak && activiteStreak[key] !== undefined) mergedStreak[key] = activiteStreak[key];
    });

    console.log("DEBUG activite-actions — scope:", scope, "level:", session.level, "relevantKeys:", [...relevantKeys], "mergedData vide ?", Object.keys(mergedData).length === 0, "mergedStreak vide ?", Object.keys(mergedStreak).length === 0);
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
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>"");
      console.log("DEBUG activite-actions — échec Firebase, statut:", saveRes.status, "corps:", t);
      return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` });
    }

    await logAction({
      action: "envoi_pillbox",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Portée : ${scope} (${relevantKeys.size} personne(s))`,
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, data: mergedData, streak: mergedStreak });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
