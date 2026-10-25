// Gestion de la matrice de permissions regroupées par grade.
// Toute modification est vérifiée côté serveur et journalisée.

const { verify } = require("./session-token");
const {
  canFor, buildEffectivePermissions, DEFAULT_PERMISSIONS, LEVELS,
  GRADE_PERMISSION_KEYS, LEGACY_PERMISSION_ALIASES, canonicalPermissionName,
  mayEditTargetLevel,
} = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const OVERRIDE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionsOverride.json";

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  // permissionsWrite n'est jamais renvoyé au navigateur : ce jeton est créé
  // et utilisé uniquement par cette fonction après contrôle de session.
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, permissionsWrite: true, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

function cleanLegacyGroupKeys(obj, canonical){
  for(const [legacy, target] of Object.entries(LEGACY_PERMISSION_ALIASES)){
    if(target === canonical && legacy !== canonical) delete obj[legacy];
  }
}

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  const token = event.httpMethod === "GET"
    ? ((event.queryStringParameters && event.queryStringParameters.token) || "")
    : (()=>{ try{return JSON.parse(event.body||"{}").token||"";}catch(e){return "";} })();
  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." });
  if (!(await canFor(session, "manage_permissions"))) {
    return json(403, { error: `Permission refusée (${session.level}) — il faut « Gérer les permissions ».` });
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    if (event.httpMethod === "GET") {
      const res = await fetch(`${OVERRIDE_URL}?auth=${idToken}`);
      const overrides = res.ok ? (await res.json()) : null;
      const effective = buildEffectivePermissions(overrides || {});
      const editableLevels = LEVELS.filter(l => l !== "OWNER" && mayEditTargetLevel(session.level, l));
      const editablePermissions = [];
      for(const p of GRADE_PERMISSION_KEYS){
        if(session.level === "OWNER" || await canFor(session, p, idToken)) editablePermissions.push(p);
      }
      return json(200, {
        permissions: effective,
        defaults: DEFAULT_PERMISSIONS,
        levels: LEVELS,
        gradePermissionKeys: GRADE_PERMISSION_KEYS,
        editableLevels,
        editablePermissions,
      });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
    const { level: targetLevel, permissionName, value } = body;
    const canonical = canonicalPermissionName(permissionName);

    if (!LEVELS.includes(targetLevel) || targetLevel === "OWNER") {
      return json(400, { error: "Niveau cible invalide (OWNER n'est jamais modifiable)." });
    }
    if (!GRADE_PERMISSION_KEYS.includes(canonical)) {
      return json(400, { error: `Permission non modifiable par grade : "${permissionName}".` });
    }
    if (!mayEditTargetLevel(session.level, targetLevel)) {
      return json(403, { error: `Tu ne peux pas modifier un niveau supérieur à ton propre niveau (${session.level}).` });
    }
    if (canonical === "manage_permissions" && session.level !== "OWNER") {
      return json(403, { error: "Seul l'OWNER peut déléguer ou retirer « Gérer les permissions » par grade." });
    }
    // Un gestionnaire délégué ne peut distribuer que les droits dont il
    // dispose lui-même. OWNER est l'unique exception.
    if (session.level !== "OWNER" && !(await canFor(session, canonical, idToken))) {
      return json(403, { error: `Tu ne peux pas attribuer « ${canonical} » : cette permission dépasse tes propres droits.` });
    }

    // (24/10, audit) Lecture + écriture CIBLÉES sur CE grade uniquement —
    // avant, toute la branche rosterPermissionsOverride était relue puis
    // réécrite en entier ; une panne de lecture suivie d'une écriture
    // réussie pouvait donc effacer les réglages de tous les autres grades
    // pour ne garder que celui-ci. Plus aucun autre grade n'est jamais lu
    // ni réécrit par cette action.
    const gradeUrl = `${OVERRIDE_URL.replace(/\.json$/, "")}/${encodeURIComponent(targetLevel)}.json?auth=${idToken}`;
    const res = await fetch(gradeUrl);
    if (!res.ok) return json(502, { error: `Permissions de ce grade illisibles (${res.status}) — changement refusé pour ne pas écraser les réglages existants.` });
    const target = { ...((await res.json().catch(()=>null)) || {}) };
    const before = target[canonical];
    cleanLegacyGroupKeys(target, canonical);
    target[canonical] = !!value;

    const saveRes = await fetch(gradeUrl, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target),
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>"");
      return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` });
    }

    await logAction({
      action: "modification_permission",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Permission "${canonical}" pour ${targetLevel}`,
      oldValue: before, newValue: !!value,
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, permissionName: canonical });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
