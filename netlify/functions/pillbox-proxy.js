// ═══════════════════════════════════════════════════════════════════
// pillbox-proxy.js — SEUL moyen pour Pillbox de lire rosterEmsData et
// discordIdsList maintenant que leur lecture directe sur Firebase est
// fermée au public (09/09, fermeture de la lecture publique — les IDs
// Discord ne doivent plus être récupérables juste en connaissant
// l'adresse Firebase).
//
// Pillbox possède désormais une vraie session Discord signée. Toutes les
// lectures/écritures sensibles passent par ce relais avec X-Pillbox-Session ;
// aucun secret fixe n'est embarqué dans le navigateur. La session est
// revérifiée ici à chaque appel, puis les permissions fines sont relues
// côté serveur lorsque l'action l'exige.
// ═══════════════════════════════════════════════════════════════════

const { createFirebaseCustomToken } = require("./firebase-token");
const { computeAbsenceSignalements, computeStgAbsenceSignalements, computeLongAbsenceSignalements, attachAlertDecisions, pruneExpiredAbsences } = require("./absences-actions");
const { verifyDetailed } = require("./session-token");
const { can, loadPermissionContext, resolveIndividualDecision } = require("./permissions");
const { cloneDefaultPayRules } = require("./pay-rules-defaults");
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
const FORMATION_OPERATION_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/formationOperationList.json";
const WEEK_HISTORY_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxWeekHistory";
const WEEK_HISTORY_ARCHIVE_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/pillboxWeekHistoryArchive";
const SIGNALEMENTS_BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";

// Valeurs par défaut partagées avec pay-rules-actions.js — source unique.
const DEFAULT_PAY_RULES = cloneDefaultPayRules();

exports.handler = async function (event) {
  // CORS : Pillbox est sur un autre domaine Netlify — sans ces en-têtes,
  // le navigateur bloquerait la réponse avant même que le code de
  // Pillbox ne la voie. L'origine CORS n'est pas une barrière de sécurité :
  // chaque requête est protégée par la session Discord signée vérifiée ci-dessous.
  // POST ajouté le 03/10 : signaler "semaine terminée" au Roster (voir
  // plus bas) exige d'écrire sur activiteSuivi, qui demande une
  // authentification Firebase — Pillbox n'en a pas en direct, donc ça
  // doit obligatoirement passer par ce relais, comme le reste.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  // Authentification unique : vraie session Discord signée, jamais une
  // valeur fixe rejouable copiée depuis le code client.
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
      clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: "service:pillbox", claims: { server: true },
    });
    const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const exchData = await exch.json();
    if (!exch.ok) throw new Error(exchData.error?.message || `${exch.status}`);
    const idToken = exchData.idToken;

    // Une session Roster signée n'implique pas automatiquement l'accès à
    // Pillbox. Revalide à CHAQUE appel la permission fine Terminal Paie
    // (grade + overrides + exception individuelle) avant toute lecture ou
    // écriture du relais.
    let requestPermCtx;
    try{
      requestPermCtx = await loadPermissionContext(idToken, {strict:true});
    }catch(e){
      return json(503, { error: "Permissions momentanément indisponibles — aucune action n'a été exécutée. Réessaie dans un instant." }, corsHeaders);
    }
    if (!can(session.level, "use_pillbox_terminal", requestPermCtx.custom, session.discordId, requestPermCtx.individual)) {
      return json(403, { error: "Accès au Terminal Paie refusé." }, corsHeaders);
    }

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
      if (body.action === "getWeekHistoryEntry") {
        // Vérification légère utilisée juste avant « Analyser la semaine ».
        // L'ancien chemin faisait un GET complet du proxy (Roster, activité,
        // absences, signalements, règles, etc.) uniquement pour savoir si la
        // semaine courante avait déjà été traitée. Cette action ne lit que
        // l'entrée demandée, ce qui évite le délai réseau avant l'animation.
        const weekKey = String(body.weekKey || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
          return json(400, { error: "Clé de semaine invalide." }, corsHeaders);
        }
        const weekUrl = `${WEEK_HISTORY_BASE}/${weekKey}.json?auth=${idToken}`;
        const weekRes = await fetch(weekUrl);
        if (!weekRes.ok) {
          const tx = await weekRes.text().catch(()=>"");
          return json(502, { error: `Lecture historique impossible (${weekRes.status}) : ${tx.slice(0,120)}` }, corsHeaders);
        }
        const entry = await weekRes.json();
        return json(200, { ok:true, state: entry == null ? "absent" : "found", entry: entry || null }, corsHeaders);
      }
      if (body.action === "saveWeekHistory") {
        const permCtx = requestPermCtx;
        if (!can(session.level, "use_pillbox_terminal", permCtx.custom, session.discordId, permCtx.individual)) {
          return json(403, { error: "Permission Terminal Paie refusée." }, corsHeaders);
        }
        const { weekKey, entry } = body;
        if (!weekKey || !/^\d{4}-\d{2}-\d{2}$/.test(weekKey) || !entry || typeof entry !== "object" || !Number.isFinite(Number(entry.processedAt))) {
          return json(400, { error: "Paramètres d'historique invalides." }, corsHeaders);
        }
        const weekUrl = `${WEEK_HISTORY_BASE}/${weekKey}.json?auth=${idToken}`;
        const existingRes = await fetch(weekUrl, { headers: { "X-Firebase-ETag": "true" } });
        if (!existingRes.ok) return json(502, { error: `Lecture historique impossible (${existingRes.status}).` }, corsHeaders);
        const etag = existingRes.headers.get("etag");
        const existing = await existingRes.json();
        // Relance idempotente après un échec sur une étape suivante : si le
        // résumé + snapshot sont déjà exactement ceux qu'on veut sauver, ne
        // crée pas une archive artificielle et ne réécrit pas processedAt.
        if (existing && stableStringify({summary:existing.summary||null,sessionSnapshot:existing.sessionSnapshot||null}) === stableStringify({summary:entry.summary||null,sessionSnapshot:entry.sessionSnapshot||null})) {
          return json(200,{ok:true,archived:false,alreadySaved:true},corsHeaders);
        }
        if (existing) {
          const archiveUrl = `${WEEK_HISTORY_ARCHIVE_BASE}/${weekKey}/${Date.now()}.json?auth=${idToken}`;
          const archiveRes = await fetch(archiveUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(existing) });
          if (!archiveRes.ok) {
            const tx = await archiveRes.text().catch(()=>"");
            return json(502, { error:`Archive impossible (${archiveRes.status}) — l'ancienne semaine n'a PAS été écrasée. ${tx.slice(0,120)}` }, corsHeaders);
          }
        }
        // (24/10, bloc 3, point 26) Chronologie complète conservée côté
        // serveur, pas comptée sur chaque appelant pour y penser : si cette
        // semaine avait déjà été réouverte, reopenHistory est reportée telle
        // quelle (jamais écrasée par une simple re-clôture), et un passage
        // de re-clôture s'ajoute à closureHistory.
        if (existing && Array.isArray(existing.reopenHistory) && existing.reopenHistory.length && !entry.reopenHistory) {
          entry.reopenHistory = existing.reopenHistory;
        }
        const existingClosures = (existing && Array.isArray(existing.closureHistory)) ? existing.closureHistory : [];
        entry.closureHistory = [...existingClosures, { at: entry.processedAt, byName: entry.summary?.paieEffectueePar || null }];

        const headers = { "Content-Type":"application/json" };
        if (etag) headers["if-match"] = etag;
        const saveRes = await fetch(weekUrl, { method:"PUT", headers, body:JSON.stringify(entry) });
        if (saveRes.status === 412) return json(409, { error:"La semaine a été modifiée par une autre session. Recharge l'historique puis réessaie." }, corsHeaders);
        if (!saveRes.ok) {
          const tx = await saveRes.text().catch(()=>"");
          return json(502, { error:`Sauvegarde historique impossible (${saveRes.status}) : ${tx.slice(0,120)}` }, corsHeaders);
        }
        // (26/10, audit confirmé) Le log de clôture est créé ICI, APRÈS que
        // l'écriture Firebase a réellement réussi — avant, il était créé
        // plus tôt (pillbox-verify-session.js) dès la vérification
        // d'identité, donc même si cette sauvegarde échouait juste après, un
        // faux log "terminée" restait dans le Roster. weekKey est inclus
        // comme champ structuré (référence stable vers la vraie archive,
        // jamais une 2e copie — point 21), pour pouvoir recréer ce log sans
        // le dupliquer si besoin plus tard.
        await logAction({
          action: "semaine_terminee_pillbox",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          details: `Semaine ${weekKey}`,
          weekKey, idToken,
        }).catch(()=>{});
        return json(200, { ok:true, archived:!!existing }, corsHeaders);
      }
      if (body.action === "listSignalements") {
        const targetRoot = body.sandbox ? "signalements_test" : "signalements";
        const readRes = await fetch(`${SIGNALEMENTS_BASE}/${targetRoot}.json?auth=${idToken}`);
        if (!readRes.ok) {
          const tx = await readRes.text().catch(()=>"");
          return json(502,{error:`Lecture des signalements impossible (${readRes.status}) : ${tx.slice(0,160)}`},corsHeaders);
        }
        return json(200,{ok:true,signalements:(await readRes.json())||{}},corsHeaders);
      }
      if (body.action === "finalizeSignalements") {
        const permCtx = requestPermCtx;
        if (!can(session.level, "use_pillbox_terminal", permCtx.custom, session.discordId, permCtx.individual)) {
          return json(403, { error: "Permission Terminal Paie refusée." }, corsHeaders);
        }
        const targetRoot = body.sandbox ? "signalements_test" : "signalements";
        const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0,200) : [];
        const obsoleteKeys = Array.isArray(body.obsoleteKeys) ? body.obsoleteKeys.slice(0,200) : [];
        const validKey = k => typeof k === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(k);

        // Une SEULE mise à jour multi-chemins Firebase : aucune clôture ne peut
        // désormais supprimer deux signalements puis échouer au troisième en
        // laissant un état à moitié appliqué. Une relance après erreur reste sûre.
        const deleteKeys = new Set();
        const deferByKey = new Map();
        for (const d of decisions) {
          const keys = Array.isArray(d.keys) ? d.keys.filter(validKey).slice(0,50) : [];
          if (d.action === "delete") {
            keys.forEach(k=>deleteKeys.add(k));
          } else if (d.action === "defer" && Number.isFinite(Number(d.deferredUntil)) && typeof d.gradeAtDecision === "string") {
            keys.forEach(k=>deferByKey.set(k,{deferredUntil:Number(d.deferredUntil),gradeAtDecision:d.gradeAtDecision}));
          }
        }
        const obsoleteSet = new Set(obsoleteKeys.filter(validKey));
        obsoleteSet.forEach(k=>deleteKeys.add(k));
        // Une suppression est prioritaire si la même clé se retrouve dans deux groupes.
        deleteKeys.forEach(k=>deferByKey.delete(k));

        const updates = {};
        deleteKeys.forEach(k=>{ updates[k]=null; });
        for (const [k,v] of deferByKey) {
          updates[`${k}/deferredUntil`] = v.deferredUntil;
          updates[`${k}/gradeAtDecision`] = v.gradeAtDecision;
        }
        if (Object.keys(updates).length) {
          const rootUrl=`${SIGNALEMENTS_BASE}/${targetRoot}.json?auth=${idToken}`;
          const patchRes=await fetch(rootUrl,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(updates)});
          if(!patchRes.ok){
            const tx=await patchRes.text().catch(()=>"");
            return json(502,{error:`Finalisation atomique des signalements impossible (${patchRes.status}) : ${tx.slice(0,160)}`},corsHeaders);
          }
        }
        return json(200,{ok:true,deleted:deleteKeys.size-obsoleteSet.size,deferred:deferByKey.size,cleaned:obsoleteSet.size},corsHeaders);
      }
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
        const permCtx = requestPermCtx;
        if (!can(session.level, "manage_absences", permCtx.custom, session.discordId, permCtx.individual)) {
          return json(403, { error: `Permission manage_absences refusée (${session.level}) selon les permissions actuelles.` }, corsHeaders);
        }
        const { alertKey, decision } = body;
        if (!alertKey || (decision !== "oui" && decision !== "non")) {
          return json(400, { error: "Paramètres invalides (alertKey/decision attendus)." }, corsHeaders);
        }
        // Écriture ciblée : ne relit et ne réécrit JAMAIS toute la branche.
        // Une panne de lecture ailleurs ne peut donc plus effacer les décisions existantes.
        const decisionBase = ABSENCE_ALERT_DECISIONS_URL.replace(/\.json$/, "");
        const decisionUrl = `${decisionBase}/${encodeURIComponent(alertKey)}.json?auth=${idToken}`;
        const entry = { decision, decidedAt: Date.now(), decidedByDiscordId: session.discordId, decidedByName: session.name };
        const saveRes = await fetch(decisionUrl, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
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

    // Lecture indépendante de chaque ressource : une panne partielle ne doit
    // jamais être transformée silencieusement en liste vide. Chaque entrée
    // porte désormais un état explicite : found / absent / error.
    const [rosterRead, discordIdsRead, syncMetaRead, activiteRead, absencesRead, payRulesRead, alertDecisionsRead, animPrefRead, formationOperationRead, weekHistoryRead, signalementsRead, signalementsTestRead] = await Promise.all([
      readJsonState(`${ROSTER_URL}?auth=${idToken}`),
      readJsonState(`${DISCORD_IDS_URL}?auth=${idToken}`),
      readJsonState(`${ROSTER_SYNC_META_URL}?auth=${idToken}`),
      readJsonState(`${ACTIVITE_URL}?auth=${idToken}`),
      readJsonState(`${ABSENCES_URL}?auth=${idToken}`),
      readJsonState(PAY_RULES_URL),
      readJsonState(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`),
      readJsonState(`${ANIM_PREFS_BASE}/${encodeURIComponent(session.discordId)}.json?auth=${idToken}`),
      readJsonState(`${FORMATION_OPERATION_URL}?auth=${idToken}`),
      readJsonState(`${WEEK_HISTORY_BASE}.json?auth=${idToken}`),
      readJsonState(`${SIGNALEMENTS_BASE}/signalements.json?auth=${idToken}`),
      readJsonState(`${SIGNALEMENTS_BASE}/signalements_test.json?auth=${idToken}`),
    ]);
    const readStatus = {
      roster: rosterRead.state, discordIds: discordIdsRead.state, rosterSyncMeta: syncMetaRead.state,
      activite: activiteRead.state, absences: absencesRead.state, payRules: payRulesRead.state,
      alertDecisions: alertDecisionsRead.state, animPref: animPrefRead.state,
      formationOperation: formationOperationRead.state, weekHistory: weekHistoryRead.state,
      signalements: signalementsRead.state, signalementsTest: signalementsTestRead.state,
    };
    const animPref = animPrefRead.data;
    const roster = rosterRead.data;
    const discordIds = discordIdsRead.data;
    const rosterSyncMeta = syncMetaRead.data;
    const activite = activiteRead.data;
    const formationOperation = formationOperationRead.data;
    // "absent" = lecture Firebase réussie mais chemin vide ; "error" = lecture impossible.
    const weekHistory = weekHistoryRead.state === "error" ? null : (weekHistoryRead.data || {});
    const signalements = signalementsRead.state === "error" ? null : (signalementsRead.data || {});
    const signalementsTest = signalementsTestRead.state === "error" ? null : (signalementsTestRead.data || {});
    let absences = absencesRead.state === "error" ? null : absencesRead.data;
    if(absences && absencesRead.state !== "error") absences = await pruneExpiredAbsences(absences, idToken);
    const alertDecisions = alertDecisionsRead.state === "error" ? null : (alertDecisionsRead.data || {});
    const storedPayRules = payRulesRead.data;
    // Une absence réelle de configuration est différente d'une panne :
    // dans le premier cas les valeurs d'origine constituent la config ;
    // dans le second, on renvoie null et le frontend BLOQUE l'analyse.
    const payRules = payRulesRead.state === "error"
      ? null
      : (storedPayRules ? { ...DEFAULT_PAY_RULES, ...storedPayRules } : { ...DEFAULT_PAY_RULES });

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
    const absenceSignalements = absencesRead.state === "error" ? null : computeAbsenceSignalements(absences || {});
    // (13/10, sections 2.6/2.8) Mêmes règles exactes que le Roster. En cas
    // d'échec de lecture, null signale explicitement "non vérifiable" au
    // lieu de fabriquer une fausse liste vide.
    const stgAbsenceSignalements = (absencesRead.state === "error" || alertDecisionsRead.state === "error")
      ? null : attachAlertDecisions(computeStgAbsenceSignalements(absences || {}), "stg2sem", alertDecisions || {});
    const longAbsenceSignalements = (absencesRead.state === "error" || alertDecisionsRead.state === "error")
      ? null : attachAlertDecisions(computeLongAbsenceSignalements(absences || {}), "long67j", alertDecisions || {});

    // (13/10, section 6/7) Le bouton "Modification OWNER" (et tout
    // futur affichage conditionnel équivalent) se fie à CE calcul
    // serveur, jamais à une simple variable côté navigateur — recalculé
    // à chaque appel, donc une révocation prend effet immédiatement.
    const permCtx = requestPermCtx;
    const isOwnerOrDelegate = can(session.level, "owner_delegate", permCtx.custom, session.discordId, permCtx.individual) || session.level === "OWNER";
    // Exclusion globale des personnages d'animation : même source individuelle
    // que le panneau Permissions du Roster. Cela vaut pour les deux outils.
    const animationExcludedIds = Object.keys(permCtx.individual || {}).filter(id =>
      resolveIndividualDecision(id, "exclude_animations", permCtx.individual) === true
    );
    const animExcludedSelf = animationExcludedIds.includes(String(session.discordId));

    // Style de portrait choisi par OWNER pour chaque personnage illustré.
    // Ce réglage est volontairement distinct des permissions booléennes :
    // il ne change aucun droit, seulement le rendu visuel des scènes.
    const animationPortraitStyles = {};
    const animationIdAliases = { "514871271352434699": "51487127135243469" };
    Object.entries(permCtx.individual || {}).forEach(([id, person]) => {
      const style = person && person.animation_portrait_style;
      if(style !== "illustration" && style !== "real") return;
      const key = animationIdAliases[String(id)] || String(id);
      animationPortraitStyles[key] = style;
    });
    const selfAnimationId = animationIdAliases[String(session.discordId)] || String(session.discordId);
    const animPortraitStyleSelf = animationPortraitStyles[selfAnimationId] || null;

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
      roster, rosterSyncMeta, activite, formationOperation, weekHistory, signalements, signalementsTest,
      readStatus, payRulesSource: payRulesRead.state === "absent" ? "defaults-no-config" : (payRulesRead.state === "found" ? "firebase" : "unavailable"),
      discordIds: { text: mergedText, source: "roster+manuel", rosterCount: rosterLines.length },
      absenceSignalements, stgAbsenceSignalements, longAbsenceSignalements, payRules, isOwnerOrDelegate, liveUpDecisions, liveUpSessions,
      animEnabled: animPref && typeof animPref.enabled === "boolean" ? animPref.enabled : null,
      animLocked: !!(animPref && animPref.lockedByOwner),
      animExcludedSelf, animationExcludedIds,
      animPortraitStyleSelf, animationPortraitStyles,
    }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

async function readJsonState(url, options){
  try{
    const res = await fetch(url, options);
    if(!res.ok){
      const text = await res.text().catch(()=>"");
      return { state:"error", data:null, httpStatus:res.status, error:text.slice(0,180) };
    }
    const data = await res.json();
    return { state:data === null ? "absent" : "found", data, httpStatus:res.status, error:null };
  }catch(err){
    return { state:"error", data:null, httpStatus:null, error:err && err.message ? err.message : String(err) };
  }
}

function stableStringify(value){
  if(value===null || typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableStringify(value[k])).join(",")}}`;
}

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
