// ═══════════════════════════════════════════════════════════════════
// activite-actions.js — SEUL point de passage autorisé pour envoyer les
// données Formation/Psychologie (PPA, tests psy, formations,
// recrutements) vers Pillbox. Avant, ceci écrivait directement sur
// Firebase depuis le navigateur, sans aucune vérification — n'importe
// qui (MC compris) pouvait appeler l'adresse Firebase directement.
//
// Vérifie précisément (point 14 du cahier des charges) :
//   - scope "formateur"  → exige sync_pillbox_complete
//   - scope "psychologue" → exige sync_pillbox_complete
//   - scope "all" (ADD+ uniquement) → exige sync_pillbox_complete
//
// Ne fait JAMAIS confiance à une copie complète envoyée par le
// navigateur — relit toujours le cloud actuel et ne fusionne QUE les
// personnes du scope demandé, exactement comme le fait déjà le Roster
// côté client (même logique, mais maintenant revérifiée ici).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can, canFor } = require("./permissions");
const { logAction } = require("./logs");

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const ACTIVITE_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/activiteSuivi.json";

const SCOPE_PERMISSION = {
  formateur: "sync_pillbox_complete",
  psychologue: "sync_pillbox_complete",
  all: "sync_pillbox_complete",
};
const SCOPE_GRADES = {
  formateur: ["MF", "RF"],
  psychologue: ["MP", "RP"],
  all: ["MF", "RF", "MP", "RP"],
};

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

function activiteKeyFor(e){ return e.idUnique ? `id:${e.idUnique}` : `name:${String(e.name || "").trim().toLowerCase()}`; }

const SPECIALTY_BY_GRADE = {
  MF: { scope: "formateur", fields: ["formations", "recrutements"] },
  RF: { scope: "formateur", fields: ["formations", "recrutements"] },
  MP: { scope: "psychologue", fields: ["consultations", "ppa", "testsPsy"] },
  RP: { scope: "psychologue", fields: ["consultations", "ppa", "testsPsy"] },
};

function normalizeActivityRecord(record, grade){
  const spec = SPECIALTY_BY_GRADE[String(grade || "").toUpperCase()];
  if (!spec || !record || typeof record !== "object") return null;
  const out = {};
  for (const field of spec.fields) {
    if (Object.prototype.hasOwnProperty.call(record, field)) out[field] = Math.max(0, Number(record[field]) || 0);
  }
  if (record.excused === true) out.excused = true;
  // Une fiche d'activité suivie doit rester matérialisée même si elle ne
  // contenait encore aucun compteur : initialise les compteurs de SA SP,
  // jamais ceux d'un ancien pôle.
  if (!Object.keys(out).length) spec.fields.forEach(field => { out[field] = 0; });
  return out;
}

// Nettoie les reliquats historiques avant CHAQUE écriture :
// - seuls les membres actifs dont le grade ACTUEL est MF/RF/MP/RP restent ;
// - une vieille clé name:<nom> est migrée vers id:<idUnique> si l'ID existe ;
// - si name: et id: existent en double, id: gagne et complète seulement les
//   champs manquants depuis l'ancienne clé ;
// - les champs d'une ancienne spécialité sont supprimés.
function sanitizeActivityCloud(data, streak, employees){
  const sourceData = (data && typeof data === "object") ? data : {};
  const sourceStreak = (streak && typeof streak === "object") ? streak : {};
  const cleanData = {};
  const cleanStreak = {};
  const active = (Array.isArray(employees) ? employees : []).filter(e => !e.licencie && SPECIALTY_BY_GRADE[String(e.grade || "").toUpperCase()]);

  for (const emp of active) {
    const canonical = activiteKeyFor(emp);
    const nameKey = `name:${String(emp.name || "").trim().toLowerCase()}`;
    const oldRec = sourceData[nameKey] && nameKey !== canonical ? sourceData[nameKey] : null;
    const canonicalRec = sourceData[canonical] || null;
    const mergedRec = oldRec || canonicalRec ? { ...(oldRec || {}), ...(canonicalRec || {}) } : null;
    if (mergedRec) cleanData[canonical] = normalizeActivityRecord(mergedRec, emp.grade);

    const st = sourceStreak[canonical] !== undefined ? sourceStreak[canonical] : sourceStreak[nameKey];
    if (st !== undefined && st !== null) cleanStreak[canonical] = st;
  }
  return { data: cleanData, streak: cleanStreak };
}

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, scope, activiteData, activiteStreak, closeWeek, action, targetKey } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  // Réinitialisation manuelle d'un suivi d'inactivité (10/09) — action
  // distincte du reste (pas un envoi de données, juste une remise à
  // zéro ciblée) — vérifiée avec sa propre permission, jamais juste un
  // bouton caché côté interface.
  if (action === "resetStreak") {
    if (!(await canFor(session, "reset_activite_streak"))) {
      return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
    }
    if (!targetKey || !["formateur", "psychologue"].includes(scope)) {
      return json(400, { error: "Paramètres manquants ou invalides." });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
      const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
      const rosterData = rosterRes.ok ? await rosterRes.json() : null;
      const employees = (rosterData && rosterData.employees) || [];
      const grades = SCOPE_GRADES[scope];
      const person = employees.find(e => !e.licencie && grades.includes((e.grade || "").toUpperCase()) && activiteKeyFor(e) === targetKey);
      if (!person) return json(400, { error: "Personne introuvable dans ce pôle actuel." });

      const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
      const cur = curRes.ok ? await curRes.json().catch(()=>null) : null;
      const sanitized = sanitizeActivityCloud((cur && cur.data) || {}, (cur && cur.streak) || {}, employees);
      const mergedStreak = { ...sanitized.streak };
      mergedStreak[targetKey] = { streak: 0, lastSignaledThreshold: 0 };
      const dataToSend = Object.keys(sanitized.data).length ? sanitized.data : null;
      const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: dataToSend, streak: mergedStreak, savedAt: Date.now() }),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de la réinitialisation (${saveRes.status}) : ${t.slice(0,200)}` }); }

      await logAction({
        action: "reinitialisation_manuelle_suivi",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        details: `Suivi ${scope} réinitialisé pour ${targetKey}`,
        idToken,
      }).catch(()=>{});

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  // "Actif mais n'a pas pu" (29/09) -- marqueur par personne, valable pour la
  // semaine en cours : la personne est active mais n'a pas eu de travail a
  // faire (tout est deja fait, ou un MC a pris la formation). A la cloture,
  // la serie repart a 0 au lieu de monter, et le marqueur s'efface. Action
  // distincte, verifiee cote serveur avec la meme permission que la remise a
  // zero manuelle (ADD et au-dessus), et TOUJOURS tracee dans les journaux
  // (qui l'a active/retire, pour qui, quand) -- jamais juste un bouton.
  if (action === "setExcused") {
    if (!(await canFor(session, "reset_activite_streak"))) {
      return json(403, { error: `Permission refusee (${session.level}) -- reserve a ADD et au-dessus.` });
    }
    const excused = body.excused === true;
    if (!targetKey || !["formateur", "psychologue"].includes(scope)) {
      return json(400, { error: "Parametres manquants ou invalides." });
    }
    try {
      const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

      // Verifie que la personne appartient bien au scope demande (jamais
      // une cle envoyee par le navigateur sans controle).
      const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
      const rosterData = rosterRes.ok ? await rosterRes.json() : null;
      const employees = (rosterData && rosterData.employees) || [];
      const grades = SCOPE_GRADES[scope];
      const person = employees.find(e => !e.licencie && grades.includes((e.grade || "").toUpperCase()) && activiteKeyFor(e) === targetKey);
      if (!person) return json(400, { error: "Personne introuvable dans ce pole." });

      const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
      const cur = curRes.ok ? await curRes.json().catch(() => null) : null;
      const sanitized = sanitizeActivityCloud((cur && cur.data) || {}, (cur && cur.streak) || {}, employees);
      const mergedData = { ...sanitized.data };
      const rec = { ...(mergedData[targetKey] || {}) };
      const before = rec.excused === true;
      if (excused) rec.excused = true; else delete rec.excused;
      // Firebase refuse un objet vide : on garde au moins un compteur a 0.
      if (!Object.keys(rec).length) rec.recrutements = 0;
      mergedData[targetKey] = rec;

      const dataToSend = Object.keys(mergedData).length ? mergedData : null;
      const streakToSend = Object.keys(sanitized.streak).length ? sanitized.streak : null;
      const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: dataToSend, streak: streakToSend, savedAt: Date.now() }),
      });
      if (!saveRes.ok) { const t = await saveRes.text().catch(() => ""); return json(502, { error: `Echec de l'enregistrement (${saveRes.status}) : ${t.slice(0, 200)}` }); }

      await logAction({
        action: excused ? "activite_actif_sans_travail_active" : "activite_actif_sans_travail_retire",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: person.discordId || null, targetName: person.name,
        oldValue: before ? "actif mais n'a pas pu" : "normal",
        newValue: excused ? "actif mais n'a pas pu" : "normal",
        details: `Suivi ${scope} -- ${person.name}`,
        idToken,
      }).catch(() => {});

      return json(200, { ok: true, excused });
    } catch (err) {
      return json(500, { error: `Erreur inattendue : ${err.message}` });
    }
  }

  const permissionNeeded = SCOPE_PERMISSION[scope];
  if (!permissionNeeded) return json(400, { error: `Portée invalide : "${scope}".` });
  if (!(await canFor(session, permissionNeeded))) {
    return json(403, { error: `Permission refusée (${session.level}) — "${scope}" nécessite ${permissionNeeded}.` });
  }
  if (!activiteData || typeof activiteData !== "object") {
    return json(400, { error: "Données d'activité manquantes ou invalides." });
  }

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    // Relit le Roster ACTUEL pour savoir qui appartient vraiment aux
    // grades du scope demandé — jamais une liste envoyée par le
    // navigateur (elle pourrait prétendre que n'importe qui est MF/RF).
    const rosterRes = await fetch(`${ROSTER_URL}?auth=${idToken}`);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    const employees = (rosterData && rosterData.employees) || [];
    const grades = SCOPE_GRADES[scope];
    const relevantKeys = new Set(
      employees.filter(e => !e.licencie && grades.includes((e.grade || "").toUpperCase())).map(activiteKeyFor)
    );

    // Relit le cloud actuel, puis le NETTOIE selon les spécialités
    // ACTUELLES du Roster avant toute fusion. Ainsi un ancien MF devenu MC,
    // ou un ancien MP devenu M, ne reste pas éternellement dans Pillbox.
    // Même chose pour les doubles clés name:/id: d'une seule personne.
    const curRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`);
    const cur = curRes.ok ? await curRes.json().catch(()=>null) : null;
    const sanitized = sanitizeActivityCloud((cur && cur.data) || {}, (cur && cur.streak) || {}, employees);
    const mergedData = { ...sanitized.data };
    const mergedStreak = { ...sanitized.streak };

    // Instantané AVANT écrasement (09/09) — sert uniquement si
    // closeWeek est demandé, pour garder une vraie trace consultable
    // et réouvrable plus tard (voir roster-week-history.js).
    const beforeSnapshot = {};
    if (closeWeek) {
      relevantKeys.forEach(key => {
        beforeSnapshot[key] = { data: mergedData[key] || null, streak: mergedStreak[key] || null };
      });
    }

    const employeeByKey = new Map(
      employees.filter(e => !e.licencie && SPECIALTY_BY_GRADE[String(e.grade || "").toUpperCase()]).map(e => [activiteKeyFor(e), e])
    );
    relevantKeys.forEach(key => {
      const person = employeeByKey.get(key);
      if (activiteData[key] !== undefined && person) mergedData[key] = normalizeActivityRecord(activiteData[key], person.grade);
      if (activiteStreak && activiteStreak[key] !== undefined) mergedStreak[key] = activiteStreak[key];
    });

    // "streak" peut légitimement finir vide (personne n'a encore de
    // série enregistrée) — dans ce cas, envoyer null plutôt qu'un objet
    // vide {}, car la règle Firebase exige l'un OU l'autre (jamais un
    // objet sans aucune clé). "data" reste toujours tel quel : la règle
    // du dessus exige qu'il existe, jamais null (09/09).
    const dataToSend = Object.keys(mergedData).length ? mergedData : null;
    const streakToSend = Object.keys(mergedStreak).length ? mergedStreak : null;
    const saveRes = await fetch(`${ACTIVITE_URL}?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataToSend, streak: streakToSend, savedAt: Date.now() }),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    let weekKey = null;
    if (closeWeek) {
      // Clé de semaine = date du jour de la clôture (aucune notion de
      // "début de semaine" n'existait avant côté Roster pour
      // Formateur/Psychologue — on prend simplement la date réelle de
      // clôture, ce qui reste un identifiant stable et unique par jour).
      const d = new Date();
      weekKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const historyEntry = {
        type: scope, closedAt: Date.now(),
        closedByDiscordId: session.discordId, closedByName: session.name, closedByLevel: session.level,
        before: beforeSnapshot,
        after: Object.fromEntries([...relevantKeys].map(k => [k, { data: mergedData[k]||null, streak: mergedStreak[k]||null }])),
        reopened: false,
      };
      const histUrl = `https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteWeekHistory/${weekKey}/${scope}.json?auth=${idToken}`;
      // Archive l'ancienne entrée du jour avant d'écraser (au cas où
      // la même journée serait re-clôturée plusieurs fois) — jamais de
      // perte, même dans ce cas rare.
      try{
        const existingRes = await fetch(histUrl);
        const existing = existingRes.ok ? await existingRes.json() : null;
        if(existing){
          const archiveUrl = `https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteWeekHistoryArchive/${weekKey}-${scope}/${Date.now()}.json?auth=${idToken}`;
          await fetch(archiveUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(existing) });
        }
      }catch(e){ /* non bloquant */ }
      await fetch(histUrl, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(historyEntry) }).catch(()=>{});
      // (11/10) Trace de la dernière clôture par pôle — lue par la
      // clôture automatique déclenchée depuis Pillbox (activite-close.js)
      // pour ne jamais re-clôturer un pôle déjà clôturé à la main la même
      // semaine, et par les Roster ouverts pour recharger tout de suite.
      const lastPatch = {};
      (scope === "all" ? ["formateur","psychologue"] : [scope]).forEach(sc => { if (sc==="formateur"||sc==="psychologue") lastPatch[sc] = Date.now(); });
      if (Object.keys(lastPatch).length) {
        await fetch(`https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterActiviteLastClosure.json?auth=${idToken}`, {
          method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify(lastPatch),
        }).catch(()=>{});
      }
    }

    await logAction({
      action: closeWeek ? "cloture_semaine_activite" : "envoi_pillbox",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: `Portée : ${scope} (${relevantKeys.size} personne(s))${weekKey ? ` — semaine ${weekKey}` : ""}`,
      idToken,
    }).catch(()=>{});

    return json(200, { ok: true, data: mergedData, streak: mergedStreak, weekKey });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

exports._test = { activiteKeyFor, normalizeActivityRecord, sanitizeActivityCloud, SPECIALTY_BY_GRADE };

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
