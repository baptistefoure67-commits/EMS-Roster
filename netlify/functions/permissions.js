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
    view_logs: false,
    view_member_history: false,
    modify_role_label: false,
    manage_advanced_settings: false,
    manage_permissions: false,
    use_pillbox_terminal: false,
    manage_individual_permissions: false,
    request_individual_permission: false,
    review_permission_requests: false,
    cancel_lower_decisions: false,
  },
  ADD: {
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
    cancel_lower_decisions: false,
    delete_week: true, // peut supprimer une semaine de l'historique (09/09)
  },
  CD: {
    // hérite de tout ADD, plus les droits de gestion avancée
    modify_role_label: true,
    manage_advanced_settings: true,
    manage_permissions: false,
    manage_individual_permissions: true, // peut modifier directement (09/09)
    review_permission_requests: true,    // peut valider une demande d'ADD
    cancel_lower_decisions: false,       // rien en dessous de CD à annuler
    reopen_week: true, // peut réouvrir une semaine de paie clôturée (Pillbox, 09/09)
    reopen_roster_week: true, // peut réouvrir une semaine Formation/Psychologue clôturée côté Roster (09/09)
  },
  D: {
    // hérite de tout CD, plus la gestion des permissions elle-même
    manage_permissions: true,
  },
  DG: {
    // Toutes les permissions FONCTIONNELLES de OWNER (calculé plus bas,
    // comme OWNER) — mais reste dans le tableau normal, donc reste
    // soumis aux exceptions individuelles, contrairement à OWNER.
    cancel_lower_decisions: true, // peut annuler une décision CD (09/09)
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
      // cancel_lower_decisions pour DG) par-dessus.
      const allKeys = new Set();
      Object.values(table).forEach(perms => Object.keys(perms).forEach(k=>allKeys.add(k)));
      const base = {};
      allKeys.forEach(k => base[k] = true);
      table[level] = { ...base, ...(overrides?.[level] || DEFAULT_PERMISSIONS[level] || {}) };
      continue;
    }
    inherited = { ...inherited, ...(overrides?.[level] || DEFAULT_PERMISSIONS[level] || {}) };
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
  const g = (rosterGrade || "").toUpperCase();
  if(["MC","ADD","CD","D","DG"].includes(g)) return g;
  return null; // aucun niveau reconnu → aucun accès
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

module.exports = {
  OWNER_DISCORD_ID, LEVELS, DEFAULT_PERMISSIONS, INDIVIDUAL_DECISION_AUTHORITY_ORDER,
  buildEffectivePermissions, resolveIndividualDecision, can, resolveUserLevel, LEVEL_LABEL,
};
