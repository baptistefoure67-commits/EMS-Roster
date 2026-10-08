// ═══════════════════════════════════════════════════════════════════
// absences-actions.js — suivi des absences de plus de 3 jours (03/10).
// Détecte → conserve → laisse un responsable décider (jamais de
// rétrogradation/licenciement automatique ici, voir section 17 du
// cahier des charges). Chemin Firebase dédié : rosterAbsences — séparé
// de rosterEmsData, jamais une deuxième source manuelle qui pourrait
// entrer en contradiction avec le Tableau EMS.
//
// Deux actions :
//   - "sync"            : fusionne les absences qualifiantes (>3 jours)
//                          détectées dans un collage EMS. Ne touche
//                          JAMAIS une entrée déjà connue (son statut
//                          Prise en compte reste tel quel) — ne fait
//                          qu'ajouter les nouvelles. Réservé
//                          can(level, "manage_absences").
//   - "setPriseEnCompte" : bascule OUI/NON une absence précise, sans
//                          jamais la supprimer (section 6-7 du cahier
//                          des charges). Réservé can(level,
//                          "manage_absences"), tracé dans les logs.
//
// GET : liste complète, réservée à une session valide avec
// can(level, "view_roster") — comme le reste du Roster, jamais public.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const ABSENCES_URL = `${BASE}/rosterAbsences.json`;
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

// Clé stable pour éviter les doublons lors de synchronisations répétées
// (section 13 du cahier des charges) : employé + dates exactes de
// l'absence. Une même absence recollée plusieurs fois donne toujours
// la même clé, donc jamais une deuxième ligne.
function absenceKey(employeeKey, startIso, endIso){
  return `${employeeKey}__${startIso}__${endIso}`;
}

// Détection du signalement (section 8) : 3 absences PRISES EN COMPTE
// (priseEnCompte=true) dont la date de FIN tombe dans les 30 derniers
// jours glissants par rapport à refDate (par défaut maintenant) — pas
// un mois civil (section 8, avertissement explicite). Groupe par
// employeeKey ; une absence très longue (14j, 20j...) ne compte
// toujours que pour UNE (section 19) puisqu'elle n'a qu'une seule clé.
// Exporté pour être réutilisé tel quel par pillbox-proxy.js, sans
// dupliquer cette règle ailleurs.
function computeAbsenceSignalements(absencesObj, refDate){
  const ref = refDate || new Date();
  const windowStart = new Date(ref.getTime() - 30*24*60*60*1000);
  const byEmployee = {};
  Object.entries(absencesObj || {}).forEach(([id, a]) => {
    if (!a || a.priseEnCompte !== true) return;
    const end = new Date(a.endIso);
    if (isNaN(end.getTime()) || end < windowStart || end > ref) return;
    const key = a.employeeKey;
    (byEmployee[key] = byEmployee[key] || { employeeKey: key, name: a.name, grade: a.grade, absences: [] }).absences.push({ id, startIso: a.startIso, endIso: a.endIso, durationDays: a.durationDays });
  });
  return Object.values(byEmployee).filter(e => e.absences.length >= 3);
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  if (event.httpMethod === "GET") {
    const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
    const session = verify(token, SESSION_SECRET);
    if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
    if (!can(session.level, "view_roster")) {
      return json(403, { error: `Permission refusée (${session.level}).` });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const res = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const all = res.ok ? (await res.json()) : {};
      return json(200, { absences: all || {}, signalements: computeAbsenceSignalements(all) });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, action } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "manage_absences", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus (ou exception individuelle).` });
    }

    if (action === "sync") {
      const { qualifyingAbsences } = body;
      if (!Array.isArray(qualifyingAbsences)) {
        return json(400, { error: "Liste d'absences manquante ou invalide." });
      }
      const curRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const current = curRes.ok ? (await curRes.json()) || {} : {};
      let added = 0;
      qualifyingAbsences.forEach(a => {
        if (!a || !a.employeeKey || !a.startIso || !a.endIso || !a.name) return;
        const key = absenceKey(a.employeeKey, a.startIso, a.endIso);
        // N'ajoute QUE si inconnue — ne touche JAMAIS une entrée déjà
        // là (section 7 : jamais revenir sur une décision Prise en
        // compte déjà posée, même en recollant le même tableau).
        if (current[key]) return;
        current[key] = {
          employeeKey: a.employeeKey, name: a.name, grade: a.grade || null,
          startIso: a.startIso, endIso: a.endIso, durationDays: a.durationDays || null,
          priseEnCompte: true, // valeur par défaut (section 6)
          createdAt: Date.now(),
        };
        added++;
      });
      if (added > 0) {
        const saveRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
        });
        if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }
        await logAction({
          action: "absences_synchronisees",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          details: `${added} nouvelle(s) absence(s) qualifiante(s) ajoutée(s)`,
          idToken,
        }).catch(()=>{});
      }
      return json(200, { ok: true, added, absences: current });
    }

    if (action === "setPriseEnCompte") {
      const { absenceId, priseEnCompte } = body;
      if (!absenceId || typeof priseEnCompte !== "boolean") {
        return json(400, { error: "Paramètres manquants ou invalides." });
      }
      const curRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const current = curRes.ok ? (await curRes.json()) || {} : {};
      const entry = current[absenceId];
      if (!entry) return json(404, { error: "Absence introuvable." });
      const before = entry.priseEnCompte;
      entry.priseEnCompte = priseEnCompte;
      const saveRes = await fetch(`${ABSENCES_URL.replace(".json", `/${absenceId}.json`)}?auth=${idToken}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priseEnCompte }),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }
      await logAction({
        action: "absence_prise_en_compte_modifiee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetName: entry.name,
        oldValue: before ? "OUI" : "NON", newValue: priseEnCompte ? "OUI" : "NON",
        details: `Absence du ${entry.startIso} au ${entry.endIso}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, entry });
    }

    return json(400, { error: `Action inconnue : "${action}".` });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) };
}

module.exports.computeAbsenceSignalements = computeAbsenceSignalements;
module.exports.absenceKey = absenceKey;
