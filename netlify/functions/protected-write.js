// ═══════════════════════════════════════════════════════════════════
// protected-write.js — passage obligé pour les actions sensibles sur le
// Roster (modifier un employé, licencier). Vérifie le NIVEAU réel
// (MC/ADD/CD/D/OWNER, jamais un grade envoyé par le navigateur) via le
// module centralisé permissions.js, et journalise chaque action.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can, LEVELS, canFor } = require("./permissions");
const { logAction } = require("./logs");

// (11/10 — audit de sécurité) Deux vrais problèmes trouvés dans cette
// fonction, corrigés ici :
//  1. editEmployee laissait n'importe quel ADD/CD donner N'IMPORTE
//     QUEL grade (DG inclus) à n'importe qui, sans ancienneté, ni
//     quota, ni spécialité — maintenant réservé D+ pour changer le
//     grade ; ADD/CD gardent la main sur nom/ID Discord/rôle.
//  2. licencier laissait le même licencier un grade supérieur au sien
//     — maintenant interdit pour ADD/CD si la cible a un grade
//     administratif (MC/ADD/CD/D/DG) égal ou supérieur au leur ; D+
//     garde l'accès complet, comme avant pour les deux.
function rankOf(level){ return LEVELS.indexOf(level); } // -1 si pas un grade administratif
function isDPlus(level){ return ["D","DG","OWNER"].includes(level); }

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
  if (!(await canFor(session, "manage_roster"))) {
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
      const idx = employees.findIndex((e) => String(e.id) === String(id));
      if (idx === -1) return json(404, { error: "Employé introuvable." });
      const before = { ...employees[idx] };
      // (11/10 — audit) Changement de grade réservé D+ — un vrai
      // changement de grade passe par le système de promotion (Pillbox)
      // ou par un D+, jamais par cette fiche générique pour ADD/CD.
      if (grade && grade !== before.grade && !isDPlus(session.level)) {
        return json(403, { error: `Permission refusée (${session.level}) — le changement de grade est réservé à D et au-dessus. Corrige le nom ou l'ID Discord si besoin, ou passe par le système de promotion pour le grade.` });
      }
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
      const target = employees.find((e) => String(e.id) === String(id));
      if (!target) return json(404, { error: "Employé introuvable." });
      // (11/10 — audit) Un ADD/CD ne peut pas licencier quelqu'un d'un
      // grade administratif égal ou supérieur au sien (MC/ADD/CD/D/DG) —
      // D+ garde l'accès complet, comme avant.
      if (!isDPlus(session.level) && rankOf(target.grade) !== -1 && rankOf(target.grade) >= rankOf(session.level)) {
        return json(403, { error: `Permission refusée (${session.level}) — tu ne peux pas licencier quelqu'un d'un grade égal ou supérieur au tien.` });
      }
      employees = employees.filter((e) => String(e.id) !== String(id));
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

    // (16/10) Diagnostic avant écriture : Firebase valide TOUT le tableau
    // employees à chaque sauvegarde, pas seulement la personne qu'on
    // modifie — une seule fiche avec un champ manquant/vide ailleurs
    // dans le roster (ex: ID Discord resté vide depuis un ancien import)
    // suffit à faire échouer N'IMPORTE QUELLE modification, même sans
    // rapport avec elle. Firebase ne dit jamais QUI a posé problème
    // ("permission denied" générique) — on le vérifie donc nous-mêmes
    // AVANT d'écrire, pour donner une erreur exploitable plutôt qu'un
    // simple 502 impossible à diagnostiquer à distance.
    const GRADE_RE = /^(DG|D|CD|ADD|MC|RL|RF|RP|MLP|MP|MF|M|INF|A|WDV|STG)$/;
    const badEmployees = [];
    employees.forEach((e, i) => {
      const problems = [];
      if (typeof e.name !== "string" || !e.name.trim() || e.name.length >= 100 || /[<>]/.test(e.name)) problems.push("nom invalide ou vide");
      if (typeof e.discordId !== "string" || !e.discordId.trim() || e.discordId.length >= 30) problems.push("ID Discord vide ou invalide");
      if (typeof e.grade !== "string" || !GRADE_RE.test(e.grade)) problems.push(`grade invalide ("${e.grade}")`);
      if (problems.length) badEmployees.push(`${e.name || `(sans nom, position ${i})`} : ${problems.join(", ")}`);
    });
    if (badEmployees.length) {
      return json(422, {
        error: `Impossible d'enregistrer : ${badEmployees.length} fiche(s) du roster ont un champ invalide qui bloque TOUTE sauvegarde (pas seulement celle-ci) — corrige-les d'abord : ${badEmployees.slice(0, 5).join(" ; ")}${badEmployees.length > 5 ? ` ; (+${badEmployees.length - 5} autre(s))` : ""}`,
      });
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
