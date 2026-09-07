// ═══════════════════════════════════════════════════════════════════
// protected-write.js — SEUL point de passage autorisé pour les actions
// sensibles du Roster (modifier un employé, licencier...). Le
// navigateur ne peut plus écrire directement sur Firebase pour ces
// actions-là — il doit passer par ici, avec un jeton valide.
//
// Ce que fait cette fonction, dans l'ordre, à CHAQUE appel :
//  1. Vérifie que le jeton envoyé est authentique et pas expiré
//     (session-token.js — recalcul de la signature, jamais une
//     confiance aveugle dans ce que le navigateur affirme).
//  2. Vérifie que le grade contenu dans CE jeton (pas un grade envoyé
//     à part par le navigateur — ça, il ne faut jamais y faire
//     confiance) est bien MC ou au-dessus.
//  3. Seulement si les deux passent : elle lit le Roster actuel,
//     applique le changement demandé, et le sauvegarde.
//
// Actions actuellement protégées ici : "editEmployee" (modifier un
// employé) et "licencier" (retirer un employé actif) — les deux points
// les plus sensibles du Roster. D'autres actions pourront être
// ajoutées au même endroit plus tard, sur ce même modèle.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const ALLOWED_GRADES = ["DG", "D", "CD", "ADD", "MC"];

exports.handler = async function (event) {
  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) {
    return json(500, { error: "Configuration manquante côté serveur (SESSION_SECRET)." });
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

  // 1) et 2) — Jeton authentique, pas expiré, grade suffisant. Tout ça
  // recalculé ici, jamais accepté tel quel depuis le navigateur.
  const session = verify(token, SESSION_SECRET);
  if (!session) {
    return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  }
  if (!ALLOWED_GRADES.includes(session.grade)) {
    return json(403, { error: `Grade insuffisant (${session.grade}) — action réservée à MC et au-dessus.` });
  }

  try {
    // Toujours relire le Roster ACTUEL au moment de l'action (jamais se
    // fier à une copie locale envoyée par le navigateur) — évite qu'une
    // vieille version écrase un changement fait entre-temps par
    // quelqu'un d'autre.
    const rosterRes = await fetch(ROSTER_URL);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    let employees = (rosterData && rosterData.employees) || [];

    if (action === "editEmployee") {
      const { id, name, discordId, grade, role } = payload || {};
      const idx = employees.findIndex((e) => e.id === id);
      if (idx === -1) return json(404, { error: "Employé introuvable." });
      employees[idx] = {
        ...employees[idx],
        name: name || employees[idx].name,
        discordId: discordId || employees[idx].discordId,
        grade: grade || employees[idx].grade,
        role: role !== undefined ? role : employees[idx].role,
      };
    } else if (action === "licencier") {
      const { id } = payload || {};
      const before = employees.length;
      employees = employees.filter((e) => e.id !== id);
      if (employees.length === before) return json(404, { error: "Employé introuvable." });
    } else {
      return json(400, { error: `Action inconnue : "${action}".` });
    }

    const saveRes = await fetch(ROSTER_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employees, savedAt: Date.now() }),
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(() => "");
      return json(502, { error: `Échec de l'écriture sur Firebase (${saveRes.status}) : ${t.slice(0, 200)}` });
    }

    return json(200, { ok: true, employees });
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
