// ═══════════════════════════════════════════════════════════════════
// permissions.js — source unique de vérité des permissions Roster EMS.
// Refonte 21/10/2026 : permissions regroupées + compatibilité avec les
// anciennes clés Firebase.
//
// Hiérarchie : MC < ADD < CD < D < DG < OWNER.
// OWNER n'est pas un grade EMS : il est résolu par Discord ID côté serveur.
// ═══════════════════════════════════════════════════════════════════

const OWNER_DISCORD_ID = "861557966083850250";
const LEVELS = ["MC", "ADD", "CD", "D", "DG", "OWNER"];
const INDIVIDUAL_DECISION_AUTHORITY_ORDER = ["OWNER", "DG", "D", "CD"];

// Permissions affichées dans la matrice par grade.
const GRADE_PERMISSION_KEYS = [
  "view_roster",
  "manage_roster",
  "manage_psychologue_category",
  "manage_formateur_category",
  "propose_signalement",
  "create_signalement",
  "validate_signalement",
  "manage_retrogradation",
  "sync_pillbox_complete",
  "view_logs",
  "modify_role_label",
  "manage_advanced_settings",
  "manage_permissions",
  "use_pillbox_terminal",
  "request_individual_permission",
  "cancel_lower_decisions",
  "manage_pay_weeks",
  "manage_absences",
  "manage_pay_rules",
  "force_logout",
  "reset_activite_streak",
  "reopen_roster_week",
  "manage_roster_backup",
];

// Permissions qui ne doivent JAMAIS apparaître dans la matrice par grade.
// Elles sont accordables individuellement seulement.
// (24/10, bloc 2 — cahier des charges) delete_logs est maintenant délégable
// individuellement — avant, totalement bloqué (voir OWNER_ONLY_KEYS /
// resolveIndividualDecision plus bas, désormais retirés pour cette clé).
// Réservé dans les faits à OWNER et DG : voir le contrôle de grade explicite
// dans get-logs.js, en plus de la vraie permission individuelle ici.
const INDIVIDUAL_ONLY_KEYS = ["owner_delegate", "manage_troll", "exclude_animations", "delete_logs", "use_gain_de_temps"];

// Suppression de logs : OWNER réel uniquement. Cette permission n'est ni
// proposée par grade ni accordable individuellement.
const OWNER_ONLY_KEYS = [];

const INDIVIDUAL_PERMISSION_KEYS = [...GRADE_PERMISSION_KEYS, ...INDIVIDUAL_ONLY_KEYS];
const RUNTIME_PERMISSION_KEYS = [...GRADE_PERMISSION_KEYS, ...INDIVIDUAL_ONLY_KEYS, ...OWNER_ONLY_KEYS];

// Anciennes clés encore comprises par le moteur pour éviter de casser les
// appels existants et les anciennes valeurs stockées dans Firebase.
const LEGACY_PERMISSION_ALIASES = {
  manage_ppa: "manage_psychologue_category",
  manage_psy: "manage_psychologue_category",
  manage_formations: "manage_formateur_category",
  manage_recruitments: "manage_formateur_category",
  send_pillbox_formation: "sync_pillbox_complete",
  send_pillbox_psychologie: "sync_pillbox_complete",
  send_pillbox_all: "sync_pillbox_complete",
  view_member_history: "view_logs",
  manage_individual_permissions: "manage_permissions",
  review_permission_requests: "manage_permissions",
  reopen_week: "manage_pay_weeks",
  delete_week: "manage_pay_weeks",
};

// Pour migrer une ancienne config ambiguë, la clé ci-dessous est la plus
// représentative / la plus sensible du groupe et sert de valeur de repli.
const LEGACY_PRIMARY_BY_CANONICAL = {
  manage_psychologue_category: ["manage_psy", "manage_ppa"],
  manage_formateur_category: ["manage_formations", "manage_recruitments"],
  sync_pillbox_complete: ["send_pillbox_all", "send_pillbox_formation", "send_pillbox_psychologie"],
  view_logs: ["view_logs", "view_member_history"],
  manage_permissions: ["manage_permissions", "manage_individual_permissions", "review_permission_requests"],
  manage_pay_weeks: ["delete_week", "reopen_week"],
};

function canonicalPermissionName(name){
  return LEGACY_PERMISSION_ALIASES[name] || name;
}

// Matrice par défaut basée sur la matrice fournie par l'utilisateur.
// Les niveaux héritent des niveaux inférieurs ; seuls les écarts sont listés.
const DEFAULT_PERMISSIONS = {
  MC: {
    view_roster: true,
    manage_roster: false,
    manage_psychologue_category: true,
    manage_formateur_category: true,
    propose_signalement: true,
    create_signalement: false,
    validate_signalement: false,
    manage_retrogradation: true,
    sync_pillbox_complete: true,
    view_logs: true,
    modify_role_label: false,
    manage_advanced_settings: false,
    manage_permissions: false,
    use_pillbox_terminal: true,
    request_individual_permission: true,
    cancel_lower_decisions: false,
    manage_pay_weeks: false,
    manage_absences: false,
    manage_pay_rules: false,
    force_logout: false,
    reset_activite_streak: false,
    reopen_roster_week: false,
  },
  ADD: {
    manage_roster: true,
    create_signalement: true,
    validate_signalement: true,
    manage_pay_weeks: true,
    manage_absences: true,
    force_logout: true,
    reset_activite_streak: true,
    reopen_roster_week: true,
  },
  CD: {
    // Identique à ADD, avec en plus la sauvegarde/restauration catastrophe.
    manage_roster_backup: true,
  },
  D: {
    modify_role_label: true,
    manage_advanced_settings: true,
    cancel_lower_decisions: true,
    manage_pay_rules: true,
    // manage_permissions reste faux par défaut : il peut être délégué
    // individuellement par OWNER si souhaité.
  },
  DG: {
    // Rempli automatiquement à true pour toutes les permissions de grade,
    // puis les overrides Firebase sont appliqués.
  },
  OWNER: {},
};

function readLegacyOverrideForCanonical(levelOverride, canonical){
  if(!levelOverride || typeof levelOverride !== "object") return undefined;
  if(Object.prototype.hasOwnProperty.call(levelOverride, canonical)) return !!levelOverride[canonical];
  const legacy = LEGACY_PRIMARY_BY_CANONICAL[canonical] || [];
  for(const key of legacy){
    if(Object.prototype.hasOwnProperty.call(levelOverride, key)) return !!levelOverride[key];
  }
  return undefined;
}

function normalizeGradeOverride(levelOverride){
  const out = {};
  if(!levelOverride || typeof levelOverride !== "object") return out;
  for(const key of GRADE_PERMISSION_KEYS){
    const v = readLegacyOverrideForCanonical(levelOverride, key);
    if(v !== undefined) out[key] = v;
  }
  return out;
}

function buildEffectivePermissions(overrides){
  const table = {};
  let inherited = {};
  for(const level of LEVELS){
    if(level === "OWNER"){
      const all = {};
      GRADE_PERMISSION_KEYS.forEach(k => all[k] = true);
      INDIVIDUAL_ONLY_KEYS.forEach(k => all[k] = true);
      OWNER_ONLY_KEYS.forEach(k => all[k] = true);
      table[level] = all;
      continue;
    }
    if(level === "DG"){
      const all = {};
      GRADE_PERMISSION_KEYS.forEach(k => all[k] = true);
      // Les droits individuels spéciaux ne sont jamais donnés par grade.
      INDIVIDUAL_ONLY_KEYS.forEach(k => all[k] = false);
      OWNER_ONLY_KEYS.forEach(k => all[k] = false);
      table[level] = { ...all, ...normalizeGradeOverride(overrides?.[level]) };
      inherited = { ...table[level] };
      continue;
    }
    inherited = {
      ...inherited,
      ...(DEFAULT_PERMISSIONS[level] || {}),
      ...normalizeGradeOverride(overrides?.[level]),
    };
    INDIVIDUAL_ONLY_KEYS.forEach(k => inherited[k] = false);
    OWNER_ONLY_KEYS.forEach(k => inherited[k] = false);
    table[level] = { ...inherited };
  }
  return table;
}

function readDecisionFromEntry(entry){
  if(!entry || typeof entry !== "object") return null;
  for(const authority of INDIVIDUAL_DECISION_AUTHORITY_ORDER){
    if(entry[authority] === true || entry[authority] === false) return entry[authority];
  }
  return null;
}

function resolveIndividualDecision(discordId, permissionName, individualOverrides){
  const canonical = canonicalPermissionName(permissionName);
  const person = individualOverrides?.[discordId];
  if(!person) return null;

  // Nouvelle clé d'abord.
  let decision = readDecisionFromEntry(person[canonical]);
  if(decision !== null) return decision;

  // Puis anciennes clés du groupe, pour compatibilité des données existantes.
  const legacy = LEGACY_PRIMARY_BY_CANONICAL[canonical] || [];
  for(const key of legacy){
    if(key === canonical) continue;
    decision = readDecisionFromEntry(person[key]);
    if(decision !== null) return decision;
  }
  return null;
}

function can(level, permissionName, customPermissions, discordId, individualOverrides){
  const canonical = canonicalPermissionName(permissionName);
  if(level === "OWNER") return true;
  if(OWNER_ONLY_KEYS.includes(canonical)) return false;

  if(discordId && individualOverrides){
    const decision = resolveIndividualDecision(discordId, canonical, individualOverrides);
    if(decision !== null) return decision;
    // (24/10, bloc 2) delete_logs reste volontairement HORS de ce que
    // "Droits OWNER délégués" accorde automatiquement — même quelqu'un
    // avec tous les droits OWNER délégués ne doit pas pouvoir effacer des
    // logs sans que ce droit précis lui ait été donné explicitement et à
    // part (intégrité de l'audit). Seule une vraie attribution directe de
    // delete_logs (gérée au-dessus) ou un vrai OWNER (bypass tout en haut)
    // y donnent accès.
    if(canonical !== "owner_delegate" && canonical !== "delete_logs"){
      const delegateDecision = resolveIndividualDecision(discordId, "owner_delegate", individualOverrides);
      if(delegateDecision === true) return true;
    }
  }

  // owner_delegate / manage_troll sont individuels uniquement.
  if(INDIVIDUAL_ONLY_KEYS.includes(canonical)) return false;
  const table = buildEffectivePermissions(customPermissions);
  return !!(table[level] && table[level][canonical]);
}

function resolveUserLevel(discordId, rosterGrade){
  if(discordId === OWNER_DISCORD_ID) return "OWNER";
  const g = (rosterGrade || "").trim().toUpperCase();
  if(["MC","ADD","CD","D","DG"].includes(g)) return g;
  return null;
}

const PERM_FIREBASE_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
async function loadPermissionContext(idToken, options={}){
  const strict = !!options.strict;
  // (23/10, 12.4) Les deux lectures sont lancées EN PARALLÈLE (avant : l'une après
  // l'autre, soit un aller-retour réseau de plus sur chaque appel). La sémantique
  // est strictement la même : en mode strict, l'échec de l'une OU de l'autre lève
  // une erreur (fail-closed, l'erreur de la branche « par grade » prime comme
  // avant) ; hors mode strict, une branche illisible reste à null.
  // AUCUN cache : un droit retiré doit être refusé dès l'appel suivant.
  const readCustom = async ()=>{
    let custom = null;
    try{
      const r = await fetch(`${PERM_FIREBASE_BASE}/rosterPermissionsOverride.json?auth=${idToken}`);
      if(!r.ok){ if(strict) throw new Error(`Lecture permissions par grade refusée (${r.status}).`); }
      else{
        const d = await r.json();
        if(d && typeof d === "object"){
          custom = {};
          for(const lv of LEVELS){
            if(d[lv] && typeof d[lv] === "object") custom[lv] = normalizeGradeOverride(d[lv]);
          }
        }
      }
    }catch(e){ if(strict) throw e; }
    return custom;
  };
  const readIndividual = async ()=>{
    let individual = null;
    try{
      const r = await fetch(`${PERM_FIREBASE_BASE}/rosterIndividualPermissions.json?auth=${idToken}`);
      if(!r.ok){ if(strict) throw new Error(`Lecture permissions individuelles refusée (${r.status}).`); }
      else individual = await r.json();
    }catch(e){ if(strict) throw e; }
    return individual;
  };
  const [customRes, individualRes] = await Promise.allSettled([readCustom(), readIndividual()]);
  if(customRes.status === "rejected") throw customRes.reason;
  if(individualRes.status === "rejected") throw individualRes.reason;
  return { custom: customRes.value, individual: individualRes.value };
}

const LEVEL_LABEL = {
  MC: "MC — Accès limité",
  ADD: "ADD — Administrateur",
  CD: "CD — Cadre Directeur / Administrateur",
  D: "D — Directeur / Administrateur",
  DG: "DG — Directeur Général",
  OWNER: "OWNER — Concepteur",
};

async function serviceIdTokenFor(session){
  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if(!FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) return null;
  const { createFirebaseCustomToken } = require("./firebase-token");
  const customToken = createFirebaseCustomToken({ clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: String(session.discordId), claims: { level: session.level, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json().catch(()=>({}));
  return res.ok ? data.idToken : null;
}

async function canFor(session, permissionName, idToken){
  if(!session) return false;
  if(session.level === "OWNER") return true;
  // Sécurité fail-closed : une exception individuelle retirant un droit ne
  // doit jamais être contournée simplement parce que Firebase est
  // momentanément indisponible. Si le contexte fin ne peut pas être relu,
  // l'action sensible est refusée et pourra être retentée ensuite.
  try{
    const tok = idToken || await serviceIdTokenFor(session);
    if(!tok) return false;
    const ctx = await loadPermissionContext(tok, {strict:true});
    return can(session.level, permissionName, ctx.custom, session.discordId, ctx.individual);
  }catch(e){
    return false;
  }
}

async function effectivePermissionsFor(session, idToken){
  let ctx = { custom: null, individual: null };
  try{ const tok = idToken || await serviceIdTokenFor(session); if(tok) ctx = await loadPermissionContext(tok); }catch(e){}
  const out = {};
  for(const p of RUNTIME_PERMISSION_KEYS){
    out[p] = can(session.level, p, ctx.custom, session.discordId, ctx.individual);
  }
  // Compatibilité frontend : anciennes clés renvoient la nouvelle décision.
  for(const [legacy, canonical] of Object.entries(LEGACY_PERMISSION_ALIASES)) out[legacy] = out[canonical];
  return out;
}

function permissionRank(level){ return LEVELS.indexOf(level); }
function mayEditTargetLevel(sessionLevel, targetLevel){
  if(sessionLevel === "OWNER") return targetLevel !== "OWNER";
  const a = permissionRank(sessionLevel), b = permissionRank(targetLevel);
  return a >= 0 && b >= 0 && b <= a && targetLevel !== "OWNER";
}

const TROLL_ADMIN_IDS = [OWNER_DISCORD_ID];
function isTrollAdmin(session){ return !!session && TROLL_ADMIN_IDS.includes(String(session.discordId)); }

// ═══════════════════════════════════════════════════════════════════
// PROTECTION DES PERMISSIONS INDIVIDUELLES (24/10, cahier des charges
// "évolution coordonnée") — concerne UNIQUEMENT les exceptions
// individuelles (person[canonical].protection), jamais les overrides
// de grade. Stockée à côté de {CD,D,DG,OWNER} sans les modifier : can()
// et resolveIndividualDecision() ignorent déjà toute clé qu'ils ne
// connaissent pas, donc une entrée protégée reste lue exactement
// pareil pour la résolution de la valeur effective.
//
// Forme stockée : person[canonical].protection = null (🔓 Libre) ou
// { type: "D"|"DG"|"OWNER"|"OWNER_PLUS", authorDiscordId, authorName,
//   authorLevel, createdAt }.
// ═══════════════════════════════════════════════════════════════════
const PROTECTION_TYPES = ["D", "DG", "OWNER", "OWNER_PLUS"]; // du plus faible au plus fort
const PROTECTION_LABEL = { D: "🔒 D", DG: "🔒 DG", OWNER: "🔒 OWNER", OWNER_PLUS: "🔐 OWNER++" };
// Ce qu'un niveau peut CRÉER (poser pour la première fois, ou utiliser en
// remplacement d'une protection existante). Jamais au-dessus de son propre
// niveau — un D ne crée jamais DG/OWNER/OWNER++, un DG jamais OWNER/OWNER++.
// (26/10, audit confirmé) OWNER ne crée QUE OWNER/OWNER++ — ne doit jamais
// créer artificiellement D ou DG à la place de quelqu'un d'autre (cahier des
// charges, section 3 : "Je ne veux pas qu'OWNER crée artificiellement des
// protections D/DG"). OWNER reste libre de RETIRER une protection D/DG
// existante (canActOnProtection le permet toujours pour OWNER), simplement
// pas de la remplacer par une autre D/DG à sa place.
const PROTECTION_CREATE_CEILING = { D: ["D"], DG: ["D", "DG"], OWNER: ["OWNER", "OWNER_PLUS"] };

function isValidProtectionType(type){ return type === null || PROTECTION_TYPES.includes(type); }

// Qui peut ne serait-ce que TOUCHER (retirer/remplacer) une protection déjà
// posée, indépendamment de ce qu'il voudrait mettre à la place :
// - OWNER++ : seul un vrai OWNER, jamais personne d'autre, aucune exception ;
// - Libre / D / DG / OWNER (normale) : n'importe quel membre de la Direction
//   (D, DG, OWNER) — l'auteur d'origine n'est jamais le seul à pouvoir agir.
//   L'appelant doit vérifier EN PLUS la vraie permission manage_permissions
//   (ceci ne fait que trancher le niveau, pas le droit réel).
function canActOnProtection(session, currentProtectionType){
  if(currentProtectionType === "OWNER_PLUS") return !!session && session.level === "OWNER";
  return !!session && ["D", "DG", "OWNER"].includes(session.level);
}

// Ce que CE niveau peut poser comme nouvelle protection (null = retirer,
// toujours permis dès lors que canActOnProtection() est vrai).
function canCreateProtectionType(session, type){
  if(type === null) return true;
  const ceiling = PROTECTION_CREATE_CEILING[session && session.level] || [];
  return ceiling.includes(type);
}

module.exports = {
  OWNER_DISCORD_ID, LEVELS, DEFAULT_PERMISSIONS, INDIVIDUAL_DECISION_AUTHORITY_ORDER,
  GRADE_PERMISSION_KEYS, INDIVIDUAL_ONLY_KEYS, OWNER_ONLY_KEYS, INDIVIDUAL_PERMISSION_KEYS, RUNTIME_PERMISSION_KEYS,
  LEGACY_PERMISSION_ALIASES, canonicalPermissionName, normalizeGradeOverride,
  buildEffectivePermissions, resolveIndividualDecision, can, resolveUserLevel, LEVEL_LABEL, loadPermissionContext,
  canFor, effectivePermissionsFor, permissionRank, mayEditTargetLevel, isTrollAdmin, TROLL_ADMIN_IDS,
  PROTECTION_TYPES, PROTECTION_LABEL, PROTECTION_CREATE_CEILING,
  isValidProtectionType, canActOnProtection, canCreateProtectionType,
};
