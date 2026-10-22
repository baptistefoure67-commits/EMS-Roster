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
const { computeAbsenceSignalements, computeStgAbsenceSignalements, computeLongAbsenceSignalements, attachAlertDecisions, pruneExpiredAbsences } = require("./absences-actions");
const { verifyDetailed } = require("./session-token");
const { can, loadPermissionContext, resolveIndividualDecision } = require("./permissions");
const { closeActiviteWeekServer } = require("./activite-close");
const { logAction } = require("./logs");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const DISCORD_IDS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/discordIdsList.json";
const ROSTER_SYNC_META_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterPillboxSyncMeta.json";
const ACTIVITE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/activiteSuivi.json";
const ABSENCES_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAbsences.json";
const ABSENCE_ALERT_DECISIONS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAbsenceAlertDecisions.json";
// (19/10, demandé) Réglage "animations" partagé Roster + Pillbox — lu
// ici pour que Pillbox sache si la personne (ou l'OWNER pour elle) l'a
// désactivé, sans avoir besoin de son propre accès Firebase direct.
const ANIM_PREFS_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterAnimPrefs";
// (13/10, section 6) NOUVEAU CHEMIN FIREBASE — nécessite ses propres
// règles de validation (voir le rapport final) avant de fonctionner
// réellement en production.
const LIVE_UP_DECISIONS_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxLiveUpDecisions";
// (14/10) Annonce, par la session qui traite réellement la paie, la
// liste des UP en attente et qui est en train de travailler — pour que
// "Modification OWNER" la découvre SANS que l'OWNER n'ait à connaître
// la semaine ni l'employé à l'avance.
const LIVE_UP_SESSIONS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxLiveUpSessions.json";
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
  infProposalEnabled: false,
  infProposalThreshold: 3,
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
    "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Secret, X-Pillbox-Session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { SESSION_SECRET, PILLBOX_SERVICE_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !PILLBOX_SERVICE_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  const provided = (event.headers && (event.headers["x-pillbox-secret"] || event.headers["X-Pillbox-Secret"])) || "";
  if (provided !== PILLBOX_SERVICE_SECRET) {
    return json(403, { error: "Secret invalide." }, corsHeaders);
  }
  // (11/10 — audit de sécurité) Le secret ci-dessus est visible dans le
  // code source de Pillbox (il doit l'être, Pillbox n'a pas de backend à
  // lui) — il ne protège donc que contre "quelqu'un qui tombe sur
  // l'adresse par hasard", pas contre quelqu'un qui inspecte le code de
  // Pillbox. En plus de ce secret, on exige maintenant aussi une vraie
  // session Discord valide (Pillbox en a une depuis le 09/09) : sans
  // elle, même en connaissant le secret, impossible de lire quoi que ce
  // soit — il faut s'être réellement connecté avec Discord au moins une
  // fois. Dégradation prévue et normale AVANT la connexion (les quatre
  // appels côté Pillbox tombent déjà silencieusement sur leurs valeurs
  // par défaut dans ce cas, comportement inchangé).
  const sessionToken = (event.headers && (event.headers["x-pillbox-session"] || event.headers["X-Pillbox-Session"])) || "";
  const verification = verifyDetailed(sessionToken, SESSION_SECRET);
  const session = verification.payload;
  if (!session) {
    // Diagnostic sûr : ne journalise jamais le jeton ni le secret.
    console.warn(`[pillbox-proxy] session refusée: ${verification.reason}; tokenLength=${sessionToken.length}`);
    return json(401, {
      error: "Session Discord invalide ou expirée — reconnecte-toi.",
      code: verification.reason
    }, corsHeaders);
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
        // (11/10) La clôture Formateur/Psy est maintenant faite ICI, par
        // le serveur, au moment même du clic dans Pillbox — plus un
        // simple horodatage qu'un Roster ouvert devait remarquer (et qui
        // se faisait effacer par la moindre sauvegarde d'activité).
        // Idempotent par semaine : double clic / relance = sans danger.
        const r = await closeActiviteWeekServer({
          idToken, session,
          weekKey: body.weekKey, weekEndMs: body.weekEndMs,
          absentIds: Array.isArray(body.absentIds) ? body.absentIds : [],
          absentNames: Array.isArray(body.absentNames) ? body.absentNames : [],
          logAction,
        });
        return json(r.status, r.body, corsHeaders);
      }
      if (body.action === "pushLiveUpSession") {
        // (14/10, généralisé le 15/10) N'importe quelle session connectée
        // peut annoncer ce qu'elle est en train de traiter — ce n'est
        // qu'une information d'affichage (aucune donnée sensible, aucune
        // écriture réelle sur une paie), donc aucune permission spéciale
        // requise au-delà d'être connecté. Écrase systématiquement
        // l'entrée précédente de CETTE semaine (idempotent, dernière
        // analyse qui gagne). Couvre TOUTES les catégories de l'étape 7
        // (pas seulement les promotions) — IMPORTANT : ces noms de champs
        // (category/sentence/details) doivent rester synchronisés avec
        // ceux envoyés par Pillbox (buildAllPendingEntries) ET avec les
        // règles Firebase de pillboxLiveUpSessions.entries.$index — un
        // nom de champ différent d'un seul côté fait échouer l'écriture
        // en silence (c'est exactement le bug du 16/10 : Pillbox avait
        // été mis à jour, pas ce fichier).
        const { weekKey, entries } = body;
        if (!weekKey || !/^[0-9a-zA-Z_-]+$/.test(weekKey) || !Array.isArray(entries)) {
          return json(400, { error: "Paramètres invalides (weekKey/entries attendus)." }, corsHeaders);
        }
        const cleanEntries = entries.slice(0, 200).map(e => ({
          category: String(e.category||"").slice(0,80),
          employeeKey: String(e.employeeKey||"").slice(0,120),
          sentence: String(e.sentence||"").slice(0,400),
          details: String(e.details||"").slice(0,600),
          decided: e.decided === true ? true : (e.decided === false ? false : null),
        })).filter(e => e.employeeKey);

        // 16/10 — restauration des décisions déjà enregistrées :
        // si le navigateur qui republie la session ne connaît pas encore
        // le choix d'un employé, ne pas remplacer ce choix par "en attente".
        // Les décisions booléennes sauvegardées sont conservées; un choix
        // explicite local (true/false) reste prioritaire.
        try {
          const decisionsRes = await fetch(`${LIVE_UP_DECISIONS_BASE}/${weekKey}.json?auth=${idToken}`);
          if (decisionsRes.ok) {
            const savedDecisions = await decisionsRes.json() || {};
            for (const entry of cleanEntries) {
              if (entry.decided === null) {
                const saved = savedDecisions[entry.employeeKey];
                if (saved && (saved.value === true || saved.value === false)) {
                  entry.decided = saved.value;
                }
              }
            }
          }
        } catch (e) {
          // Une lecture historique indisponible ne doit pas bloquer la session.
        }

        const payload = { operatorDiscordId: session.discordId, operatorName: session.name, updatedAt: Date.now(), entries: cleanEntries };
        const putRes = await fetch(`${LIVE_UP_SESSIONS_URL.replace(".json", `/${weekKey}.json`)}?auth=${idToken}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!putRes.ok) { const t = await putRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${putRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }
        return json(200, { ok: true }, corsHeaders);
      }
      if (body.action === "setLiveUpDecision") {
        // (13/10, repensé le 15/10) Publie UNIQUEMENT le choix que la
        // session qui traite réellement la paie vient elle-même de
        // faire — pour que "📡 Paye active" (OWNER, lecture seule)
        // puisse l'afficher en direct. Il n'existe plus aucun moyen,
        // depuis cette action, d'écrire la décision de quelqu'un
        // d'autre : l'ancien mode "Modification OWNER" a été retiré à
        // la demande, pour éviter qu'une personne pense s'être trompée
        // ou que l'outil bugue à cause d'un changement fait ailleurs.
        const { weekKey, employeeKey, value } = body;
        if (!weekKey || !/^[0-9a-zA-Z_-]+$/.test(weekKey) || !employeeKey || typeof employeeKey !== "string") {
          return json(400, { error: "Paramètres invalides (weekKey/employeeKey attendus)." }, corsHeaders);
        }
        if (value !== true && value !== false && value !== null) {
          return json(400, { error: "Valeur invalide (true/false/null attendu)." }, corsHeaders);
        }
        const url = `${LIVE_UP_DECISIONS_BASE}/${weekKey}/${encodeURIComponent(employeeKey)}.json?auth=${idToken}`;
        const entry = { value, updatedAt: Date.now(), updatedByDiscordId: session.discordId, updatedByName: session.name };
        const putRes = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });
        if (!putRes.ok) { const t = await putRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${putRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }
        return json(200, { ok: true }, corsHeaders);
      }
      if (body.action === "setAbsenceAlertDecision") {
        // (13/10, sections 2.6/2.8) Décision OUI/NON sur une alerte STG
        // (2 absences/2 semaines) ou absence longue (>67j), posée
        // depuis Pillbox au moment de la préparation des paies — même
        // permission que pour gérer les absences côté Roster, jamais
        // un simple appel public.
        if (!can(session.level, "manage_absences", null, session.discordId, null)) {
          return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` }, corsHeaders);
        }
        const { alertKey, decision } = body;
        if (!alertKey || (decision !== "oui" && decision !== "non")) {
          return json(400, { error: "Paramètres invalides (alertKey/decision attendus)." }, corsHeaders);
        }
        const curRes = await fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`);
        const current = curRes.ok ? ((await curRes.json()) || {}) : {};
        current[alertKey] = { decision, decidedAt: Date.now(), decidedByDiscordId: session.discordId, decidedByName: session.name };
        const saveRes = await fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
        });
        if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }, corsHeaders); }
        await logAction({
          action: "absence_alerte_decidee", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          details: `${alertKey} -> ${decision} (depuis Pillbox)`, idToken,
        }).catch(()=>{});
        return json(200, { ok: true }, corsHeaders);
      }
      return json(400, { error: "Action POST inconnue." }, corsHeaders);
    }

    const [rosterRes, discordIdsRes, syncMetaRes, absencesRes, payRulesRes, alertDecisionsRes, animPrefRes] = await Promise.all([
      fetch(`${ROSTER_URL}?auth=${idToken}`),
      fetch(`${DISCORD_IDS_URL}?auth=${idToken}`),
      fetch(`${ROSTER_SYNC_META_URL}?auth=${idToken}`),
      fetch(`${ABSENCES_URL}?auth=${idToken}`),
      fetch(PAY_RULES_URL), // lecture publique, comme rosterGradeLabels — pas besoin du jeton
      fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`),
      fetch(`${ANIM_PREFS_BASE}/${encodeURIComponent(session.discordId)}.json?auth=${idToken}`),
    ]);
    const animPref = animPrefRes.ok ? await animPrefRes.json() : null;
    const roster = rosterRes.ok ? await rosterRes.json() : null;
    const discordIds = discordIdsRes.ok ? await discordIdsRes.json() : null;
    const rosterSyncMeta = syncMetaRes.ok ? await syncMetaRes.json() : null;
    let absences = absencesRes.ok ? await absencesRes.json() : null;
    // (10/10, demandé) Même nettoyage automatique que côté Roster
    // (absences-actions.js GET) — pour que Pillbox ne voie jamais une
    // entrée WDV ou expirée (3 semaines) que le Roster aurait déjà purgée.
    if(absences) absences = await pruneExpiredAbsences(absences, idToken);
    const alertDecisions = alertDecisionsRes.ok ? ((await alertDecisionsRes.json()) || {}) : {};
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
    // (13/10, sections 2.6/2.8) Mêmes règles exactes que le Roster,
    // jamais recalculées différemment — décisions déjà prises
    // rattachées ici pour que Pillbox n'ait jamais à redemander une
    // question déjà répondue tant que le jeu d'absences ne change pas.
    const stgAbsenceSignalements = attachAlertDecisions(computeStgAbsenceSignalements(absences || {}), "stg2sem", alertDecisions);
    const longAbsenceSignalements = attachAlertDecisions(computeLongAbsenceSignalements(absences || {}), "long67j", alertDecisions);

    // (13/10, section 6/7) Le bouton "Modification OWNER" (et tout
    // futur affichage conditionnel équivalent) se fie à CE calcul
    // serveur, jamais à une simple variable côté navigateur — recalculé
    // à chaque appel, donc une révocation prend effet immédiatement.
    const permCtx = await loadPermissionContext(idToken).catch(()=>({custom:null, individual:null}));
    const isOwnerOrDelegate = can(session.level, "owner_delegate", permCtx.custom, session.discordId, permCtx.individual) || session.level === "OWNER";
    // Exclusion globale des personnages d'animation : même source individuelle
    // que le panneau Permissions du Roster. Cela vaut pour les deux outils.
    const animationExcludedIds = Object.keys(permCtx.individual || {}).filter(id =>
      resolveIndividualDecision(id, "exclude_animations", permCtx.individual) === true
    );
    const animExcludedSelf = animationExcludedIds.includes(String(session.discordId));

    // (13/10, section 6) Décisions UP en direct pour la semaine en cours
    // — lues à chaque appel (polling côté Pillbox, ~3s) pour que la
    // session active ET le panneau "Modification OWNER" restent
    // synchronisés sans avoir à se faire confiance l'un l'autre en
    // dehors de Firebase.
    const liveWeekKey = (event.queryStringParameters && event.queryStringParameters.liveWeekKey) || null;
    let liveUpDecisions = {};
    if (liveWeekKey && /^[0-9a-zA-Z_-]+$/.test(liveWeekKey)) {
      const liveRes = await fetch(`${LIVE_UP_DECISIONS_BASE}/${liveWeekKey}.json?auth=${idToken}`);
      liveUpDecisions = liveRes.ok ? ((await liveRes.json()) || {}) : {};
    }
    // (14/10) Toujours incluse (coût négligeable) : seule façon pour le
    // panneau "Modification OWNER" de savoir, sans rien demander à
    // l'avance, qui traite quelle semaine en ce moment.
    let liveUpSessions = {};
    if (event.queryStringParameters && event.queryStringParameters.wantLiveSessions === "1") {
      const sessRes = await fetch(`${LIVE_UP_SESSIONS_URL}?auth=${idToken}`);
      liveUpSessions = sessRes.ok ? ((await sessRes.json()) || {}) : {};
    }

    return json(200, {
      roster, rosterSyncMeta, discordIds: { text: mergedText, source: "roster+manuel", rosterCount: rosterLines.length },
      absenceSignalements, stgAbsenceSignalements, longAbsenceSignalements, payRules, isOwnerOrDelegate, liveUpDecisions, liveUpSessions,
      animEnabled: animPref && typeof animPref.enabled === "boolean" ? animPref.enabled : null,
      animLocked: !!(animPref && animPref.lockedByOwner),
      animExcludedSelf, animationExcludedIds,
    }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
