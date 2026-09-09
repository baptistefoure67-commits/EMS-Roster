// ═══════════════════════════════════════════════════════════════════
// permissions.js — LA source unique de vérité pour toutes les
// permissions du système. Aucune fonction serveur ne doit jamais
// vérifier un grade "à la main" (if(grade==="ADD")...) — tout doit
// passer par can(level, "nom_permission") défini ici.
//
// Hiérarchie exacte (jamais à inverser) : MC < ADD < CD < D < OWNER.
// OWNER n'est PAS un grade EMS — c'est un statut à part, basé
// uniquement sur un Discord ID précis, jamais sur ce que contient le
// Roster (voir resolveUserLevel ci-dessous, appelée uniquement côté
// serveur, jamais avec une valeur venue du navigateur).
// ═══════════════════════════════════════════════════════════════════

// Discord ID du concepteur — statut OWNER indépendant du Roster.
// Volontairement gardé UNIQUEMENT ici (jamais envoyé au frontend en
// clair, jamais comparé côté navigateur).
const OWNER_DISCORD_ID = "861557966083850250";

const LEVELS = ["MC", "ADD", "CD", "D", "OWNER"];

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
  },
  CD: {
    // hérite de tout ADD, plus les droits de gestion avancée
    modify_role_label: true,
    manage_advanced_settings: true,
    manage_permissions: false,
  },
  D: {
    // hérite de tout CD, plus la gestion des permissions elle-même
    manage_permissions: true,
  },
  OWNER: {
    // tout, sans exception — jamais limité par ce tableau
  },
};

// Construit la table EFFECTIVE en appliquant l'héritage vers le haut de
// la hiérarchie (CD hérite d'ADD, D hérite de CD, OWNER a tout) — évite
// de recopier 15 lignes identiques à chaque niveau supérieur.
function buildEffectivePermissions(overrides){
  const table = {};
  let inherited = {};
  for(const level of LEVELS){
    if(level === "OWNER"){
      // OWNER : toutes les clés connues, toutes à true, sans exception.
      const allKeys = new Set();
      Object.values(table).forEach(perms => Object.keys(perms).forEach(k=>allKeys.add(k)));
      table.OWNER = {};
      allKeys.forEach(k => table.OWNER[k] = true);
      continue;
    }
    inherited = { ...inherited, ...(overrides?.[level] || DEFAULT_PERMISSIONS[level] || {}) };
    table[level] = { ...inherited };
  }
  return table;
}

// customPermissions : permissions modifiées depuis la page "Gestion des
// permissions" (stockées dans Firebase) — si absentes, on retombe sur
// DEFAULT_PERMISSIONS ci-dessus. Passé en paramètre plutôt que lu ici
// directement, pour que ce module reste indépendant de Firebase.
function can(level, permissionName, customPermissions){
  if(level === "OWNER") return true; // toujours, sans exception, quoi qu'il arrive
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
  if(["MC","ADD","CD","D"].includes(g)) return g;
  return null; // aucun niveau reconnu → aucun accès
}

// Libellé humain affiché à l'utilisateur pour son propre niveau.
const LEVEL_LABEL = {
  MC: "MC — Accès limité",
  ADD: "ADD — Administrateur",
  CD: "CD — Cadre Directeur / Administrateur",
  D: "D — Directeur / Administrateur",
  OWNER: "OWNER — Concepteur",
};

module.exports = { OWNER_DISCORD_ID, LEVELS, DEFAULT_PERMISSIONS, buildEffectivePermissions, can, resolveUserLevel, LEVEL_LABEL };
