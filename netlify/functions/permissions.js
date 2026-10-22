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
const INDIVIDUAL_ONLY_KEYS = ["owner_delegate", "manage_troll", "exclude_animations"];

// Suppression de logs : OWNER réel uniquement. Cette permission n'est ni
// proposée par grade ni accordable individuellement.
const OWNER_ONLY_KEYS = ["delete_logs"];

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
  if(canonical === "delete_logs") return null; // jamais délégable
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
    if(canonical !== "owner_delegate"){
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
  let custom = null, individual = null;
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
  try{
    const r = await fetch(`${PERM_FIREBASE_BASE}/rosterIndividualPermissions.json?auth=${idToken}`);
    if(!r.ok){ if(strict) throw new Error(`Lecture permissions individuelles refusée (${r.status}).`); }
    else individual = await r.json();
  }catch(e){ if(strict) throw e; }
  return { custom, individual };
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
    const ctx = await loadPermissionContext(tok);
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

module.exports = {
  OWNER_DISCORD_ID, LEVELS, DEFAULT_PERMISSIONS, INDIVIDUAL_DECISION_AUTHORITY_ORDER,
  GRADE_PERMISSION_KEYS, INDIVIDUAL_ONLY_KEYS, OWNER_ONLY_KEYS, INDIVIDUAL_PERMISSION_KEYS, RUNTIME_PERMISSION_KEYS,
  LEGACY_PERMISSION_ALIASES, canonicalPermissionName, normalizeGradeOverride,
  buildEffectivePermissions, resolveIndividualDecision, can, resolveUserLevel, LEVEL_LABEL, loadPermissionContext,
  canFor, effectivePermissionsFor, permissionRank, mayEditTargetLevel, isTrollAdmin, TROLL_ADMIN_IDS,
};
