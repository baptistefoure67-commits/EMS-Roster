// Exceptions individuelles — intégrées à la permission unique
// « Gérer les permissions ». Un gestionnaire ne peut attribuer que les
// permissions dont il dispose lui-même. OWNER reste protégé et intouchable.

const { verify } = require("./session-token");
const {
  can, canFor, loadPermissionContext, LEVELS, OWNER_DISCORD_ID,
  INDIVIDUAL_DECISION_AUTHORITY_ORDER, buildEffectivePermissions,
  GRADE_PERMISSION_KEYS, INDIVIDUAL_ONLY_KEYS, INDIVIDUAL_PERMISSION_KEYS,
  LEGACY_PERMISSION_ALIASES, canonicalPermissionName,
  PROTECTION_TYPES, PROTECTION_LABEL, isValidProtectionType, canActOnProtection, canCreateProtectionType,
} = require("./permissions");
const { logAction } = require("./logs");
const { createFirebaseCustomToken } = require("./firebase-token");

const INDIVIDUAL_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterIndividualPermissions.json";
const GRADE_OVERRIDE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPermissionsOverride.json";
const DECISION_LEVELS = ["CD", "D", "DG", "OWNER"];
const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const GAIN_ACCESS_PERMISSION = "use_gain_de_temps";
const GAIN_ACCESS_GRADES = new Set(["MF","MP","MLP","RF","RP","RL","MC","ADD","CD","D","DG"]);

// Gain de Temps reste un site séparé, mais l'accès est décidé ici dans le
// Roster. Même un D/DG n'obtient aucun passe-droit : seule une validation
// individuelle OWNER peut activer cette permission. Le contrôle de grade est
// aussi refait côté serveur pour éviter qu'une requête bricolée autorise un
// STG/A/INF/M par simple manipulation du navigateur.
async function assertGainAccessTargetEligible(idToken, targetDiscordId){
  const res = await fetch(`${ROSTER_URL}?auth=${idToken}`);
  if(!res.ok) throw Object.assign(new Error(`Roster illisible (${res.status}).`), { statusCode:502 });
  const data = await res.json().catch(()=>null);
  const employees = data && Array.isArray(data.employees) ? data.employees : [];
  const emp = employees.find(e => !e.licencie && String(e.discordId||"") === String(targetDiscordId||""));
  if(!emp) throw Object.assign(new Error("Cette personne n'est pas un employé actif du Roster."), { statusCode:400 });
  const grade = String(emp.grade||"").toUpperCase();
  if(!GAIN_ACCESS_GRADES.has(grade)) {
    throw Object.assign(new Error(`Accès Gain de Temps impossible pour ${emp.name||"cet employé"} (${grade||"grade inconnu"}) : minimum Médecin Spécialisé.`), { statusCode:400 });
  }
  return emp;
}

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
    // (24/10, audit) Mode strict : cette liste sert aussi de vraie barrière
    // d'autorisation plus bas (set/setAll/clearAll la relisent) — avant,
    // une panne de lecture ici retombait silencieusement sur les droits
    // par défaut du grade, pouvant montrer/accorder plus que ce que la
    // personne peut réellement distribuer.
    const ctx = await loadPermissionContext(idToken, {strict:true});
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

      // (24/10, audit) Lecture + écriture CIBLÉES sur cette seule personne
      // — avant, toute la branche rosterIndividualPermissions était relue
      // puis réécrite en entier ; une panne de lecture suivie d'une
      // écriture réussie pouvait donc effacer les exceptions de tout le
      // monde pour ne garder que ce changement de style. On ne sait plus,
      // sans lire toute la branche, si le Roster utilise déjà l'ID reçu ou
      // son alias canonique pour cette personne — on lit les deux noeuds
      // ciblés (ça reste 2 lectures, jamais toute la branche) et on écrit
      // sur celui qui existe déjà, sinon sur l'alias canonique.
      const idUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(targetDiscordId)}.json?auth=${idToken}`;
      const canonicalUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(canonicalTarget)}.json?auth=${idToken}`;
      const [idRes, canonicalRes] = canonicalTarget === String(targetDiscordId)
        ? [await fetch(idUrl), null]
        : await Promise.all([fetch(idUrl), fetch(canonicalUrl)]);
      if (!idRes.ok || (canonicalRes && !canonicalRes.ok)) {
        const bad = !idRes.ok ? idRes : canonicalRes;
        return json(502, { error: `Permissions individuelles illisibles (${bad.status}) — changement refusé pour ne pas écraser les réglages existants.` }, corsHeaders);
      }
      const idNode = await idRes.json().catch(()=>null);
      const storageId = idNode ? String(targetDiscordId) : canonicalTarget;
      const storageUrl = storageId === String(targetDiscordId) ? idUrl : canonicalUrl;
      const existing = storageId === String(targetDiscordId) ? idNode : (canonicalRes ? await canonicalRes.json().catch(()=>null) : null);
      const node = existing || {};
      const previous = node.animation_portrait_style || null;
      node.animation_portrait_style = animationStyle;

      const saveRes = await fetch(storageUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(node) });
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
      return json(200, { ok:true, animationStyle, person: normalizePersonForDisplay(node) }, corsHeaders);
    }

    if (targetDiscordId === OWNER_DISCORD_ID) return json(403, { error: "OWNER ne peut jamais être la cible d'une exception individuelle." }, corsHeaders);
    if (String(targetDiscordId) === String(session.discordId) && session.level !== "OWNER") {
      return json(403, { error: "Tu ne peux pas modifier tes propres permissions." }, corsHeaders);
    }

    // ───────────────────────────────────────────────────────────────
    // setProtection — pose/retire/remplace la protection d'UNE permission,
    // sans jamais toucher sa valeur (true/false/null) actuelle. C'est
    // volontairement une action séparée de "set"/"cancel" : voir plus bas,
    // "set"/"cancel" refusent tant qu'une protection existe — il faut
    // d'abord l'enlever ICI, dans un appel séparé, avant de pouvoir
    // modifier la valeur dans un appel suivant.
    // ───────────────────────────────────────────────────────────────
    if (action === "setProtection") {
      const canonical = canonicalPermissionName(permissionName);
      if (!INDIVIDUAL_PERMISSION_KEYS.includes(canonical)) {
        return json(400, { error: `Permission individuelle inconnue ou interdite : "${permissionName}".` }, corsHeaders);
      }
      if (!allowed.includes(canonical)) {
        return json(403, { error: `Tu ne peux pas gérer « ${canonical} » : cette permission dépasse tes propres droits.` }, corsHeaders);
      }
      if (!canManagePermissions) {
        return json(403, { error: "La gestion des protections nécessite la permission « Gérer les permissions »." }, corsHeaders);
      }
      const newType = body.protectionType === undefined ? null : body.protectionType;
      if (!isValidProtectionType(newType)) {
        return json(400, { error: `Type de protection invalide : "${newType}".` }, corsHeaders);
      }

      const authedUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(targetDiscordId)}.json?auth=${idToken}`;
      const res = await fetch(authedUrl);
      if (!res.ok) return json(502, { error: `Permissions individuelles illisibles (${res.status}) — changement refusé pour ne pas écraser les réglages existants.` }, corsHeaders);
      const person = (await res.json().catch(()=>null)) || {};
      const entry = person[canonical] = person[canonical] || { CD: null, D: null, DG: null, OWNER: null };
      const oldProtection = entry.protection || null;
      const oldType = oldProtection ? oldProtection.type : null;

      if (!canActOnProtection(session, oldType)) {
        const refusedDetails = `Tentative sur « ${canonical} » protégée ${PROTECTION_LABEL[oldType] || oldType} — niveau insuffisant (${session.level}).`;
        await logAction({
          action: "exception_individuelle_refusee",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId, details: refusedDetails, idToken,
        }).catch(()=>{});
        return json(403, { error: oldType === "OWNER_PLUS"
          ? "🔐 Protection OWNER++ : seul un véritable OWNER peut la retirer ou la modifier."
          : `Protégé par ${PROTECTION_LABEL[oldType] || oldType} — ton niveau (${session.level}) ne permet pas d'intervenir dessus.` }, corsHeaders);
      }
      if (!canCreateProtectionType(session, newType)) {
        const refusedDetails = `Tentative de poser ${PROTECTION_LABEL[newType] || newType} sur « ${canonical} » — dépasse ce que ${session.level} peut créer.`;
        await logAction({
          action: "exception_individuelle_refusee",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId, details: refusedDetails, idToken,
        }).catch(()=>{});
        return json(403, { error: `Un ${session.level} ne peut jamais créer une protection ${PROTECTION_LABEL[newType] || newType} (uniquement au niveau de, ou en dessous de, son propre grade).` }, corsHeaders);
      }

      entry.protection = newType ? {
        type: newType, authorDiscordId: session.discordId, authorName: session.name,
        authorLevel: session.level, createdAt: Date.now(),
      } : null;

      const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(person) });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }

      await logAction({
        action: "protection_permission_modifiee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId,
        details: `« ${canonical} » : protection ${oldType ? PROTECTION_LABEL[oldType] : "🔓 Libre"} → ${newType ? PROTECTION_LABEL[newType] : "🔓 Libre"}`,
        oldValue: JSON.stringify(oldProtection), newValue: JSON.stringify(entry.protection), idToken,
      }).catch(()=>{});

      return json(200, { ok: true, protection: entry.protection, person: normalizePersonForDisplay(person) }, corsHeaders);
    }

    // ───────────────────────────────────────────────────────────────
    // setBatch — plusieurs permissions de LA MÊME personne changées dans
    // la même sauvegarde (depuis le site : plusieurs cases cochées puis
    // un seul clic sur Enregistrer). Une seule lecture, une seule
    // écriture, un seul log groupé — jamais un log par case cochée.
    // Chaque opération est validée indépendamment (mêmes règles que
    // "set"/"cancel" isolés, protection comprise) ; celles refusées sont
    // simplement écartées et renvoyées au site, elles ne bloquent pas
    // les autres.
    // ───────────────────────────────────────────────────────────────
    if (action === "setBatch") {
      const operations = Array.isArray(body.operations) ? body.operations.slice(0, 50) : [];
      if (!operations.length) return json(400, { error: "Aucune modification à appliquer." }, corsHeaders);
      if (!canManagePermissions) return json(403, { error: "La modification groupée nécessite la permission « Gérer les permissions »." }, corsHeaders);

      const authedUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(targetDiscordId)}.json?auth=${idToken}`;
      const res = await fetch(authedUrl);
      if (!res.ok) return json(502, { error: `Permissions individuelles illisibles (${res.status}) — changement refusé pour ne pas écraser les réglages existants.` }, corsHeaders);
      const person = (await res.json().catch(()=>null)) || {};
      const beforePerson = JSON.parse(JSON.stringify(person));
      const ensure = (perm) => { person[perm] = person[perm] || { CD: null, D: null, DG: null, OWNER: null }; return person[perm]; };
      const effectiveLayer = effectiveLayerFor(session);
      const authorRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(effectiveLayer);
      const cancellableLayers = DECISION_LEVELS.filter(l => INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(l) >= authorRank);

      // La permission Gain de Temps est volontairement OWNER-only, y compris
      // dans la sauvegarde groupée : un gestionnaire délégué ne peut jamais la
      // glisser dans une requête manuelle pour contourner l'interface.
      const gainOps = operations.filter(op => canonicalPermissionName(op && op.permissionName) === GAIN_ACCESS_PERMISSION);
      if(gainOps.length && session.level !== "OWNER") {
        return json(403, { error: "Seul l'OWNER peut accorder ou retirer l'accès Gain de Temps EMS." }, corsHeaders);
      }
      if(gainOps.some(op => op && op.action === "set" && op.value === true)) {
        try{ await assertGainAccessTargetEligible(idToken, targetDiscordId); }
        catch(err){ return json(err.statusCode||502, { error: err.message }, corsHeaders); }
      }

      const applied = []; const refused = []; const refusedProtectionAttempts = [];
      operations.forEach(op => {
        const canonical = canonicalPermissionName(op && op.permissionName);
        if (!INDIVIDUAL_PERMISSION_KEYS.includes(canonical)) { refused.push({ permissionName: op && op.permissionName, reason: "permission inconnue" }); return; }
        if (!allowed.includes(canonical)) { refused.push({ permissionName: canonical, reason: "dépasse tes droits" }); return; }
        if (canonical === "owner_delegate" && session.level !== "OWNER") { refused.push({ permissionName: canonical, reason: "réservé à OWNER" }); return; }
        if (canonical === "exclude_animations" && !canManageAnimationExclusion) { refused.push({ permissionName: canonical, reason: "réservé à D/DG/OWNER" }); return; }
        const entry = ensure(canonical);
        const currentProtection = entry.protection || null;
        if (currentProtection && op.action !== "protection") {
          refused.push({ permissionName: canonical, reason: `protégé ${PROTECTION_LABEL[currentProtection.type] || currentProtection.type} — retire d'abord la protection` });
          return;
        }
        if (op.action === "protection") {
          const newType = op.protectionType === undefined ? null : op.protectionType;
          if (!isValidProtectionType(newType)) { refused.push({ permissionName: canonical, reason: "type de protection invalide" }); return; }
          if (!canActOnProtection(session, currentProtection ? currentProtection.type : null)) {
            refused.push({ permissionName: canonical, reason: "protection hors de portée de ton niveau" });
            refusedProtectionAttempts.push({ canonical, oldType: currentProtection ? currentProtection.type : null, attemptedType: newType });
            return;
          }
          if (!canCreateProtectionType(session, newType)) {
            refused.push({ permissionName: canonical, reason: "protection au-dessus de ce que tu peux créer" });
            refusedProtectionAttempts.push({ canonical, oldType: currentProtection ? currentProtection.type : null, attemptedType: newType });
            return;
          }
          entry.protection = newType ? { type: newType, authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level, createdAt: Date.now() } : null;
          applied.push(`« ${canonical} » : protection ${currentProtection ? PROTECTION_LABEL[currentProtection.type] : "🔓 Libre"} → ${newType ? PROTECTION_LABEL[newType] : "🔓 Libre"}`);
        } else if (op.action === "set") {
          if (typeof op.value !== "boolean") { refused.push({ permissionName: canonical, reason: "valeur invalide" }); return; }
          entry[effectiveLayer] = op.value;
          applied.push(`« ${canonical} » -> ${op.value ? "Autorisé" : "Refusé"} (couche ${effectiveLayer})`);
        } else if (op.action === "cancel") {
          if (!op.cancelLayer || !cancellableLayers.includes(op.cancelLayer)) { refused.push({ permissionName: canonical, reason: "couche à annuler invalide ou hors de portée" }); return; }
          entry[op.cancelLayer] = null;
          applied.push(`« ${canonical} » (couche ${op.cancelLayer} effacée)`);
        } else {
          refused.push({ permissionName: canonical, reason: "action inconnue" });
        }
      });

      if (applied.length) {
        const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(person) });
        if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }

        // UNE seule entrée groupée pour toute la sauvegarde — jamais une par
        // permission modifiée. Le détail (liste des permissions touchées)
        // reste consultable dans le log lui-même (champ "details").
        await logAction({
          action: "exceptions_individuelles_modifiees_groupe",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId,
          details: `${applied.length} modification(s) :\n${applied.join("\n")}`,
          oldValue: JSON.stringify(beforePerson), newValue: JSON.stringify(person), idToken,
        }).catch(()=>{});
      }
      for (const attempt of refusedProtectionAttempts) {
        await logAction({
          action: "exception_individuelle_refusee",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId,
          details: `Tentative sur « ${attempt.canonical} » (protection ${attempt.oldType ? PROTECTION_LABEL[attempt.oldType] : "🔓 Libre"} → ${attempt.attemptedType ? PROTECTION_LABEL[attempt.attemptedType] : "🔓 Libre"}) — niveau insuffisant (${session.level}).`,
          idToken,
        }).catch(()=>{});
      }

      return json(200, { ok: true, applied: applied.length, refused, person: normalizePersonForDisplay(person) }, corsHeaders);
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
    if (!isBatch && canonical === GAIN_ACCESS_PERMISSION && session.level !== "OWNER") {
      return json(403, { error: "Seul l'OWNER peut accorder ou retirer l'accès Gain de Temps EMS." }, corsHeaders);
    }
    if (!isBatch && canonical === GAIN_ACCESS_PERMISSION && action === "set" && value === true) {
      try{ await assertGainAccessTargetEligible(idToken, targetDiscordId); }
      catch(err){ return json(err.statusCode||502, { error: err.message }, corsHeaders); }
    }

    const effectiveLayer = effectiveLayerFor(session);
    const authorRank = INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(effectiveLayer);
    const cancellableLayers = DECISION_LEVELS.filter(l => INDIVIDUAL_DECISION_AUTHORITY_ORDER.indexOf(l) >= authorRank);
    // (24/10, audit) Lecture + écriture CIBLÉES sur cette seule personne —
    // avant, toute la branche rosterIndividualPermissions était relue puis
    // réécrite en entier ; une panne de lecture suivie d'une écriture
    // réussie pouvait donc effacer les exceptions de tout le monde pour ne
    // garder que ce changement. Plus aucun autre dossier n'est jamais lu
    // ni réécrit par cette action.
    const authedUrl = `${INDIVIDUAL_URL.replace(/\.json$/, "")}/${encodeURIComponent(targetDiscordId)}.json?auth=${idToken}`;
    const res = await fetch(authedUrl);
    if (!res.ok) return json(502, { error: `Permissions individuelles illisibles (${res.status}) — changement refusé pour ne pas écraser les réglages existants.` }, corsHeaders);
    const person = (await res.json().catch(()=>null)) || {};
    const beforePerson = JSON.parse(JSON.stringify(person));
    const ensure = (perm) => {
      person[perm] = person[perm] || { CD: null, D: null, DG: null, OWNER: null };
      return person[perm];
    };

    let logActionName, details;
    if (action === "set") {
      if (typeof value !== "boolean") return json(400, { error: "Valeur invalide (true/false attendu)." }, corsHeaders);
      // (cahier des charges, bloc 1, point 5) Une permission protégée ne se
      // modifie JAMAIS directement : il faut d'abord retirer la protection
      // (action setProtection, dans un appel séparé), puis seulement ensuite
      // modifier la valeur ici. Jamais les deux dans le même appel.
      if (person[canonical] && person[canonical].protection) {
        const p = person[canonical].protection;
        return json(423, { error: `Protégé par ${PROTECTION_LABEL[p.type] || p.type} (posé par ${p.authorName || "?"}) — retire d'abord la protection avant de modifier cette permission.`, protection: p }, corsHeaders);
      }
      ensure(canonical)[effectiveLayer] = value;
      logActionName = "exception_individuelle_definie";
      details = `Permission "${canonical}" -> ${value ? "Autorisé" : "Refusé"} (couche ${effectiveLayer})`;
    } else if (action === "cancel") {
      if (!cancelLayer || !DECISION_LEVELS.includes(cancelLayer)) return json(400, { error: "Couche à annuler invalide." }, corsHeaders);
      if (!cancellableLayers.includes(cancelLayer)) return json(403, { error: `Un ${session.level} ne peut pas annuler une décision de rang supérieur (${cancelLayer}).` }, corsHeaders);
      if (person[canonical] && person[canonical].protection) {
        const p = person[canonical].protection;
        return json(423, { error: `Protégé par ${PROTECTION_LABEL[p.type] || p.type} (posé par ${p.authorName || "?"}) — retire d'abord la protection avant de modifier cette permission.`, protection: p }, corsHeaders);
      }
      ensure(canonical)[cancelLayer] = null;
      logActionName = "exception_individuelle_annulee";
      details = `Permission "${canonical}" (couche ${cancelLayer} effacée)`;
    } else if (action === "setAll") {
      // Bulk = permissions ordinaires autorisées seulement, et jamais celles
      // actuellement protégées (une protection n'est jamais contournée
      // silencieusement par une action groupée).
      const bulk = allowed.filter(p => !INDIVIDUAL_ONLY_KEYS.includes(p) && !(person[p] && person[p].protection));
      const skippedProtected = allowed.filter(p => !INDIVIDUAL_ONLY_KEYS.includes(p) && person[p] && person[p].protection).length;
      bulk.forEach(perm => { ensure(perm)[effectiveLayer] = true; });
      logActionName = "exceptions_individuelles_tout_selectionner";
      details = `${bulk.length} permissions ordinaires autorisées (couche ${effectiveLayer})${skippedProtected?` — ${skippedProtected} protégée(s) ignorée(s)`:""}`;
    } else if (action === "clearAll") {
      let n = 0; let skippedProtected = 0;
      Object.keys(person).forEach(perm => {
        const canonicalPerm = canonicalPermissionName(perm);
        if(!allowed.includes(canonicalPerm)) return;
        if(person[perm] && person[perm].protection){ skippedProtected++; return; }
        const layers = person[perm] || {};
        cancellableLayers.forEach(l => { if (layers[l] === true || layers[l] === false) { layers[l] = null; n++; } });
      });
      logActionName = "exceptions_individuelles_tout_retirer";
      details = `${n} décision(s) retirée(s) (couches ${cancellableLayers.join(", ")})${skippedProtected?` — ${skippedProtected} protégée(s) ignorée(s)`:""}`;
    } else {
      return json(400, { error: `Action inconnue : "${action}".` }, corsHeaders);
    }

    const saveRes = await fetch(authedUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(person) });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>"");
      return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders);
    }

    await logAction({
      action: logActionName,
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      targetDiscordId, details,
      oldValue: JSON.stringify(isBatch ? beforePerson : (beforePerson[canonical] || null)),
      newValue: JSON.stringify(isBatch ? person : person[canonical]),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, current: isBatch ? null : person[canonical], person: normalizePersonForDisplay(person) }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
