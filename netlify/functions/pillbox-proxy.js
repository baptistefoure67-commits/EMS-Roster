// ═══════════════════════════════════════════════════════════════════
// pillbox-proxy.js — SEUL moyen pour Pillbox de lire rosterEmsData et
// discordIdsList maintenant que leur lecture directe sur Firebase est
// fermée au public (09/09, fermeture de la lecture publique — les IDs
// Discord ne doivent plus être récupérables juste en connaissant
// l'adresse Firebase).
//
// Pillbox n'a pas de connexion Discord (décision volontaire, 09/09 plus
// tôt) — il s'authentifie donc ici avec un simple secret partagé
// (PILLBOX_SERVICE_SECRET, variable d'environnement), pas un vrai
// compte. C'est plus léger qu'une vraie connexion, mais ferme quand
// même la porte à "n'importe qui qui connaît juste l'adresse du site" —
// le but exact demandé. Ce n'est PAS une protection parfaite contre
// quelqu'un qui inspecterait spécifiquement le code de Pillbox pour y
// trouver ce secret, mais ça ferme le scénario visé (accès direct via
// l'URL Firebase brute, ou l'URL du Roster).
// ═══════════════════════════════════════════════════════════════════

const { createFirebaseCustomToken } = require("./firebase-token");
const { computeAbsenceSignalements } = require("./absences-actions");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const DISCORD_IDS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/discordIdsList.json";
const ACTIVITE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/activiteSuivi.json";
const ABSENCES_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAbsences.json";
const PAY_RULES_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/payRulesConfig.json";

// Valeurs par défaut — copie EXACTE de celles de pay-rules-actions.js
// (jamais réimportées directement, ce fichier et celui-là sont deux
// fonctions Netlify séparées qui ne partagent pas leur code). Si jamais
// l'une des deux copies est modifiée, l'autre doit l'être aussi — à
// vérifier en premier si Pillbox calcule un jour différemment du
// panneau de réglages affiché dans le Roster.
const DEFAULT_PAY_RULES = {
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
  quotaStandard: 70,
  quotaStaff: 30,
  exemptGrades: ["MC","ADD","CD","D","DG"],
  nearMissGrades: ["STG","A","INF","M"],
  nearMissThreshold: 65,
  stgProposalThreshold: 2,
  stgAutoThreshold: 3,
  aProposalThreshold: 3,
  qaCumulThreshold: 3,
};

exports.handler = async function (event) {
  // CORS : Pillbox est sur un autre domaine Netlify — sans ces en-têtes,
  // le navigateur bloquerait la réponse avant même que le code de
  // Pillbox ne la voie. Ouvert à tous les domaines volontairement (ce
  // n'est qu'un relais protégé par secret, pas une action sensible en
  // elle-même) — le secret est la vraie protection, pas l'origine.
  // POST ajouté le 03/10 : signaler "semaine terminée" au Roster (voir
  // plus bas) exige d'écrire sur activiteSuivi, qui demande une
  // authentification Firebase — Pillbox n'en a pas en direct, donc ça
  // doit obligatoirement passer par ce relais, comme le reste.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { PILLBOX_SERVICE_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!PILLBOX_SERVICE_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  const provided = (event.headers && (event.headers["x-pillbox-secret"] || event.headers["X-Pillbox-Secret"])) || "";
  if (provided !== PILLBOX_SERVICE_SECRET) {
    return json(403, { error: "Secret invalide." }, corsHeaders);
  }

  try {
    const customToken = createFirebaseCustomToken({
      clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: "service:pillbox", claims: {},
    });
    const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const exchData = await exch.json();
    if (!exch.ok) throw new Error(exchData.error?.message || `${exch.status}`);
    const idToken = exchData.idToken;

    // (03/10) Signal "semaine terminée" : Pillbox appelle ce relais en
    // POST juste après avoir validé sa semaine, pour que le Roster se
    // clôture tout seul à sa prochaine ouverture (il écoute déjà ce
    // champ, voir checkPillboxWeekFinishedSignal côté Roster) — sans ce
    // passage par le relais, l'écriture directe depuis Pillbox était
    // silencieusement refusée par les règles Firebase (authentification
    // requise sur activiteSuivi), d'où le signal qui n'arrivait jamais.
    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch (e) {}
      if (body.action === "weekFinished") {
        const patchRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weekFinishedAt: Date.now() }),
        });
        if (!patchRes.ok) {
          const t = await patchRes.text().catch(() => "");
          return json(502, { error: `Échec de l'envoi du signal (${patchRes.status}) : ${t.slice(0, 200)}` }, corsHeaders);
        }
        return json(200, { ok: true }, corsHeaders);
      }
      return json(400, { error: "Action POST inconnue." }, corsHeaders);
    }

    const [rosterRes, discordIdsRes, absencesRes, payRulesRes] = await Promise.all([
      fetch(`${ROSTER_URL}?auth=${idToken}`),
      fetch(`${DISCORD_IDS_URL}?auth=${idToken}`),
      fetch(`${ABSENCES_URL}?auth=${idToken}`),
      fetch(PAY_RULES_URL), // lecture publique, comme rosterGradeLabels — pas besoin du jeton
    ]);
    const roster = rosterRes.ok ? await rosterRes.json() : null;
    const discordIds = discordIdsRes.ok ? await discordIdsRes.json() : null;
    const absences = absencesRes.ok ? await absencesRes.json() : null;
    const storedPayRules = payRulesRes.ok ? await payRulesRes.json() : null;
    // Fusionne sur les valeurs par défaut — si rien n'a encore été
    // configuré (payRulesConfig vide ou absente), Pillbox reçoit les
    // valeurs par défaut, identiques à ses anciennes constantes codées
    // en dur. Une config partielle (un seul champ modifié un jour)
    // garde aussi tous les autres champs à leur valeur par défaut.
    const payRules = storedPayRules ? { ...DEFAULT_PAY_RULES, ...storedPayRules } : DEFAULT_PAY_RULES;

    // (02/10) Avant, les pings Discord de Pillbox dépendaient UNIQUEMENT de
    // discordIdsList — une liste à part, à maintenir à la main, qui finit
    // par être vide ou obsolète si personne n'y pense. Le Roster a pourtant
    // déjà l'ID Discord de chaque employé actif : on le génère maintenant
    // directement depuis là (même format "Nom: ID" que Pillbox attend déjà,
    // aucun changement nécessaire côté Pillbox). L'ancienne liste manuelle
    // reste lue en complément, pour quelqu'un qui n'est plus dans le
    // Roster mais encore utile à ping (ex: ancien staff).
    const rosterLines = [];
    const rosterNames = new Set();
    (roster && Array.isArray(roster.employees) ? roster.employees : []).forEach(e => {
      if (!e || e.licencie) return;
      const name = (e.name || "").trim();
      const discordId = String(e.discordId || "").trim();
      if (!name || !/^\d{5,}$/.test(discordId)) return;
      rosterLines.push(`${name}: ${discordId}`);
      rosterNames.add(name.toLowerCase());
    });
    const manualText = (discordIds && discordIds.text) ? discordIds.text : "";
    const manualExtraLines = manualText.split("\n").filter(line => {
      const m = line.trim().match(/^\*?\s*(.+?)\s*:\s*(\d{5,})\s*$/);
      return m && !rosterNames.has(m[1].trim().toLowerCase());
    });
    const mergedText = [...rosterLines, ...manualExtraLines].join("\n");

    // (03/10) Signalements d'absences répétées (section 15 du cahier des
    // charges) : calculés ici avec la même règle exacte que le Roster
    // (fonction partagée computeAbsenceSignalements, voir
    // absences-actions.js) — jamais recalculée en double avec une
    // logique qui pourrait dériver de l'originale.
    const absenceSignalements = computeAbsenceSignalements(absences || {});

    return json(200, {
      roster, discordIds: { text: mergedText, source: "roster+manuel", rosterCount: rosterLines.length },
      absenceSignalements, payRules,
    }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
