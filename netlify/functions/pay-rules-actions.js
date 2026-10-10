// ═══════════════════════════════════════════════════════════════════
// pay-rules-actions.js — panneau de réglages des paies (03/10), première
// tranche de l'audit des règles : rémunération uniquement (tarif réa,
// salaires fixes de référence par grade, bonus de classement, règles
// PPA). Réservé à can(level, "manage_pay_rules") — D, DG, OWNER
// uniquement, jamais CD (voir permissions.js).
//
// Les valeurs par défaut reproduisent EXACTEMENT les constantes codées
// en dur actuelles de Pillbox (section 1 de l'audit) — activer cette
// fonctionnalité sans rien modifier ne doit changer AUCUNE paie.
//
// GET (public, sans jeton) : Pillbox et tout le monde doivent pouvoir
// lire la config pour calculer — comme rosterGradeLabels, la lecture
// des règles de paie n'est pas sensible en elle-même, seule leur
// MODIFICATION l'est.
// POST : modifie une partie de la config, réservé manage_pay_rules,
// tracé dans les logs (ancienne valeur, nouvelle valeur), et conserve
// un historique complet des versions (jamais un simple écrasement).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can } = require("./permissions");
const { logAction } = require("./logs");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const CONFIG_URL = `${BASE}/payRulesConfig.json`;
const HISTORY_URL = `${BASE}/payRulesConfigHistory.json`;
const INDIVIDUAL_URL = `${BASE}/rosterIndividualPermissions.json`;

// Valeurs par défaut — copie exacte des constantes actuellement codées
// en dur dans Pillbox (REA_RATE, FIXED_PAY, BONUS_BY_RANK, les règles
// PPA). Si jamais payRulesConfig n'existe pas encore dans Firebase (pas
// encore initialisé), GET renvoie ces valeurs telles quelles — Pillbox
// se comporte alors exactement comme avant, sans aucune différence.
const DEFAULT_CONFIG = {
  reaRate: 14000,
  fixedSalaryByGrade: {
    STG: 5000000, A: 6000000, INF: 7000000, M: 8000000,
    MF: 9000000, MP: 9000000, MLP: 9000000,
    RF: 10000000, RP: 10000000, RL: 10000000,
    MC: 11500000, ADD: 11500000, CD: 13500000, D: 15000000, DG: 15000000,
  },
  bonusByRank: { "1": 3000000, "2": 2000000, "3": 1000000 },
  ppaEligibleGrades: ["MP","MLP","RP","RF","RL","MC","ADD","CD","D","DG"],
  ppaWeeklyCap: 10000000,
  // (03/10) Quotas — deuxième tranche de l'audit. Copie exacte de la
  // logique codée en dur de Pillbox : quota = staff ? 30 : 70, grades
  // exemptés, et la zone "presque atteint" (65 à quota-1, STG/A/INF/M
  // uniquement, jamais les grades staff).
  quotaStandard: 70,
  quotaStaff: 30,
  exemptGrades: ["MC","ADD","CD","D","DG"],
  nearMissGrades: ["STG","A","INF","M"],
  nearMissThreshold: 65,
  // (03/10) Q et licenciements — troisième tranche. Copie exacte des
  // seuils codés en dur : Stagiaire proposé à Q2, automatique à Q3 ;
  // Ambulancier proposé à Q3 ; cumul Q+A > 3 déclenche un licenciement
  // pour les autres grades. Quelqu'un déjà au seuil "automatique" qui
  // rate à nouveau reste TOUJOURS automatique (règle structurelle, pas
  // un simple nombre réglable séparément).
  stgProposalThreshold: 2,
  stgAutoThreshold: 3,
  aProposalThreshold: 3,
  qaCumulThreshold: 3,
  updatedAt: null,
  updatedBy: null,
};

const VALID_GRADES = ["STG","A","INF","M","MF","MP","MLP","RF","RP","RL","MC","ADD","CD","D","DG"];

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

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  if (event.httpMethod === "GET") {
    // Lecture publique volontaire (comme rosterGradeLabels) : Pillbox
    // (via le relais pillbox-proxy) et le Roster doivent tous deux
    // pouvoir lire cette config sans jeton pour calculer les paies.
    try {
      const res = await fetch(CONFIG_URL);
      const stored = res.ok ? await res.json() : null;
      const config = stored ? { ...DEFAULT_CONFIG, ...stored } : DEFAULT_CONFIG;
      return { statusCode: 200, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify({ config }) };
    } catch (err) {
      // Échec réseau : ne bloque jamais Pillbox, renvoie les valeurs
      // par défaut (identiques au comportement codé en dur actuel).
      return { statusCode: 200, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify({ config: DEFAULT_CONFIG, warning: `Lecture cloud impossible (${err.message}), valeurs par défaut utilisées.` }) };
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, field, value } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "manage_pay_rules", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à D, DG et Concepteur.` });
    }

    // Validation par champ — jamais un objet libre accepté tel quel,
    // chaque champ a sa propre règle de forme, pour ne jamais pouvoir
    // écrire une config qui ferait planter Pillbox au calcul suivant.
    if (!field) return json(400, { error: "Champ à modifier manquant." });

    const curRes = await fetch(CONFIG_URL);
    const stored = curRes.ok ? await curRes.json() : null;
    const current = stored ? { ...DEFAULT_CONFIG, ...stored } : { ...DEFAULT_CONFIG };
    const before = current[field];

    if (field === "reaRate" || field === "ppaWeeklyCap") {
      if (typeof value !== "number" || !(value >= 0) || value > 100000000) return json(400, { error: "Montant invalide." });
      current[field] = value;
    } else if (field === "bonusByRank") {
      if (typeof value !== "object" || value === null) return json(400, { error: "Format invalide pour les bonus." });
      const cleaned = {};
      for (const rank of ["1","2","3"]) {
        const v = value[rank];
        if (typeof v !== "number" || !(v >= 0) || v > 100000000) return json(400, { error: `Bonus du rang ${rank} invalide.` });
        cleaned[rank] = v;
      }
      current.bonusByRank = cleaned;
    } else if (field === "fixedSalaryByGrade") {
      if (typeof value !== "object" || value === null) return json(400, { error: "Format invalide pour les salaires fixes." });
      const cleaned = {};
      for (const g of VALID_GRADES) {
        const v = value[g];
        if (typeof v !== "number" || !(v >= 0) || v > 100000000) return json(400, { error: `Salaire fixe invalide pour ${g}.` });
        cleaned[g] = v;
      }
      current.fixedSalaryByGrade = cleaned;
    } else if (field === "ppaEligibleGrades") {
      if (!Array.isArray(value) || !value.every(g => VALID_GRADES.includes(g))) return json(400, { error: "Liste de grades PPA invalide." });
      current.ppaEligibleGrades = [...new Set(value)];
    } else if (field === "stgProposalThreshold" || field === "stgAutoThreshold" || field === "aProposalThreshold" || field === "qaCumulThreshold") {
      if (typeof value !== "number" || !(value >= 1) || value > 20) return json(400, { error: "Seuil invalide." });
      current[field] = value;
    } else if (field === "quotaStandard" || field === "quotaStaff" || field === "nearMissThreshold") {
      if (typeof value !== "number" || !(value >= 0) || value > 1000) return json(400, { error: "Valeur de quota invalide." });
      current[field] = value;
    } else if (field === "exemptGrades" || field === "nearMissGrades") {
      if (!Array.isArray(value) || !value.every(g => VALID_GRADES.includes(g))) return json(400, { error: "Liste de grades invalide." });
      current[field] = [...new Set(value)];
    } else {
      return json(400, { error: `Champ inconnu : "${field}".` });
    }

    current.updatedAt = Date.now();
    current.updatedBy = session.name;

    const saveRes = await fetch(`${CONFIG_URL}?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    // Historique complet — jamais un simple écrasement, chaque
    // modification garde une trace consultable (point 17.4 de l'audit).
    const histKey = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    await fetch(`${HISTORY_URL.replace(".json", `/${histKey}.json`)}?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field, oldValue: before === undefined ? null : before, newValue: current[field],
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        createdAt: Date.now(),
      }),
    }).catch(()=>{});

    await logAction({
      action: "regle_paie_modifiee",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Champ "${field}"`,
      oldValue: JSON.stringify(before), newValue: JSON.stringify(current[field]),
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, config: current });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) };
}
