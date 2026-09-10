// ═══════════════════════════════════════════════════════════════════
// protected-write.js — passage obligé pour les actions sensibles sur le
// Roster (modifier un employé, licencier). Vérifie le NIVEAU réel
// (MC/ADD/CD/D/OWNER, jamais un grade envoyé par le navigateur) via le
// module centralisé permissions.js, et journalise chaque action.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur (variables Firebase/SESSION_SECRET)." });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Requête invalide (JSON attendu)." });
  }

  const { token, action, payload } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) {
    return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  }
  if (!can(session.level, "manage_roster")) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
  }

  try {
    const idToken = await getFirebaseIdToken(
      session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY
    );
    const authedRosterUrl = `${ROSTER_URL}?auth=${idToken}`;

    const rosterRes = await fetch(authedRosterUrl);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    let employees = (rosterData && rosterData.employees) || [];

    if (action === "editEmployee") {
      const { id, name, discordId, grade, role } = payload || {};
      const idx = employees.findIndex((e) => e.id === id);
      if (idx === -1) return json(404, { error: "Employé introuvable." });
      const before = { ...employees[idx] };
      employees[idx] = {
        ...employees[idx],
        name: name || employees[idx].name,
        discordId: discordId || employees[idx].discordId,
        grade: grade || employees[idx].grade,
        role: role !== undefined ? role : employees[idx].role,
      };
      await logAction({
        action: "modification_employe",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: employees[idx].discordId, targetName: employees[idx].name,
        oldValue: `${before.grade} / ${before.name} / ${before.discordId}`,
        newValue: `${employees[idx].grade} / ${employees[idx].name} / ${employees[idx].discordId}`,
        idToken,
      }).catch(()=>{});
    } else if (action === "licencier") {
      const { id } = payload || {};
      const before = employees.length;
      const target = employees.find((e) => e.id === id);
      employees = employees.filter((e) => e.id !== id);
      if (employees.length === before) return json(404, { error: "Employé introuvable." });
      await logAction({
        action: "licenciement",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: target?.discordId, targetName: target?.name,
        details: `Grade au moment du licenciement : ${target?.grade}`,
        idToken,
      }).catch(()=>{});
    } else {
      return json(400, { error: `Action inconnue : "${action}".` });
    }

    const savedAt = Date.now();
    const saveRes = await fetch(authedRosterUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employees, savedAt }),
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(() => "");
      return json(502, { error: `Échec de l'écriture sur Firebase (${saveRes.status}) : ${t.slice(0, 200)}` });
    }

    return json(200, { ok: true, employees, savedAt });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
