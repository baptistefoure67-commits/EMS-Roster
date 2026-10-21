// ═══════════════════════════════════════════════════════════════════
// activite-close.js (11/10) — clôture hebdomadaire Formateur/Psychologue
// faite CÔTÉ SERVEUR, au moment même où Pillbox clique « J'ai terminé
// cette semaine » (appelé par pillbox-proxy.js, action "weekFinished").
//
// Pourquoi (causes réelles trouvées à l'audit) :
//  1. Avant, Pillbox écrivait juste un horodatage (weekFinishedAt) et
//     c'était un NAVIGATEUR ouvert sur le Roster qui devait le remarquer
//     puis faire la clôture lui-même → rien ne se passait tant que
//     personne n'ouvrait le Roster.
//  2. Toute sauvegarde d'activité depuis le Roster (activite-actions.js,
//     PUT complet du nœud) effaçait ce signal → reset perdu pour de bon.
//  3. "Déjà traité" était mémorisé dans le localStorage de CHAQUE
//     navigateur → chaque PC pouvait refaire la clôture (séries
//     incrémentées plusieurs fois, signalements en double).
//
// Ce module reprend À L'IDENTIQUE la logique de closeActiviteWeek() du
// Roster (aucune règle métier changée) :
//  - concernés : non licenciés, MF/RF (formateur), MP/RP (psychologue)
//  - absent(e) cette semaine → série en pause (ni +1, ni remise à 0)
//  - aucune activité et pas "excusé" → série +1 ; palier atteint
//    (multiple de 2 pour MF/MP, 3 pour RF/RP) et jamais signalé pour ce
//    cycle → signalement automatique
//  - au moins une activité, ou "excusé" → série et palier remis à 0
//  - compteurs remis à 0, marqueur "excusé" effacé
// La seule différence : "absent cette semaine" vient maintenant de
// Pillbox (absence d'au moins 3 jours dans la semaine payée — même
// définition que pour l'exemption de quota), puisque c'est Pillbox qui
// connaît exactement la semaine qu'on clôture.
//
// Garanties :
//  - une seule clôture par semaine Pillbox (marqueur rosterActiviteClosures/
//    {weekKey}, posé par écriture conditionnelle Firebase — double clic,
//    deux PC, relance après erreur : jamais de double traitement)
//  - écriture de l'activité conditionnelle (ETag) : une sauvegarde faite
//    au même instant par quelqu'un d'autre n'est jamais écrasée en silence
//  - si un pôle a déjà été clôturé à la main depuis le Roster après le
//    début du dernier jour de la semaine, il n'est PAS re-clôturé
//  - en cas d'échec avant l'écriture principale : rien n'est modifié, le
//    marqueur est libéré, Pillbox peut relancer sans risque
// ═══════════════════════════════════════════════════════════════════

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const ACTIVITE_URL = `${BASE}/activiteSuivi.json`;
const ROSTER_URL = `${BASE}/rosterEmsData.json`;
const LAST_CLOSURE_URL = `${BASE}/rosterActiviteLastClosure.json`;
const ABSENCES_URL = `${BASE}/rosterAbsences.json`;
const closureUrl = (weekKey) => `${BASE}/rosterActiviteClosures/${weekKey}.json`;

const SCOPES = {
  formateur:   { grades: ["MF","RF"], fields: ["recrutements","formations"], label: "recrutement/formation" },
  psychologue: { grades: ["MP","RP"], fields: ["testsPsy","ppa","consultations"], label: "PPA/test psy/consultation" },
};
const PENDING_STALE_MS = 2 * 60 * 1000; // un marqueur "en cours" plus vieux que ça est considéré abandonné

function activiteKeyFor(e){ return e.idUnique ? `id:${e.idUnique}` : `name:${String(e.name||"").trim().toLowerCase()}`; }
const SPECIALTY_BY_GRADE = {
  MF:{ fields:["recrutements","formations"] }, RF:{ fields:["recrutements","formations"] },
  MP:{ fields:["testsPsy","ppa","consultations"] }, RP:{ fields:["testsPsy","ppa","consultations"] },
};
function normalizeActivityRecord(record, grade){
  const cfg = SPECIALTY_BY_GRADE[String(grade||"").toUpperCase()];
  if(!cfg || !record || typeof record!=="object") return null;
  const out={};
  cfg.fields.forEach(f=>{ if(Object.prototype.hasOwnProperty.call(record,f)) out[f]=Math.max(0,Number(record[f])||0); });
  if(record.excused===true) out.excused=true;
  if(!Object.keys(out).length) cfg.fields.forEach(f=>{ out[f]=0; });
  return out;
}
function sanitizeActivityState(activite, employees){
  const srcData={...((activite&&activite.data)||{})};
  const srcStreak={...((activite&&activite.streak)||{})};
  const data={}, streak={};
  (employees||[]).filter(e=>!e.licencie && SPECIALTY_BY_GRADE[String(e.grade||"").toUpperCase()]).forEach(emp=>{
    const canonical=activiteKeyFor(emp);
    const nameKey=`name:${String(emp.name||"").trim().toLowerCase()}`;
    const oldRec=(nameKey!==canonical && srcData[nameKey]) ? srcData[nameKey] : null;
    const canonRec=srcData[canonical]||null;
    const merged=oldRec||canonRec ? {...(oldRec||{}),...(canonRec||{})} : null;
    if(merged) data[canonical]=normalizeActivityRecord(merged,emp.grade);
    const st=srcStreak[canonical]!==undefined?srcStreak[canonical]:srcStreak[nameKey];
    if(st!==undefined&&st!==null) streak[canonical]=st;
  });
  return {data,streak};
}
function streakThresholdFor(e){ return ["RF","RP"].includes(String((e && e.grade)||"").toUpperCase()) ? 3 : 2; }
function utcDayKey(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }

async function getWithEtag(url, idToken){
  const res = await fetch(`${url}?auth=${idToken}`, { headers: { "X-Firebase-ETag": "true" } });
  if (!res.ok) throw new Error(`lecture ${res.status}`);
  const etag = res.headers && res.headers.get ? res.headers.get("etag") : null;
  const value = await res.json().catch(()=>null);
  return { value, etag };
}
async function putIfMatch(url, idToken, body, etag){
  const headers = { "Content-Type": "application/json" };
  if (etag) headers["if-match"] = etag;
  return fetch(`${url}?auth=${idToken}`, { method: "PUT", headers, body: JSON.stringify(body) });
}

// Calcule le nouvel état (fonction PURE — testée à part), sans rien écrire.
function computeClosure({ activite, employees, scopesToClose, isAbsent, now }){
  // Nettoie d'abord les anciennes SP et les doubles clés name:/id:, sinon
  // une clôture Pillbox pourrait réinjecter exactement les entrées que le
  // Roster vient de nettoyer.
  const sanitized = sanitizeActivityState(activite, employees);
  const data = { ...sanitized.data };
  const streak = { ...sanitized.streak };
  const historyByScope = {};
  const signalementsToCreate = [];
  for (const scope of scopesToClose){
    const cfg = SCOPES[scope];
    const concerned = (employees||[]).filter(e=>!e.licencie && cfg.grades.includes(String(e.grade||"").toUpperCase()));
    const before = {}, after = {};
    for (const e of concerned){
      const key = activiteKeyFor(e);
      const rec = data[key] || {};
      before[key] = { data: data[key] || null, streak: streak[key] || null };
      const prev = (streak[key] && streak[key].streak) || 0;
      const lastSignaled = (streak[key] && streak[key].lastSignaledThreshold) || 0;
      const threshold = streakThresholdFor(e);
      const hasActivity = cfg.fields.some(f=>(rec[f]||0)>0);
      if (isAbsent(e)) {
        // pause : série et palier inchangés
      } else if (!hasActivity && rec.excused !== true) {
        const next = prev + 1;
        let newLast = lastSignaled;
        if (next % threshold === 0 && next > lastSignaled) {
          signalementsToCreate.push({
            personName: e.name, personId: e.idUnique || null, personGrade: String(e.grade||"").toUpperCase(),
            category: "inactivite",
            reason: `Signalement automatique : ${next} semaines de suite sans ${cfg.label} (généré par le suivi d'activité, aucune saisie humaine).`,
            createdAt: now, auto: true,
          });
          newLast = next;
        }
        streak[key] = { streak: next, lastSignaledThreshold: newLast };
      } else {
        streak[key] = { streak: 0, lastSignaledThreshold: 0 };
      }
      const cleared = { ...rec };
      cfg.fields.forEach(f=>{ cleared[f] = 0; });
      delete cleared.excused;
      data[key] = cleared;
      after[key] = { data: data[key], streak: streak[key] || null };
    }
    historyByScope[scope] = { before, after };
  }
  return { data, streak, historyByScope, signalementsToCreate };
}

async function closeActiviteWeekServer({ idToken, weekKey, weekEndMs, absentIds, absentNames, session, logAction }){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekKey||""))) return { status: 400, body: { error: "Semaine invalide." } };
  const now = Date.now();
  const byName = `${session && session.name || "?"} (via Pillbox)`;

  // 1) Réserver la clôture de CETTE semaine (une seule fois, jamais deux)
  let claim;
  try { claim = await getWithEtag(closureUrl(weekKey), idToken); }
  catch (e) { return { status: 502, body: { error: `Lecture du marqueur impossible (${e.message}).` } }; }
  const existing = claim.value;
  if (existing && existing.status === "done") return { status: 200, body: { ok: true, alreadyDone: true, closedAt: existing.closedAt || null } };
  if (existing && existing.status === "pending" && now - (existing.claimedAt||0) < PENDING_STALE_MS) {
    return { status: 409, body: { error: "Clôture déjà en cours (autre clic ou autre PC) — réessaie dans quelques secondes.", inProgress: true } };
  }
  const claimRes = await putIfMatch(closureUrl(weekKey), idToken, { status: "pending", claimedAt: now, byName }, claim.etag);
  if (claimRes.status === 412) {
    const again = await getWithEtag(closureUrl(weekKey), idToken).catch(()=>({value:null}));
    if (again.value && again.value.status === "done") return { status: 200, body: { ok: true, alreadyDone: true, closedAt: again.value.closedAt || null } };
    return { status: 409, body: { error: "Clôture déjà en cours (autre clic ou autre PC) — réessaie dans quelques secondes.", inProgress: true } };
  }
  if (!claimRes.ok) return { status: 502, body: { error: `Impossible de réserver la clôture (${claimRes.status}).` } };

  const release = () => fetch(`${closureUrl(weekKey)}?auth=${idToken}`, { method: "DELETE" }).catch(()=>{});
  // Une fois l'écriture principale faite, le verrou ne doit PLUS JAMAIS
  // être libéré — sinon une relance referait la clôture en double.
  let mainWritten = false;

  try {
    // 2) Données nécessaires
    const [rosterRes, lastRes, absencesRes] = await Promise.all([
      fetch(`${ROSTER_URL}?auth=${idToken}`),
      fetch(`${LAST_CLOSURE_URL}?auth=${idToken}`),
      fetch(`${ABSENCES_URL}?auth=${idToken}`),
    ]);
    if (!rosterRes.ok) throw new Error(`lecture du Roster ${rosterRes.status}`);
    const roster = await rosterRes.json().catch(()=>null);
    const employees = (roster && Array.isArray(roster.employees)) ? roster.employees : [];
    const lastClosure = lastRes.ok ? ((await lastRes.json().catch(()=>null)) || {}) : {};
    const officialAbsences = absencesRes.ok ? ((await absencesRes.json().catch(()=>null)) || {}) : {};

    // Pôle déjà clôturé à la main dans le Roster depuis le début du
    // dernier jour de la semaine → on ne le re-clôture pas.
    const scopesToClose = Object.keys(SCOPES).filter(s => !(typeof weekEndMs === "number" && (lastClosure[s]||0) >= weekEndMs));
    const skippedScopes = Object.keys(SCOPES).filter(s => !scopesToClose.includes(s));

    const idSet = new Set((absentIds||[]).map(x=>String(x)));
    const nameSet = new Set((absentNames||[]).map(x=>String(x).trim().toLowerCase()));
    // (13/10, section 8 du cahier des charges V2) "absent cette semaine"
    // venait UNIQUEMENT de Pillbox (texte brut de la colonne Absences du
    // tableau EMS collé cette semaine-là — même source que l'exemption
    // de quota, jamais le registre officiel des absences). Ça restait
    // vrai pour l'exemption de quota (hors périmètre ici, pas touché),
    // mais le cahier des charges demande que ce soit le registre
    // OFFICIEL (rosterAbsences, Prise en compte = OUI) qui mette en
    // pause une série — ajouté ici en UNION avec le signal de Pillbox
    // (jamais en remplacement : aucune des deux sources n'est retirée,
    // donc aucune régression possible sur ce qui marchait déjà).
    const weekEndDate = typeof weekEndMs === "number" ? new Date(weekEndMs) : new Date(now);
    const recentCutoff = new Date(weekEndDate.getTime() - 7*86400000);
    const officiallyAbsentIds = new Set();
    const officiallyAbsentNames = new Set();
    Object.values(officialAbsences||{}).forEach(a=>{
      if(!a || a.priseEnCompte !== true) return;
      const start = new Date(`${a.startIso}T00:00:00`);
      const end = new Date(`${a.endIso}T00:00:00`);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
      const ongoing = start <= weekEndDate && weekEndDate <= end;
      const justEnded = end < weekEndDate && end >= recentCutoff;
      if (!ongoing && !justEnded) return;
      const m = /^id:(.+)$/.exec(a.employeeKey||"");
      if (m) officiallyAbsentIds.add(m[1]);
      else if (a.name) officiallyAbsentNames.add(String(a.name).trim().toLowerCase());
    });
    const isAbsent = e => (e.idUnique && (idSet.has(String(e.idUnique)) || officiallyAbsentIds.has(String(e.idUnique))))
      || nameSet.has(String(e.name||"").trim().toLowerCase())
      || officiallyAbsentNames.has(String(e.name||"").trim().toLowerCase());

    // 3) Écriture principale, conditionnelle (jusqu'à 3 essais si quelqu'un
    //    a sauvegardé l'activité au même instant)
    let result = null;
    for (let attempt = 0; attempt < 3 && scopesToClose.length; attempt++){
      const cur = await getWithEtag(ACTIVITE_URL, idToken);
      result = computeClosure({ activite: cur.value, employees, scopesToClose, isAbsent, now });
      const savedAt = Math.max(now, (cur.value && cur.value.savedAt) || 0);
      const putRes = await putIfMatch(ACTIVITE_URL, idToken, {
        data: result.data,
        streak: Object.keys(result.streak).length ? result.streak : null,
        savedAt,
      }, cur.etag);
      if (putRes.ok) { mainWritten = true; break; }
      result = null;
      if (putRes.status !== 412) { const t = await putRes.text().catch(()=>""); throw new Error(`écriture de l'activité ${putRes.status} ${t.slice(0,150)}`); }
    }
    if (scopesToClose.length && !result) throw new Error("conflit d'écriture persistant (sauvegardes simultanées)");

    // 4) Effets secondaires — uniquement APRÈS l'écriture principale réussie
    //    (un échec avant elle ne crée donc jamais de signalement en double)
    let signalementsCreated = 0;
    if (result) {
      const dayKey = utcDayKey(new Date(now));
      for (const scope of scopesToClose){
        const histUrl = `${BASE}/rosterActiviteWeekHistory/${dayKey}/${scope}.json?auth=${idToken}`;
        try{
          const ex = await fetch(histUrl); const exVal = ex.ok ? await ex.json() : null;
          if (exVal) await fetch(`${BASE}/rosterActiviteWeekHistoryArchive/${dayKey}-${scope}/${now}.json?auth=${idToken}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(exVal) });
        }catch(e){ /* non bloquant */ }
        await fetch(histUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
          type: scope, closedAt: now,
          closedByDiscordId: (session && session.discordId) || null, closedByName: byName, closedByLevel: (session && session.level) || null,
          before: result.historyByScope[scope].before, after: result.historyByScope[scope].after,
          reopened: false, pillboxWeekKey: weekKey,
        }) }).catch(()=>{});
      }
      for (const s of result.signalementsToCreate){
        const id = `${now}-${Math.random().toString(36).slice(2,10)}`;
        const r = await fetch(`${BASE}/signalements/${id}.json?auth=${idToken}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(s) }).catch(()=>null);
        if (r && r.ok) signalementsCreated++;
      }
      const lastPatch = {}; scopesToClose.forEach(s=>{ lastPatch[s] = now; });
      await fetch(`${LAST_CLOSURE_URL}?auth=${idToken}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify(lastPatch) }).catch(()=>{});
    }

    // 5) Marquer la semaine comme définitivement traitée
    await fetch(`${closureUrl(weekKey)}?auth=${idToken}`, { method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ status: "done", claimedAt: now, closedAt: Date.now(), byName, closedScopes: scopesToClose, skippedScopes }) });

    if (logAction) {
      await logAction({
        action: "cloture_semaine_activite_pillbox",
        authorDiscordId: session && session.discordId, authorName: byName, authorLevel: session && session.level,
        details: `Semaine Pillbox ${weekKey} — pôles clôturés : ${scopesToClose.join(", ")||"aucun"}${skippedScopes.length?` (déjà clôturés à la main : ${skippedScopes.join(", ")})`:""} — ${signalementsCreated} signalement(s) automatique(s)`,
        idToken,
      }).catch(()=>{});
    }
    return { status: 200, body: { ok: true, closedScopes: scopesToClose, skippedScopes, signalementsCreated } };
  } catch (err) {
    if (mainWritten) {
      // Compteurs déjà remis à zéro : on tente encore de marquer la
      // semaine comme faite, et on ne libère surtout pas le verrou.
      await fetch(`${closureUrl(weekKey)}?auth=${idToken}`, { method:"PUT", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ status: "done", claimedAt: now, closedAt: Date.now(), byName, note: "finalisation partielle" }) }).catch(()=>{});
      return { status: 200, body: { ok: true, partial: true, warning: `Compteurs bien remis à zéro, mais une étape secondaire a échoué (${err.message}).` } };
    }
    await release();
    return { status: 502, body: { error: `Clôture Formateur/Psy échouée, rien n'a été modifié (${err.message}).` } };
  }
}

module.exports = { closeActiviteWeekServer, computeClosure, activiteKeyFor, streakThresholdFor, sanitizeActivityState };
