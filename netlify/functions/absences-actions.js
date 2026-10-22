// ═══════════════════════════════════════════════════════════════════
// absences-actions.js — suivi des absences de plus de 3 jours (03/10).
// Détecte → conserve → laisse un responsable décider (jamais de
// rétrogradation/licenciement automatique ici, voir section 17 du
// cahier des charges). Chemin Firebase dédié : rosterAbsences — séparé
// de rosterEmsData, jamais une deuxième source manuelle qui pourrait
// entrer en contradiction avec le Tableau EMS.
//
// Deux actions :
//   - "sync"            : fusionne les absences qualifiantes (>3 jours)
//                          détectées dans un collage EMS. Ne touche
//                          JAMAIS une entrée déjà connue (son statut
//                          Prise en compte reste tel quel) — ne fait
//                          qu'ajouter les nouvelles. Réservé
//                          can(level, "manage_absences").
//   - "setPriseEnCompte" : bascule OUI/NON une absence précise, sans
//                          jamais la supprimer (section 6-7 du cahier
//                          des charges). Réservé can(level,
//                          "manage_absences"), tracé dans les logs.
//
// GET : liste complète, réservée à une session valide avec
// can(level, "view_roster") — comme le reste du Roster, jamais public.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can, canFor } = require("./permissions");
const { logAction } = require("./logs");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const ABSENCES_URL = `${BASE}/rosterAbsences.json`;
const ROSTER_URL = `${BASE}/rosterEmsData.json`;
const INDIVIDUAL_URL = `${BASE}/rosterIndividualPermissions.json`;
// (13/10) NOUVEAU CHEMIN FIREBASE — nécessite l'ajout de ses propres
// règles de validation dans la console Firebase (voir le rapport final
// livré avec les ZIP) avant que l'écriture ne fonctionne réellement en
// production ; lecture/écriture tentées ici en supposant des règles du
// type ".read": "auth != null", ".write": "auth != null".
const ABSENCE_ALERT_DECISIONS_URL = `${BASE}/rosterAbsenceAlertDecisions.json`;

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

// Clé stable pour éviter les doublons lors de synchronisations répétées
// (section 13 du cahier des charges) : employé + dates exactes de
// l'absence. Une même absence recollée plusieurs fois donne toujours
// la même clé, donc jamais une deuxième ligne.
function absenceKey(employeeKey, startIso, endIso){
  return `${employeeKey}__${startIso}__${endIso}`;
}

// (13/10) Grades MC et au-dessus : leurs absences restent enregistrées
// (historique, affichage) mais ne doivent JAMAIS déclencher une des
// règles de signalement automatique ci-dessous (cahier des charges
// V2, section 2.3). Un seul point de vérité, réutilisé par toutes les
// fonctions de calcul de cette section.
const MC_AND_ABOVE = new Set(["MC","ADD","CD","D","DG"]);

// Détection du signalement générique (section 8 d'origine, inchangée) :
// 3 absences PRISES EN COMPTE (priseEnCompte=true) dont la date de FIN
// tombe dans les 30 derniers jours glissants par rapport à refDate (pas
// un mois civil). Groupe par employeeKey ; une absence très longue
// (14j, 20j...) ne compte toujours que pour UNE puisqu'elle n'a qu'une
// seule clé. S'applique de A jusqu'à MC exclu (section 2.3 : MC et
// au-dessus exemptés) — les STG suivent leur propre règle séparée
// (computeStgAbsenceSignalements), jamais celle-ci à la fois.
// Exporté pour être réutilisé tel quel par pillbox-proxy.js, sans
// dupliquer cette règle ailleurs.
function computeAbsenceSignalements(absencesObj, refDate){
  const ref = refDate || new Date();
  const windowStart = new Date(ref.getTime() - 30*24*60*60*1000);
  const byEmployee = {};
  Object.entries(absencesObj || {}).forEach(([id, a]) => {
    if (!a || a.priseEnCompte !== true) return;
    if (a.grade === "STG" || MC_AND_ABOVE.has(a.grade)) return;
    const end = new Date(a.endIso);
    if (isNaN(end.getTime()) || end < windowStart || end > ref) return;
    const key = a.employeeKey;
    (byEmployee[key] = byEmployee[key] || { employeeKey: key, name: a.name, grade: a.grade, absences: [] }).absences.push({ id, startIso: a.startIso, endIso: a.endIso, durationDays: a.durationDays });
  });
  return Object.values(byEmployee).filter(e => e.absences.length >= 3);
}

// (13/10, section 2.6) Règle spéciale STG : DEUX absences DISTINCTES
// (donc deux entrées séparées, jamais une seule absence continue —
// voir absenceKey : une absence continue n'a qu'une clé, donc ne peut
// jamais en fournir deux) dont la période combinée (du début de la
// plus ancienne à la fin de la plus récente) tient dans 14 jours.
// Jamais appliqué à un autre grade que STG. Une seule proposition par
// personne, basée sur la paire la PLUS RÉCENTE trouvée.
const STG_WINDOW_DAYS = 14;
function computeStgAbsenceSignalements(absencesObj, refDate){
  const ref = refDate || new Date();
  const byEmployee = {};
  Object.entries(absencesObj || {}).forEach(([id, a]) => {
    if (!a || a.priseEnCompte !== true || a.grade !== "STG") return;
    const start = new Date(a.startIso), end = new Date(a.endIso);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end > ref) return;
    (byEmployee[a.employeeKey] = byEmployee[a.employeeKey] || { employeeKey: a.employeeKey, name: a.name, grade: a.grade, list: [] })
      .list.push({ id, startIso: a.startIso, endIso: a.endIso, start, end });
  });
  const result = [];
  Object.values(byEmployee).forEach(emp => {
    if (emp.list.length < 2) return;
    emp.list.sort((x,y)=> x.start - y.start);
    // Cherche la paire la plus récente (en partant de la fin) dont
    // l'étendue totale (début de la plus ancienne -> fin de la plus
    // récente des deux) tient dans STG_WINDOW_DAYS jours.
    for (let i = emp.list.length - 1; i > 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const spanDays = (emp.list[i].end - emp.list[j].start) / 86400000;
        if (spanDays <= STG_WINDOW_DAYS) {
          result.push({
            employeeKey: emp.employeeKey, name: emp.name, grade: emp.grade,
            absences: [
              { id: emp.list[j].id, startIso: emp.list[j].startIso, endIso: emp.list[j].endIso },
              { id: emp.list[i].id, startIso: emp.list[i].startIso, endIso: emp.list[i].endIso },
            ],
          });
          return; // une seule proposition par personne
        }
      }
    }
  });
  return result;
}

// (13/10, section 2.8) Absence unique dépassant 2 mois et 7 jours (67
// jours pleins). Jamais une absence MC+ (section 2.3). Une seule
// entrée par absence qualifiante (pas de regroupement par personne —
// section 2.8 traite chaque absence longue indépendamment).
const LONG_ABSENCE_DAYS = 67;
function computeLongAbsenceSignalements(absencesObj, refDate){
  const ref = refDate || new Date();
  const result = [];
  Object.entries(absencesObj || {}).forEach(([id, a]) => {
    if (!a || a.priseEnCompte !== true || MC_AND_ABOVE.has(a.grade)) return;
    const start = new Date(a.startIso);
    if (isNaN(start.getTime())) return;
    const end = new Date(a.endIso);
    const effectiveEnd = (!isNaN(end.getTime()) && end < ref) ? end : ref; // absence toujours en cours -> compte jusqu'à aujourd'hui
    const days = Math.floor((effectiveEnd - start) / 86400000);
    if (days > LONG_ABSENCE_DAYS) {
      result.push({ employeeKey: a.employeeKey, name: a.name, grade: a.grade, absences: [{ id, startIso: a.startIso, endIso: a.endIso }], days, ongoing: effectiveEnd === ref && (isNaN(end.getTime()) || end >= ref) });
    }
  });
  return result;
}

// (13/10) Clé stable d'un GROUPE de signalement (STG ou absence
// longue), construite à partir du type de règle + des IDs d'absences
// IMPLIQUÉS, triés. Tant que le même jeu d'absences déclenche le même
// groupe, la clé ne change pas -> la décision déjà posée reste valable
// (section 2.6 : "éviter que la même question réapparaisse ... sans
// nouvel événement"). Une absence en plus/en moins dans le groupe
// change la clé -> redemande, correctement, une nouvelle décision.
function absenceAlertKey(type, absences){
  const ids = (absences||[]).map(a=>a.id).sort().join("+");
  return `${type}:${ids}`;
}

// (13/10) Résout, pour chaque groupe calculé, la décision déjà prise
// précédemment (si le jeu d'absences est EXACTEMENT le même) à partir
// de la table persistée rosterAbsenceAlertDecisions. Un groupe dont le
// jeu d'absences a changé (nouvelle absence ajoutée au groupe, etc.)
// n'a pas de décision correspondante -> redemandé normalement.
function attachAlertDecisions(groups, type, decisionsStore){
  const store = decisionsStore || {};
  return groups.map(g => {
    const key = absenceAlertKey(type, g.absences);
    const stored = store[key];
    return { ...g, alertKey: key, decision: stored ? stored.decision : null };
  });
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

// (10/10, demandé) Suppression automatique des absences anciennes, et
// des WDV (statut déjà connu/attendu, jamais un cas à faire remonter).
// Le point de départ des 3 semaines dépend de la durée : absence de 10
// jours ou moins -> compté depuis son DÉBUT (startIso) ; plus de 10
// jours -> compté depuis sa FIN (endIso). Appelée à chaque lecture
// (GET), pour que le nettoyage se fasse tout seul, sans action
// manuelle de qui que ce soit.
const AUTO_DELETE_DAYS = 21;
function findExpiredAbsenceIds(all){
  const now = Date.now();
  const expired = [];
  for(const [id, a] of Object.entries(all || {})){
    if(a.grade === "WDV"){ expired.push(id); continue; }
    // (19/10, demandé) Nettoie aussi les entrées MC et au-dessus déjà
    // enregistrées avant ce changement — plus prises en compte du tout.
    if(MC_AND_ABOVE.has(a.grade)){ expired.push(id); continue; }
    const refIso = (a.durationDays || 0) > 10 ? a.endIso : a.startIso;
    if(!refIso) continue;
    const refMs = new Date(`${refIso}T00:00:00Z`).getTime();
    if(Number.isNaN(refMs)) continue;
    if(now - refMs >= AUTO_DELETE_DAYS * 86400000) expired.push(id);
  }
  return expired;
}
// (19/10, demandé) Une absence appartenant à quelqu'un de licencié n'a
// plus aucune raison d'exister — elle disparaît toute seule, à la
// prochaine lecture, sans action manuelle. La clé employeeKey d'une
// absence suit exactement activiteKeyFor() côté Roster (id:<idUnique>
// ou name:<nom normalisé>) — reconstruite ici à l'identique pour
// retrouver les mêmes clés chez les employés marqués licencie:true.
function activiteKeyForServer(e){
  return e.idUnique ? `id:${e.idUnique}` : `name:${String(e.name||"").trim().toLowerCase()}`;
}
function findLicencieAbsenceIds(all, employees){
  const licencieKeys = new Set((employees||[]).filter(e=>e && e.licencie).map(activiteKeyForServer));
  if(!licencieKeys.size) return [];
  return Object.entries(all || {}).filter(([,a]) => a && licencieKeys.has(a.employeeKey)).map(([id]) => id);
}
async function pruneExpiredAbsences(all, idToken){
  let expiredIds = findExpiredAbsenceIds(all);
  try{
    const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
    const rosterData = rosterRes.ok ? (await rosterRes.json()) : null;
    const licencieIds = findLicencieAbsenceIds(all, rosterData && rosterData.employees);
    if(licencieIds.length) expiredIds = [...new Set([...expiredIds, ...licencieIds])];
  }catch(e){ /* roster injoignable -- on nettoie quand même les absences expirées normales */ }
  if(!expiredIds.length) return all;
  const patch = {};
  expiredIds.forEach(id => { patch[id] = null; });
  try{
    await fetch(`${ABSENCES_URL}?auth=${idToken}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  }catch(e){ /* échec silencieux -- retente à la prochaine lecture */ }
  const kept = { ...all };
  expiredIds.forEach(id => { delete kept[id]; });
  return kept;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }

  if (event.httpMethod === "GET") {
    const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
    const session = verify(token, SESSION_SECRET);
    if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
    if (!(await canFor(session, "view_roster"))) {
      return json(403, { error: `Permission refusée (${session.level}).` });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const res = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      let all = res.ok ? (await res.json()) : {};
      all = await pruneExpiredAbsences(all || {}, idToken);
      let decisions = {};
      try{
        const decRes = await fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`);
        decisions = decRes.ok ? ((await decRes.json()) || {}) : {};
      }catch(e){ /* absence de décisions persistées -> tout redemandé, jamais bloquant */ }
      return json(200, {
        absences: all || {},
        signalements: computeAbsenceSignalements(all),
        stgSignalements: attachAlertDecisions(computeStgAbsenceSignalements(all), "stg2sem", decisions),
        longAbsenceSignalements: attachAlertDecisions(computeLongAbsenceSignalements(all), "long67j", decisions),
      });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, action } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    let individualOverrides = null;
    try {
      const indivRes = await fetch(`${INDIVIDUAL_URL}?auth=${idToken}`);
      individualOverrides = indivRes.ok ? await indivRes.json() : null;
    } catch (e) { /* si injoignable, on retombe sur la permission de grade */ }

    if (!can(session.level, "manage_absences", null, session.discordId, individualOverrides)) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus (ou exception individuelle).` });
    }

    if (action === "sync") {
      const { qualifyingAbsences } = body;
      if (!Array.isArray(qualifyingAbsences)) {
        return json(400, { error: "Liste d'absences manquante ou invalide." });
      }
      const curRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const current = curRes.ok ? (await curRes.json()) || {} : {};
      let added = 0;
      qualifyingAbsences.forEach(a => {
        if (!a || !a.employeeKey || !a.startIso || !a.endIso || !a.name) return;
        // (13/10, section 2.4) Un WDV n'est de toute façon qu'un
        // licenciement en cours de traitement — jamais une vraie
        // absence à suivre. Avant : seulement nettoyé après coup (voir
        // findExpiredAbsenceIds) ; maintenant, jamais écrit du tout.
        if (a.grade === "WDV") return;
        // (19/10, demandé) MC et au-dessus : jamais pris en compte ni
        // comptabilisé comme absence — ni enregistré, ni affiché, ni
        // compté nulle part (avant : seulement exclus de la
        // proposition automatique de licenciement, mais visibles dans
        // la liste de base).
        if (MC_AND_ABOVE.has(a.grade)) return;
        const key = absenceKey(a.employeeKey, a.startIso, a.endIso);
        // N'ajoute QUE si inconnue — ne touche JAMAIS une entrée déjà
        // là (section 7 : jamais revenir sur une décision Prise en
        // compte déjà posée, même en recollant le même tableau).
        if (current[key]) return;
        current[key] = {
          employeeKey: a.employeeKey, name: a.name, grade: a.grade || null,
          startIso: a.startIso, endIso: a.endIso, durationDays: a.durationDays || null,
          priseEnCompte: true, // valeur par défaut (section 6)
          createdAt: Date.now(),
        };
        added++;
      });
      if (added > 0) {
        const saveRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
        });
        if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }
        await logAction({
          action: "absences_synchronisees",
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          details: `${added} nouvelle(s) absence(s) qualifiante(s) ajoutée(s)`,
          idToken,
        }).catch(()=>{});
      }
      return json(200, { ok: true, added, absences: current });
    }

    if (action === "setPriseEnCompte") {
      const { absenceId, priseEnCompte } = body;
      if (!absenceId || typeof priseEnCompte !== "boolean") {
        return json(400, { error: "Paramètres manquants ou invalides." });
      }
      const curRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const current = curRes.ok ? (await curRes.json()) || {} : {};
      const entry = current[absenceId];
      if (!entry) return json(404, { error: "Absence introuvable." });
      const before = entry.priseEnCompte;
      entry.priseEnCompte = priseEnCompte;
      const saveRes = await fetch(`${ABSENCES_URL.replace(".json", `/${absenceId}.json`)}?auth=${idToken}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priseEnCompte }),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }
      await logAction({
        action: "absence_prise_en_compte_modifiee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetName: entry.name,
        oldValue: before ? "OUI" : "NON", newValue: priseEnCompte ? "OUI" : "NON",
        details: `Absence du ${entry.startIso} au ${entry.endIso}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, entry });
    }

    if (action === "delete") {
      // (correctif) Suppression réelle, réservée aux cas de bug (mauvaise
      // date, mauvaise personne, doublon de synchronisation) — différent
      // de "Prise en compte : NON", qui sert lui à exempter une VRAIE
      // absence sans effacer l'historique (section 7 du cahier des
      // charges, inchangée). Ici, l'entrée elle-même est fausse/erronée,
      // donc sa suppression est légitime et définitive.
      const { absenceId } = body;
      if (!absenceId) return json(400, { error: "Identifiant de l'absence manquant." });
      const curRes = await fetch(`${ABSENCES_URL}?auth=${idToken}`);
      const current = curRes.ok ? (await curRes.json()) || {} : {};
      const entry = current[absenceId];
      if (!entry) return json(404, { error: "Absence introuvable." });
      const delRes = await fetch(`${ABSENCES_URL.replace(".json", `/${absenceId}.json`)}?auth=${idToken}`, { method: "DELETE" });
      if (!delRes.ok) { const t = await delRes.text().catch(()=>""); return json(502, { error: `Échec de la suppression (${delRes.status}) : ${t.slice(0,200)}` }); }
      await logAction({
        action: "absence_supprimee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetName: entry.name,
        details: `Absence du ${entry.startIso} au ${entry.endIso} (${entry.durationDays || "?"} j) — supprimée définitivement, probable erreur de donnée`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true });
    }

    if (action === "setAlertDecision") {
      // (13/10) Décision OUI/NON sur un groupe STG (2 absences/2
      // semaines) ou absence longue (>67j) — persistée pour ne plus
      // redemander tant que le jeu d'absences concerné ne change pas
      // (section 2.6/2.8). Jamais de licenciement/action appliqué ICI
      // automatiquement : juste la mémorisation de la réponse.
      const { alertKey, decision } = body;
      if (!alertKey || (decision !== "oui" && decision !== "non")) {
        return json(400, { error: "Paramètres invalides (alertKey/decision attendus)." });
      }
      const curRes = await fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`);
      const current = curRes.ok ? ((await curRes.json()) || {}) : {};
      current[alertKey] = { decision, decidedAt: Date.now(), decidedByDiscordId: session.discordId, decidedByName: session.name };
      const saveRes = await fetch(`${ABSENCE_ALERT_DECISIONS_URL}?auth=${idToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }
      await logAction({
        action: "absence_alerte_decidee",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        details: `${alertKey} -> ${decision}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true });
    }

    return json(400, { error: `Action inconnue : "${action}".` });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) };
}

module.exports.computeAbsenceSignalements = computeAbsenceSignalements;
module.exports.computeStgAbsenceSignalements = computeStgAbsenceSignalements;
module.exports.computeLongAbsenceSignalements = computeLongAbsenceSignalements;
module.exports.attachAlertDecisions = attachAlertDecisions;
module.exports.absenceAlertKey = absenceAlertKey;
module.exports.absenceKey = absenceKey;
module.exports.pruneExpiredAbsences = pruneExpiredAbsences;
module.exports.MC_AND_ABOVE = MC_AND_ABOVE;
