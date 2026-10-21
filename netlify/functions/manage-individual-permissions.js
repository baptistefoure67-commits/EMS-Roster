// Exceptions individuelles — intégrées à la permission unique
// « Gérer les permissions ». Un gestionnaire ne peut attribuer que les
// permissions dont il dispose lui-même. OWNER reste protégé et intouchable.

const { verify } = require("./session-token");
const {
  can, canFor, loadPermissionContext, LEVELS, OWNER_DISCORD_ID,
  INDIVIDUAL_DECISION_AUTHORITY_ORDER, buildEffectivePermissions,
  GRADE_PERMISSION_KEYS, INDIVIDUAL_ONLY_KEYS, INDIVIDUAL_PERMISSION_KEYS,
  LEGACY_PERMISSION_ALIASES, canonicalPermissionName,
} = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const INDIVIDUAL_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions.json";
const GRADE_OVERRIDE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionsOverride.json";
const DECISION_LEVELS = ["CD", "D", "DG"];

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, permissionsWrite: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

function legacyKeysFor(canonical){
  return Object.entries(LEGACY_PERMISSION_ALIASES).filter(([,v])=>v===canonical).map(([k])=>k);
}
function cloneEntry(v){ return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; }
function normalizePersonForDisplay(person){
  const src = person && typeof person === "object" ? person : {};
  const out = { ...src };
  for(const canonical of INDIVIDUAL_PERMISSION_KEYS){
    if(out[canonical]) continue;
    for(const legacy of legacyKeysFor(canonical)){
      if(src[legacy]) { out[canonical] = cloneEntry(src[legacy]); break; }
    }
  }
  return out;
}
function normalizeAllForDisplay(all){
  const out = {};
  for(const [id, person] of Object.entries(all || {})) out[id] = normalizePersonForDisplay(person);
  return out;
}

function effectiveLayerFor(session){
  return session.level === "OWNER" ? "DG" : (DECISION_LEVELS.includes(session.level) ? session.level : "CD");
}

async function grantableKeys(session, idToken){
  if(session.level === "OWNER") return [...INDIVIDUAL_PERMISSION_KEYS];
  const ctx = await loadPermissionContext(idToken).catch(()=>({custom:null,individual:null}));
  const list = [];
  for(const p of GRADE_PERMISSION_KEYS){
    if(can(session.level, p, ctx.custom, session.discordId, ctx.individual)) list.push(p);
  }
  // Mode troll est accordable uniquement si le gestionnaire le possède déjà.
  if(can(session.level, "manage_troll", ctx.custom, session.discordId, ctx.individual)) list.push("manage_troll");
  // owner_delegate n'est jamais accordable par un non-OWNER.
  return list;
}

exports.handler = async function (event) {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  const token = event.httpMethod === "GET"
    ? ((event.queryStringParameters && event.queryStringParameters.token) || "")
    : (()=>{ try{return JSON.parse(event.body||"{}").token||"";}catch(e){return "";} })();
  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);
  if (!(await canFor(session, "manage_permissions"))) {
    return json(403, { error: `Permission refusée (${session.level}) — il faut « Gérer les permissions ».` }, corsHeaders);
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const allowed = await grantableKeys(session, idToken);

    if (event.httpMethod === "GET") {
      const res = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      const all = res.ok ? (await res.json()) : {};
      const gradeRes = await fetch(`${GRADE_OVERRIDE_URL}?auth=${idToken}`);
      const gradeOverrides = gradeRes.ok ? (await gradeRes.json()) : {};
      const effectiveByGrade = buildEffectivePermissions(gradeOverrides || {});
      return json(200, {
        individualPermissions: normalizeAllForDisplay(all || {}),
        effectiveByGrade,
        allPermissions: allowed,
        individualOnlyPermissions: session.level === "OWNER" ? INDIVIDUAL_ONLY_KEYS : allowed.filter(k=>INDIVIDUAL_ONLY_KEYS.includes(k)),
      }, corsHeaders);
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
    const { action, targetDiscordId, permissionName, value, cancelLayer } = body;

    if (!targetDiscordId) return json(400, { error: "Paramètres manquants." }, corsHeaders);
    if (targetDiscordId === OWNER_DISCORD_ID) return json(403, { error: "OWNER ne peut jamais être la cible d'une exception individuelle." }, corsHeaders);
    if (String(targetDiscordId) === String(session.discordId) && session.level !== "OWNER") {
      return json(403, { error: "Tu ne peux pas modifier tes propres permissions." }, corsHeaders);
    }

    const isBatch = action === "setAll" || action === "clearAll";
    const canonical = isBatch ? null : canonicalPermissionName(permissionName);
    if (!isBatch && !INDIVIDUAL_PERMISSION_KEYS.includes(canonical)) {
      return json(400, { error: `Permission individuelle inconnue ou interdite : "${permissionName}".` }, corsHeaders);
    }
    if (!isBatch && !allowed.includes(canonical)) {
      return json(403, { error: `Tu ne peux pas gérer « ${canonical} » : cette permission dépasse tes propres droits.` }, corsHeaders);
    }
    if (!isBatch && canonical === "owner_delegate" && session.level !== "OWNER") {
      return json(403, { error: "Seul l'OWNER peut accorder ou retirer les droits OWNER délégués." }, corsHeaders);
    }

    const effectiveLayer = effectiveLayerFor(session);
    const authorRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(effectiveLayer);
    const cancellableLayers = DECISION_LEVELS.filter(l => INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(l) >= authorRank);
    const authedUrl = `${INDIVIDUAL_URL}?auth=${idToken}`;
    const res = await fetch(authedUrl);
    const current = (res.ok ? (await res.json()) : null) || {};
    current[targetDiscordId] = current[targetDiscordId] || {};
    const beforePerson = JSON.parse(JSON.stringify(current[targetDiscordId]));
    const ensure = (perm) => {
      current[targetDiscordId][perm] = current[targetDiscordId][perm] || { CD: null, D: null, DG: null };
      return current[targetDiscordId][perm];
    };

    let logActionName, details;
    if (action === "set") {
      if (typeof value !== "boolean") return json(400, { error: "Valeur invalide (true/false attendu)." }, corsHeaders);
      ensure(canonical)[effectiveLayer] = value;
      logActionName = "exception_individuelle_definie";
      details = `Permission "${canonical}" -> ${value ? "Autorisé" : "Refusé"} (couche ${effectiveLayer})`;
    } else if (action === "cancel") {
      if (!cancelLayer || !DECISION_LEVELS.includes(cancelLayer)) return json(400, { error: "Couche à annuler invalide." }, corsHeaders);
      if (!cancellableLayers.includes(cancelLayer)) return json(403, { error: `Un ${session.level} ne peut pas annuler une décision de rang supérieur (${cancelLayer}).` }, corsHeaders);
      ensure(canonical)[cancelLayer] = null;
      logActionName = "exception_individuelle_annulee";
      details = `Permission "${canonical}" (couche ${cancelLayer} effacée)`;
    } else if (action === "setAll") {
      // Bulk = permissions ordinaires autorisées seulement. Les deux droits
      // individuels spéciaux restent volontairement explicites.
      const bulk = allowed.filter(p => !INDIVIDUAL_ONLY_KEYS.includes(p));
      bulk.forEach(perm => { ensure(perm)[effectiveLayer] = true; });
      logActionName = "exceptions_individuelles_tout_selectionner";
      details = `${bulk.length} permissions ordinaires autorisées (couche ${effectiveLayer})`;
    } else if (action === "clearAll") {
      let n = 0;
      Object.keys(current[targetDiscordId]).forEach(perm => {
        const canonicalPerm = canonicalPermissionName(perm);
        if(!allowed.includes(canonicalPerm)) return;
        const layers = current[targetDiscordId][perm] || {};
        cancellableLayers.forEach(l => { if (layers[l] === true || layers[l] === false) { layers[l] = null; n++; } });
      });
      logActionName = "exceptions_individuelles_tout_retirer";
      details = `${n} décision(s) retirée(s) (couches ${cancellableLayers.join(", ")})`;
    } else {
      return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
    }

    const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current) });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>"");
      return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders);
    }

    await logAction({
      action: logActionName,
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      targetDiscordId, details,
      oldValue: JSON.stringify(isBatch ? beforePerson : (beforePerson[canonical] || null)),
      newValue: JSON.stringify(isBatch ? current[targetDiscordId] : current[targetDiscordId][canonical]),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, current: isBatch ? null : current[targetDiscordId][canonical], person: normalizePersonForDisplay(current[targetDiscordId]) }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
