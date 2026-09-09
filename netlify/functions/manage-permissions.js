// ═══════════════════════════════════════════════════════════════════
// manage-permissions.js — lecture/modification de la table des
// permissions, réservée à can(level, "manage_permissions") (D et
// OWNER, voir permissions.js). Toute modification est journalisée.
//
// Protection spéciale : la permission "manage_permissions" elle-même
// ne peut être modifiée QUE par l'OWNER — même un D ne peut pas
// l'accorder à quelqu'un d'autre, pour éviter de contourner le
// contrôle OWNER (demandé explicitement dans le cahier des charges).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { can, buildEffectivePermissions, DEFAULT_PERMISSIONS, LEVELS } = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const OVERRIDE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionsOverride.json";

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
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  if (event.httpMethod === "GET") {
    const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
    const session = verify(token, SESSION_SECRET);
    if (!session) return json(401, { error: "Session invalide ou expirée." });
    if (!can(session.level, "manage_permissions")) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à D et OWNER.` });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const res = await fetch(`${OVERRIDE_URL}?auth=${idToken}`);
      const overrides = res.ok ? (await res.json()) : null;
      const effective = buildEffectivePermissions(overrides || {});
      return json(200, { permissions: effective, defaults: DEFAULT_PERMISSIONS, levels: LEVELS });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, level: targetLevel, permissionName, value } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." });
  if (!can(session.level, "manage_permissions")) {
    return json(403, { error: `Permission refusée (${session.level}) — réservé à D et OWNER.` });
  }
  if (!LEVELS.includes(targetLevel) || targetLevel === "OWNER") {
    return json(400, { error: "Niveau cible invalide (OWNER n'est jamais modifiable)." });
  }
  // Garde-fou explicite du cahier des charges : même un D ne peut pas
  // toucher à manage_permissions lui-même — seul OWNER le peut.
  if (permissionName === "manage_permissions" && session.level !== "OWNER") {
    return json(403, { error: "Seul l'OWNER peut modifier la permission manage_permissions elle-même." });
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedUrl = `${OVERRIDE_URL}?auth=${idToken}`;

    const res = await fetch(authedUrl);
    const overrides = res.ok ? (await res.json()) : {};
    const before = overrides?.[targetLevel]?.[permissionName];

    const updated = { ...overrides, [targetLevel]: { ...(overrides?.[targetLevel] || {}), [permissionName]: !!value } };
    const saveRes = await fetch(authedUrl, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    await logAction({
      action: "modification_permission",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Permission "${permissionName}" pour ${targetLevel}`,
      oldValue: before, newValue: !!value,
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
