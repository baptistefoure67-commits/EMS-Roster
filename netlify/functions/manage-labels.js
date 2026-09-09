// ═══════════════════════════════════════════════════════════════════
// manage-labels.js — lecture publique des libellés de grade
// personnalisés (tout le monde doit pouvoir les VOIR pour que
// l'affichage reste cohérent), écriture réservée à
// can(level, "modify_role_label") — CD, D, OWNER (voir permissions.js).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const LABELS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterGradeLabels.json";
const VALID_GRADES = ["DG","D","CD","ADD","MC","RL","RF","RP","MLP","MP","MF","M","INF","A","WDV","STG"];

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
  if (event.httpMethod === "GET") {
    // Lecture publique — tout le monde doit voir les mêmes libellés,
    // sans avoir besoin d'être ADD+ juste pour AFFICHER le Roster.
    try {
      const res = await fetch(LABELS_URL);
      const overrides = res.ok ? (await res.json()) : {};
      return json(200, { labels: overrides || {} });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, grade, label } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." });
  if (!can(session.level, "modify_role_label")) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à CD et au-dessus.` });
  }
  if (!VALID_GRADES.includes(grade)) return json(400, { error: "Grade invalide." });
  if (typeof label !== "string" || !label.trim() || label.length > 60) {
    return json(400, { error: "Libellé invalide (1 à 60 caractères)." });
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedUrl = `${LABELS_URL}?auth=${idToken}`;

    const res = await fetch(authedUrl);
    const overrides = res.ok ? (await res.json()) : {};
    const before = overrides?.[grade];
    const updated = { ...overrides, [grade]: label.trim() };

    const saveRes = await fetch(authedUrl, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    await logAction({
      action: "modification_libelle_grade",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Grade ${grade}`, oldValue: before, newValue: label.trim(),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
