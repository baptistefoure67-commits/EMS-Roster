// ═══════════════════════════════════════════════════════════════════
// permissions.js — LA source unique de vérité pour toutes les
// permissions du système. Aucune fonction serveur ne doit jamais
// vérifier un grade "à la main" (if(grade==="ADD")...) — tout doit
// passer par can(level, "nom_permission", ...) défini ici.
//
// Hiérarchie exacte (jamais à inverser) : MC < ADD < CD < D < DG < OWNER.
// OWNER n'est PAS un grade EMS — c'est un statut à part, basé
// uniquement sur un Discord ID précis, jamais sur ce que contient le
// Roster (voir resolveUserLevel ci-dessous, appelée uniquement côté
// serveur, jamais avec une valeur venue du navigateur).
//
// DG (09/09) : possède TOUTES les permissions fonctionnelles de OWNER,
// mais SANS sa protection spéciale — un DG reste soumis aux exceptions
// individuelles (peut se voir retirer une permission au cas par cas),
// contrairement à OWNER qui reste toujours intouchable.
// ═══════════════════════════════════════════════════════════════════

// Discord ID du concepteur — statut OWNER indépendant du Roster.
// Volontairement gardé UNIQUEMENT ici (jamais envoyé au frontend en
// clair, jamais comparé côté navigateur).
const OWNER_DISCORD_ID = "861557966083850250";

const LEVELS = ["MC", "ADD", "CD", "D", "DG", "OWNER"];

// Ordre d'autorité pour les exceptions individuelles (09/09) — une
// décision prise par un niveau plus haut dans cette liste l'emporte
// TOUJOURS sur celle d'un niveau plus bas, peu importe laquelle a été
// prise en dernier. OWNER n'apparaît pas ici : il ne peut jamais être
// la CIBLE d'une exception individuelle (protection spéciale, voir
// can() plus bas) — mais il PEUT bien sûr être l'auteur d'une décision,
// géré séparément dans manage-individual-permissions.js.
const INDIVIDUAL_DECISION_AUTHORITY_ORDER = ["DG", "D", "CD"];

// Table des permissions par niveau — modifier UNIQUEMENT ici (ou via la
// page "Gestion des permissions" plus tard, qui écrira dans Firebase et
// sera relue ici) pour changer le comportement de tout le système d'un
// coup, sans toucher au reste du code.
const DEFAULT_PERMISSIONS = {
  MC: {
    // (12/10) Mode troll : une permission comme les autres, mais décochée
    // pour TOUS les grades par défaut (DG compris, voir plus bas). Le
    // Concepteur l'a toujours. Cochée par grade ou individuellement = accès.
    manage_troll: false,
    view_roster: true,
    manage_roster: false,
    manage_ppa: true,
    manage_psy: true,
    manage_formations: true,
    manage_recruitments: true,
    propose_signalement: true,
    create_signalement: false,
    validate_signalement: false,
    manage_retrogradation: false,
    send_pillbox_formation: true,
    send_pillbox_psychologie: true,
    send_pillbox_all: false,
    // (10/10 — audit permissions) MC obtient maintenant les logs et
    // l'accès au Terminal Paie (Pillbox), demandé explicitement.
    view_logs: true,
    view_member_history: false,
    modify_role_label: false,
    manage_advanced_settings: false,
    manage_permissions: false,
    use_pillbox_terminal: true,
    manage_individual_permissions: false,
    // (10/10 — audit permissions) MC peut désormais DEMANDER une
    // exception individuelle (jamais l'appliquer directement).
    request_individual_permission: true,
    review_permission_requests: false,
  },
  ADD: {
    manage_troll: false, // accès Mode troll refusé par défaut ; exception explicite requise.
    view_roster: true,
    manage_roster: true,
    manage_ppa: true,
    manage_psy: true,
    manage_formations: true,
    manage_recruitments: true,
    propose_signalement: true,
    create_signalement: true,
    validate_signalement: true,
    manage_retrogradation: true,
    send_pillbox_formation: true,
    send_pillbox_psychologie: true,
    send_pillbox_all: true,
    view_logs: true,
    view_member_history: true,
    modify_role_label: false,
    manage_advanced_settings: false,
    manage_permissions: false,
    use_pillbox_terminal: true,
    manage_individual_permissions: false,
    request_individual_permission: true, // peut DEMANDER, jamais appliquer directement
    review_permission_requests: false,
    delete_week: true, // peut supprimer une semaine de l'historique (09/09)
    reset_activite_streak: true, // peut réinitialiser manuellement un suivi d'inactivité (10/09)
    manage_absences: true, // peut synchroniser les absences détectées et basculer Prise en compte OUI/NON (03/10)
  },
  CD: {
    manage_troll: false, // accès Mode troll refusé par défaut ; exception explicite requise.
    // hérite de tout ADD, plus les droits de gestion avancée
    modify_role_label: true,
    manage_permissions: false,
    // (10/10 — audit permissions) manage_advanced_settings,
    // manage_individual_permissions et review_permission_requests
    // resserrés à D+ (voir bloc D) — CD ne les a plus par défaut.
    reopen_week: true, // peut réouvrir une semaine de paie clôturée (Pillbox, 09/09)
    reopen_roster_week: true, // peut réouvrir une semaine Formation/Psychologue clôturée côté Roster (09/09)
    // (10/10 — audit permissions) Déconnexion forcée élargie à CD
    // (c'était D+ seulement jusqu'ici).
    force_logout: true,
  },
  D: {
    manage_troll: false, // accès Mode troll refusé par défaut ; exception explicite requise.
    // hérite de tout CD, plus la gestion des permissions elle-même
    manage_permissions: true,
    // (10/10 — audit permissions) Resserrés depuis CD vers D — gestion
    // avancée, exceptions individuelles (gérer + valider une demande).
    manage_advanced_settings: true,
    manage_individual_permissions: true,
    review_permission_requests: true,
    // (10/10 — audit permissions) D peut désormais annuler une
    // décision de rang inférieur (avant : DG uniquement). Note : cette
    // permission n'est actuellement vérifiée nulle part dans le code —
    // le vrai contrôle d'annulation passe par manage_individual_permissions
    // + la comparaison de rang (INDIVIDUAL_DECISION_AUTHORITY_ORDER)
    // dans manage-individual-permissions.js, qui autorise déjà D à
    // annuler une décision CD du simple fait d'avoir
    // manage_individual_permissions. Gardée ici pour cohérence
    // documentaire, à vérifier si un jour un usage réel en dépend.
    // (03/10) Panneau de réglages des paies — réservé D, DG, OWNER
    // uniquement (point 14 de l'audit des règles) : tarif réa, salaires
    // fixes de référence, bonus de classement, règles PPA. Jamais
    // accordé à CD par héritage, contrairement au reste de ce niveau.
    manage_pay_rules: true,
    // (10/10, demandé) Déconnexion forcée — CD, D, DG, OWNER côté
    // Roster. Pillbox restreint lui-même ce bouton au seul Concepteur
    // (OWNER) dans son interface, voir force-logout.js.
    force_logout: true,
  },
  DG: {
    manage_troll: false, // (12/10) sinon le DG l'aurait d'office (il reçoit « tout à vrai » ci-dessous)
    // Toutes les permissions FONCTIONNELLES de OWNER (calculé plus bas,
    // comme OWNER) — mais reste dans le tableau normal, donc reste
    // soumis aux exceptions individuelles, contrairement à OWNER.
  },
  OWNER: {
    // tout, sans exception — jamais limité par ce tableau, jamais
    // soumis aux exceptions individuelles (protection spéciale).
  },
};

// Construit la table EFFECTIVE (par GRADE, pas encore les exceptions
// individuelles — celles-ci s'appliquent APRÈS, voir can()) en
// appliquant l'héritage vers le haut de la hiérarchie.
function buildEffectivePermissions(overrides){
  const table = {};
  let inherited = {};
  for(const level of LEVELS){
    if(level === "OWNER" || level === "DG"){
      // OWNER et DG : toutes les clés fonctionnelles connues, à true,
      // PUIS on applique les entrées spécifiques du niveau (ex:
      const allKeys = new Set();
      Object.values(table).forEach(perms => Object.keys(perms).forEach(k=>allKeys.add(k)));
      const base = {};
      allKeys.forEach(k => base[k] = true);
      // (12/10) Défauts du niveau TOUJOURS appliqués, puis les modifications
      // enregistrées par-dessus (avant : une seule case modifiée faisait
      // oublier tous les défauts de ce niveau à l'écran).
      table[level] = { ...base, ...(DEFAULT_PERMISSIONS[level] || {}), ...(overrides?.[level] || {}) };
      continue;
    }
    inherited = { ...inherited, ...(DEFAULT_PERMISSIONS[level] || {}), ...(overrides?.[level] || {}) };
    table[level] = { ...inherited };
  }
  return table;
}

// Résout la décision individuelle EFFECTIVE pour (discordId,
// permissionName), en respectant la priorité d'autorité (DG > D > CD).
// Renvoie true/false si une exception existe, ou null si "hérite du
// grade" (aucune exception, ou toutes à null). individualOverrides a
// la forme : { [discordId]: { [permissionName]: { DG, D, CD } } }.
function resolveIndividualDecision(discordId, permissionName, individualOverrides){
  const entry = individualOverrides?.[discordId]?.[permissionName];
  if(!entry) return null;
  for(const authority of INDIVIDUAL_DECISION_AUTHORITY_ORDER){
    if(entry[authority] === true || entry[authority] === false) return entry[authority];
  }
  return null;
}

// customPermissions : permissions modifiées PAR GRADE (page "Gestion
// des permissions", inchangé). individualOverrides : exceptions PAR
// PERSONNE (09/09, nouveau) — jamais appliquées à OWNER (protection
// spéciale, section 14 du cahier des charges), même si quelqu'un
// réussissait à en écrire une pour son propre ID par erreur : ce
// court-circuit reste la garantie ultime.
function can(level, permissionName, customPermissions, discordId, individualOverrides){
  if(level === "OWNER") return true; // toujours, sans exception, quoi qu'il arrive — jamais consulté plus loin
  if(discordId && individualOverrides){
    const decision = resolveIndividualDecision(discordId, permissionName, individualOverrides);
    if(decision !== null) return decision; // une exception existe et tranche, quel que soit le grade
  }
  const table = buildEffectivePermissions(customPermissions);
  return !!(table[level] && table[level][permissionName]);
}

// Détermine le niveau réel d'un utilisateur — Discord ID d'ABORD (jamais
// contourné par un grade), Roster ENSUITE. Ne fait confiance à AUCUNE
// valeur envoyée par le navigateur : discordId doit venir de la
// vérification Discord elle-même (le token OAuth déjà validé), grade
// doit venir d'une lecture fraîche du Roster.
function resolveUserLevel(discordId, rosterGrade){
  if(discordId === OWNER_DISCORD_ID) return "OWNER";
  const g = (rosterGrade || "").trim().toUpperCase();
  if(["MC","ADD","CD","D","DG"].includes(g)) return g;
  return null; // aucun niveau reconnu → aucun accès
}


// ─── (nouveau) Contexte de permissions lu depuis Firebase ────────────────
// Renvoie { custom, individual } pour can(). custom = permissions modifiées
// PAR GRADE depuis la page "Gestion des permissions" (rosterPermissionsOverride),
// fusionnées au-dessus des défauts pour qu'une clé absente d'une ancienne
// sauvegarde (ex: force_logout, manage_pay_rules) retombe sur sa valeur par
// défaut au lieu d'être perdue. individual = exceptions par personne.
const PERM_FIREBASE_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
async function loadPermissionContext(idToken){
  let custom = null, individual = null;
  try{
    const r = await fetch(`${PERM_FIREBASE_BASE}/rosterPermissionsOverride.json?auth=${idToken}`);
    if(r.ok){
      const d = await r.json();
      if(d && typeof d === "object"){
        custom = {};
        for(const lv of LEVELS){
          if(d[lv] && typeof d[lv] === "object") custom[lv] = { ...(DEFAULT_PERMISSIONS[lv] || {}), ...d[lv] };
        }
      }
    }
  }catch(e){ /* injoignable : on retombe sur les défauts */ }
  try{
    const r = await fetch(`${PERM_FIREBASE_BASE}/rosterIndividualPermissions.json?auth=${idToken}`);
    individual = r.ok ? await r.json() : null;
  }catch(e){}
  return { custom, individual };
}

// Libellé humain affiché à l'utilisateur pour son propre niveau.
const LEVEL_LABEL = {
  MC: "MC — Accès limité",
  ADD: "ADD — Administrateur",
  CD: "CD — Cadre Directeur / Administrateur",
  D: "D — Directeur / Administrateur",
  DG: "DG — Directeur Général",
  OWNER: "OWNER — Concepteur",
};


// ─── (12/10) Vérification COMPLÈTE d'une permission ──────────────────────
// Cause réelle de « je coche une permission individuelle et ça ne marche
// pas » : 13 vérifications serveur appelaient can(session.level, …) SANS
// le contexte (matrice modifiée par grade + exceptions individuelles) —
// seul le grade comptait. canFor() charge ce contexte elle-même (avec son
// propre jeton Firebase) : remplacer can(session.level, "x") par
// await canFor(session, "x") suffit. En cas d'impossibilité de charger le
// contexte, retombe sur le grade seul — jamais plus permissif.
async function serviceIdTokenFor(session){
  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if(!FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) return null;
  const { createFirebaseCustomToken } = require("./firebase-token");
  const customToken = createFirebaseCustomToken({ clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: String(session.discordId), claims: { level: session.level } });
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
  try{
    const tok = idToken || await serviceIdTokenFor(session);
    if(tok){
      const ctx = await loadPermissionContext(tok);
      return can(session.level, permissionName, ctx.custom, session.discordId, ctx.individual);
    }
  }catch(e){ /* repli ci-dessous */ }
  return can(session.level, permissionName);
}
// Carte complète des permissions effectives d'une session — utilisée par
// le Roster pour afficher/masquer chaque bouton selon les VRAIS droits.
async function effectivePermissionsFor(session, idToken){
  const all = [...new Set(LEVELS.flatMap(l => Object.keys(buildEffectivePermissions()[l] || {})))];
  let ctx = { custom: null, individual: null };
  try{ const tok = idToken || await serviceIdTokenFor(session); if(tok) ctx = await loadPermissionContext(tok); }catch(e){}
  const out = {};
  all.forEach(p => { out[p] = can(session.level, p, ctx.custom, session.discordId, ctx.individual); });
  return out;
}

// (12/10) Mode troll — l'ACCÈS passe par la permission « manage_troll »
// (décochée partout par défaut, cochable par grade ou individuellement).
// isTrollAdmin = le Concepteur lui-même : lui seul voit et gère TOUTES les
// blagues ; les autres ne voient que les leurs et ne peuvent pas le viser.
const TROLL_ADMIN_IDS = [OWNER_DISCORD_ID];
function isTrollAdmin(session){ return !!session && TROLL_ADMIN_IDS.includes(String(session.discordId)); }

module.exports = {
  OWNER_DISCORD_ID, LEVELS, DEFAULT_PERMISSIONS, INDIVIDUAL_DECISION_AUTHORITY_ORDER,
  buildEffectivePermissions, resolveIndividualDecision, can, resolveUserLevel, LEVEL_LABEL, loadPermissionContext,
  canFor, effectivePermissionsFor, isTrollAdmin, TROLL_ADMIN_IDS,
};
