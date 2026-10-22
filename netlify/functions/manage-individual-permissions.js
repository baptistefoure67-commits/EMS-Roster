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
const DECISION_LEVELS = ["CD", "D", "DG", "OWNER"];

// Les seuls personnages qui disposent actuellement des DEUX visuels
// (dessin IA + photo RP détourée). Le choix de style est un réglage
// individuel OWNER-only, stocké à côté des permissions sans devenir
// lui-même une permission booléenne.
const ANIMATION_CHARACTER_IDS = new Set([
  "408669016039882752", // Tio
  "701698983466106903", // Moussa
  "873209274023690303", // Aaron
  "861557966083850250", // Baptiste
  "881570935679909918", // Cloé
  "227444055594893312", // Aiden
  "451073171194511370", // Eliot
  "51487127135243469",  // Papy (clé historique)
  "1339800960637075547",// Leyah
]);
const ANIMATION_CHARACTER_ALIASES = { "514871271352434699": "51487127135243469" };
function canonicalAnimationCharacterId(id){
  const raw=String(id||"");
  return ANIMATION_CHARACTER_ALIASES[raw] || raw;
}

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, permissionsWrite: true, server: true } });
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
  return DECISION_LEVELS.includes(session.level) ? session.level : "CD";
}

async function grantableKeys(session, idToken, canManagePermissions){
  if(session.level === "OWNER") return [...INDIVIDUAL_PERMISSION_KEYS];
  const list = [];
  if(canManagePermissions){
    const ctx = await loadPermissionContext(idToken);
    for(const p of GRADE_PERMISSION_KEYS){
      if(can(session.level, p, ctx.custom, session.discordId, ctx.individual)) list.push(p);
    }
    // Mode troll est accordable uniquement si le gestionnaire le possède déjà.
    if(can(session.level, "manage_troll", ctx.custom, session.discordId, ctx.individual)) list.push("manage_troll");
  }
  // L'exclusion des animations est un réglage individuel de Direction : D/DG/OWNER.
  // Elle reste dans ce panneau, mais ne donne aucune autre permission à la personne ciblée.
  if(["D","DG"].includes(session.level)) list.push("exclude_animations");
  // owner_delegate n'est jamais accordable par un non-OWNER.
  return [...new Set(list)];
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
  const canManagePermissions = await canFor(session, "manage_permissions");
  const canManageAnimationExclusion = ["D","DG","OWNER"].includes(session.level);
  if (!canManagePermissions && !canManageAnimationExclusion) {
    return json(403, { error: `Permission refusée (${session.level}) — accès insuffisant aux permissions individuelles.` }, corsHeaders);
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const allowed = await grantableKeys(session, idToken, canManagePermissions);

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
    const { action, targetDiscordId, permissionName, value, cancelLayer, animationStyle } = body;

    if (!targetDiscordId) return json(400, { error: "Paramètres manquants." }, corsHeaders);

    // Réglage visuel spécial : OWNER uniquement. Contrairement aux exceptions
    // de permission, OWNER peut aussi cibler sa propre fiche ici puisque ce
    // choix ne donne ni ne retire aucun droit.
    if (action === "setAnimationStyle") {
      if (session.level !== "OWNER") return json(403, { error: "Seul l'OWNER peut choisir le style des animations d'une personne." }, corsHeaders);
      const canonicalTarget = canonicalAnimationCharacterId(targetDiscordId);
      if (!ANIMATION_CHARACTER_IDS.has(canonicalTarget)) return json(400, { error: "Cette personne n'a pas les deux portraits nécessaires aux animations." }, corsHeaders);
      if (animationStyle !== "illustration" && animationStyle !== "real") return json(400, { error: "Style invalide : 'illustration' ou 'real' attendu." }, corsHeaders);

      const authedUrl = `${INDIVIDUAL_URL}?auth=${idToken}`;
      const res = await fetch(authedUrl);
      const current = (res.ok ? (await res.json()) : null) || {};
      // On conserve l'ID réellement utilisé par le Roster pour éviter de
      // fabriquer une seconde fiche Papy si l'alias long est reçu.
      const storageId = Object.prototype.hasOwnProperty.call(current, targetDiscordId) ? String(targetDiscordId) : canonicalTarget;
      current[storageId] = current[storageId] || {};
      const previous = current[storageId].animation_portrait_style || null;
      current[storageId].animation_portrait_style = animationStyle;

      const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current) });
      if (!saveRes.ok) {
        const t = await saveRes.text().catch(()=>"");
        return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders);
      }
      await logAction({
        action: "style_animation_individuel_modifie",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: storageId,
        details: `Style animation -> ${animationStyle === "real" ? "Personnage RP" : "Dessin IA"}`,
        oldValue: JSON.stringify(previous), newValue: JSON.stringify(animationStyle), idToken,
      }).catch(()=>{});
      return json(200, { ok:true, animationStyle, person: normalizePersonForDisplay(current[storageId]) }, corsHeaders);
    }

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
    if (isBatch && !canManagePermissions) {
      return json(403, { error: "Le réglage d'exclusion des animations se modifie individuellement, pas avec les actions Tout sélectionner/Tout retirer." }, corsHeaders);
    }
    if (!isBatch && canonical !== "exclude_animations" && !canManagePermissions) {
      return json(403, { error: "Tu peux uniquement gérer l'exclusion des animations sans la permission « Gérer les permissions »." }, corsHeaders);
    }
    if (!isBatch && canonical === "exclude_animations" && !canManageAnimationExclusion) {
      return json(403, { error: "Seuls D, DG et OWNER peuvent exclure quelqu'un des animations." }, corsHeaders);
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
      current[targetDiscordId][perm] = current[targetDiscordId][perm] || { CD: null, D: null, DG: null, OWNER: null };
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
