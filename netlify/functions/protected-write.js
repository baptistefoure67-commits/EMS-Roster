// ═══════════════════════════════════════════════════════════════════
// protected-write.js — passage obligé pour les actions sensibles sur le
// Roster (modifier un employé, licencier). Vérifie le NIVEAU réel
// (MC/ADD/CD/D/OWNER, jamais un grade envoyé par le navigateur) via le
// module centralisé permissions.js, et journalise chaque action.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can, LEVELS, canFor } = require("./permissions");
const { logAction } = require("./logs");

// (11/10 — audit de sécurité) Deux vrais problèmes trouvés dans cette
// fonction, corrigés ici :
//  1. editEmployee laissait n'importe quel ADD/CD donner N'IMPORTE
//     QUEL grade (DG inclus) à n'importe qui, sans ancienneté, ni
//     quota, ni spécialité — maintenant réservé D+ pour changer le
//     grade ; ADD/CD gardent la main sur nom/ID Discord/rôle.
//  2. licencier laissait le même licencier un grade supérieur au sien
//     — maintenant interdit pour ADD/CD si la cible a un grade
//     administratif (MC/ADD/CD/D/DG) égal ou supérieur au leur ; D+
//     garde l'accès complet, comme avant pour les deux.
function rankOf(level){ return LEVELS.indexOf(level); } // -1 si pas un grade administratif
function isDPlus(level){ return ["D","DG","OWNER"].includes(level); }

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const ROSTER_URL = `${BASE}/rosterEmsData.json`;
const DISCORD_IDS_URL = `${BASE}/discordIdsList.json`;
const FORMATION_OPERATION_URL = `${BASE}/formationOperationList.json`;
const SPECIAL_SELECTION_URL = `${BASE}/rosterEmsSpecialSelection.json`;
const SYNC_META_URL = `${BASE}/rosterPillboxSyncMeta.json`;

async function getFirebaseIdToken(discordId, level, clientEmail, privateKey, webApiKey){
  const customToken = createFirebaseCustomToken({ clientEmail, privateKey, uid: discordId, claims: { level, server: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${res.status}`);
  return data.idToken;
}

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur (variables Firebase/SESSION_SECRET)." });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Requête invalide (JSON attendu)." });
  }

  const { token, action, payload } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) {
    return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });
  }

  try {
    const idToken = await getFirebaseIdToken(
      session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY
    );
    const authed = (url) => `${url}${url.includes("?")?"&":"?"}auth=${idToken}`;
    const canManageRoster = await canFor(session, "manage_roster", idToken);
    const canSyncPillbox = await canFor(session, "sync_pillbox_complete", idToken);

    // ── Sauvegarde complète du Roster : passage serveur + CAS Firebase.
    if (action === "replaceRosterSnapshot") {
      if (!canManageRoster) return json(403, { error: `Permission refusée (${session.level}) — « Gérer les employés » requise.` });
      const incoming = Array.isArray(payload?.employees) ? payload.employees : null;
      if (!incoming) return json(400, { error: "Liste d'employés invalide." });
      const expectedSavedAt = payload?.expectedSavedAt ?? null;
      const currentRes = await fetch(authed(ROSTER_URL), { headers: { "X-Firebase-ETag": "true" } });
      if (!currentRes.ok) return json(502, { error: `Impossible de relire le Roster (${currentRes.status}).` });
      const etag = currentRes.headers.get("etag");
      const current = await currentRes.json();
      const currentSavedAt = current?.savedAt ?? null;
      if (currentSavedAt !== expectedSavedAt) return json(409, { error: "Le Roster a été modifié par une autre session. Relance Sauvegarder pour revoir les changements." });
      const validation = validateEmployees(incoming);
      if (validation.length) return json(422, { error: `Impossible d'enregistrer : ${validation.length} fiche(s) invalide(s) — ${validation.slice(0,5).join(" ; ")}` });
      const savedAt = Date.now();
      const headers = { "Content-Type":"application/json" };
      if (etag) headers["if-match"] = etag;
      const saveRes = await fetch(authed(ROSTER_URL), { method:"PUT", headers, body:JSON.stringify({employees:incoming,savedAt}) });
      if (saveRes.status === 412) return json(409, { error: "Conflit : une autre sauvegarde a gagné la course. Relance Sauvegarder." });
      if (!saveRes.ok) { const tx=await saveRes.text().catch(()=>""); return json(502,{error:`Échec de l'écriture (${saveRes.status}) : ${tx.slice(0,160)}`}); }
      await logAction({action:"sauvegarde_roster_confirmee",authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`${incoming.length} fiche(s)`,idToken}).catch(()=>{});
      return json(200,{ok:true,employees:incoming,savedAt});
    }

    // ── Sélection Formation Opération sauvegardée dans le cloud.
    if (action === "saveSpecialSelection") {
      if (!canSyncPillbox) return json(403,{error:"Permission « Synchronisation complète avec Pillbox » requise."});
      const selectedEmployees = Array.isArray(payload?.selectedEmployees) ? payload.selectedEmployees.slice(0,1000) : null;
      if (!selectedEmployees) return json(400,{error:"Sélection invalide."});
      const savedAt=Date.now();
      const r=await fetch(authed(SPECIAL_SELECTION_URL),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({selectedEmployees,savedAt})});
      if(!r.ok){const tx=await r.text().catch(()=>"");return json(502,{error:`Échec sélection (${r.status}) : ${tx.slice(0,120)}`});}
      return json(200,{ok:true,count:selectedEmployees.length,savedAt});
    }

    // ── Envoi Roster/IDs + métadonnée de réception vers Pillbox.
    if (action === "syncPillboxRoster") {
      if (!canSyncPillbox) return json(403,{error:"Permission « Synchronisation complète avec Pillbox » requise."});
      const text=String(payload?.text||"");
      const employeeCount=Number(payload?.employeeCount);
      if(text.length>50000 || !Number.isFinite(employeeCount) || employeeCount<0 || employeeCount>1000) return json(400,{error:"Données de synchronisation invalides."});
      const now=Date.now();
      const previousRes=await fetch(authed(SYNC_META_URL));
      const previous=previousRes.ok ? await previousRes.json() : null;
      const previousEmployeeCount=Number.isFinite(Number(previous?.employeeCount)) ? Number(previous.employeeCount) : null;
      const dropPercent=previousEmployeeCount>0 && employeeCount<previousEmployeeCount ? Math.round(((previousEmployeeCount-employeeCount)/previousEmployeeCount)*1000)/10 : 0;
      const idsRes=await fetch(authed(DISCORD_IDS_URL),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,savedAt:now})});
      if(!idsRes.ok){const tx=await idsRes.text().catch(()=>"");return json(502,{error:`Échec envoi Roster (${idsRes.status}) : ${tx.slice(0,120)}`});}
      const syncMeta={lastSyncAt:now,employeeCount,previousEmployeeCount,previousSyncAt:previous?.lastSyncAt||null,dropPercent,syncedByDiscordId:String(session.discordId||""),syncedByName:session.name||""};
      const metaRes=await fetch(authed(SYNC_META_URL),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(syncMeta)});
      if(!metaRes.ok) return json(502,{error:`Roster envoyé, mais métadonnées de synchro refusées (${metaRes.status}).`});
      return json(200,{ok:true,syncMeta});
    }

    if (action === "syncFormationOperation") {
      if (!canSyncPillbox) return json(403,{error:"Permission « Synchronisation complète avec Pillbox » requise."});
      const text=String(payload?.text||"");
      if(text.length>50000) return json(400,{error:"Liste Formation Opération trop longue."});
      const savedAt=Date.now();
      const r=await fetch(authed(FORMATION_OPERATION_URL),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,savedAt})});
      if(!r.ok){const tx=await r.text().catch(()=>"");return json(502,{error:`Échec Formation Opération (${r.status}) : ${tx.slice(0,120)}`});}
      return json(200,{ok:true,savedAt});
    }

    if (!canManageRoster) return json(403, { error: `Permission refusée (${session.level}) — « Gérer les employés » requise.` });
    const authedRosterUrl = authed(ROSTER_URL);
    const rosterRes = await fetch(authedRosterUrl, { headers: { "X-Firebase-ETag":"true" } });
    const rosterEtag = rosterRes.headers.get("etag");
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    let employees = (rosterData && rosterData.employees) || [];
    let pendingLog = null;

    if (action === "editEmployee") {
      const { id, name, discordId, grade, role, aliases } = payload || {};
      const idx = employees.findIndex((e) => String(e.id) === String(id));
      if (idx === -1) return json(404, { error: "Employé introuvable." });
      const before = { ...employees[idx] };
      // (11/10 — audit) Changement de grade réservé D+ — un vrai
      // changement de grade passe par le système de promotion (Pillbox)
      // ou par un D+, jamais par cette fiche générique pour ADD/CD.
      if (grade && grade !== before.grade && !isDPlus(session.level)) {
        return json(403, { error: `Permission refusée (${session.level}) — le changement de grade est réservé à D et au-dessus. Corrige le nom ou l'ID Discord si besoin, ou passe par le système de promotion pour le grade.` });
      }
      // (19/10, demandé) Anciens noms (mariage, wipe, bug de jeu...) —
      // tableau de chaînes, chacune non vide et raisonnablement courte ;
      // filtré plutôt que rejeté en bloc pour ne jamais bloquer tout le
      // reste de la modification à cause d'une seule entrée mal formée.
      const cleanAliases = Array.isArray(aliases)
        ? aliases.map(a => String(a||"").trim()).filter(a => a && a.length < 100).slice(0, 10)
        : employees[idx].aliases;
      employees[idx] = {
        ...employees[idx],
        name: name || employees[idx].name,
        discordId: discordId || employees[idx].discordId,
        grade: grade || employees[idx].grade,
        role: role !== undefined ? role : employees[idx].role,
        aliases: (cleanAliases && cleanAliases.length) ? cleanAliases : undefined,
      };
      if (employees[idx].aliases === undefined) delete employees[idx].aliases;
      pendingLog = {
        action: "modification_employe",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: employees[idx].discordId, targetName: employees[idx].name,
        oldValue: `${before.grade} / ${before.name} / ${before.discordId}`,
        newValue: `${employees[idx].grade} / ${employees[idx].name} / ${employees[idx].discordId}`,
        idToken,
      };
    } else if (action === "licencier") {
      const { id } = payload || {};
      const target = employees.find((e) => String(e.id) === String(id));
      if (!target) return json(404, { error: "Employé introuvable." });
      // (11/10 — audit) Un ADD/CD ne peut pas licencier quelqu'un d'un
      // grade administratif égal ou supérieur au sien (MC/ADD/CD/D/DG) —
      // D+ garde l'accès complet, comme avant.
      if (!isDPlus(session.level) && rankOf(target.grade) !== -1 && rankOf(target.grade) >= rankOf(session.level)) {
        return json(403, { error: `Permission refusée (${session.level}) — tu ne peux pas licencier quelqu'un d'un grade égal ou supérieur au tien.` });
      }
      employees = employees.filter((e) => String(e.id) !== String(id));
      pendingLog = {
        action: "licenciement",
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: target?.discordId, targetName: target?.name,
        details: `Grade au moment du licenciement : ${target?.grade}`,
        idToken,
      };
    } else {
      return json(400, { error: `Action inconnue : "${action}".` });
    }

    // (16/10) Diagnostic avant écriture : Firebase valide TOUT le tableau
    // employees à chaque sauvegarde, pas seulement la personne qu'on
    // modifie — une seule fiche avec un champ manquant/vide ailleurs
    // dans le roster (ex: ID Discord resté vide depuis un ancien import)
    // suffit à faire échouer N'IMPORTE QUELLE modification, même sans
    // rapport avec elle. Firebase ne dit jamais QUI a posé problème
    // ("permission denied" générique) — on le vérifie donc nous-mêmes
    // AVANT d'écrire, pour donner une erreur exploitable plutôt qu'un
    // simple 502 impossible à diagnostiquer à distance.
    const badEmployees = validateEmployees(employees);
    if (badEmployees.length) {
      return json(422, {
        error: `Impossible d'enregistrer : ${badEmployees.length} fiche(s) du roster ont un champ invalide qui bloque TOUTE sauvegarde (pas seulement celle-ci) — corrige-les d'abord : ${badEmployees.slice(0, 5).join(" ; ")}${badEmployees.length > 5 ? ` ; (+${badEmployees.length - 5} autre(s))` : ""}`,
      });
    }

    const savedAt = Date.now();
    const saveHeaders = { "Content-Type": "application/json" };
    if (rosterEtag) saveHeaders["if-match"] = rosterEtag;
    const saveRes = await fetch(authedRosterUrl, {
      method: "PUT",
      headers: saveHeaders,
      body: JSON.stringify({ employees, savedAt }),
    });
    if (saveRes.status === 412) {
      return json(409, { error: "Conflit : le Roster a changé pendant l'opération. Recharge puis recommence — aucune donnée n'a été écrasée." });
    }
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(() => "");
      return json(502, { error: `Échec de l'écriture sur Firebase (${saveRes.status}) : ${t.slice(0, 200)}` });
    }
    if (pendingLog) await logAction(pendingLog).catch(()=>{});

    return json(200, { ok: true, employees, savedAt });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

function validateEmployees(employees){
  const GRADE_RE = /^(DG|D|CD|ADD|MC|RL|RF|RP|MLP|MP|MF|M|INF|A|WDV|STG)$/;
  const bad=[];
  (employees||[]).forEach((e,i)=>{
    const problems=[];
    if(typeof e?.name!=="string" || !e.name.trim() || e.name.length>=100 || /[<>]/.test(e.name)) problems.push("nom invalide ou vide");
    if(typeof e?.discordId!=="string" || !e.discordId.trim() || e.discordId.length>=30) problems.push("ID Discord vide ou invalide");
    if(typeof e?.grade!=="string" || !GRADE_RE.test(e.grade)) problems.push(`grade invalide ("${e?.grade}")`);
    if(problems.length) bad.push(`${e?.name || `(sans nom, position ${i})`} : ${problems.join(", ")}`);
  });
  // (24/10, audit) Deux fiches ACTIVES ne peuvent plus partager le même ID
  // Discord. Avant : seulement un avertissement contournable côté
  // interface ; discord-callback.js prend le premier dossier actif
  // trouvé avec cet ID, donc un doublon pouvait donner le mauvais niveau
  // de session selon l'ordre du tableau. Les licenciés sont exclus de ce
  // contrôle : un ancien dossier licencié peut légitimement garder le
  // même ID qu'une personne revenue avec une nouvelle fiche active.
  const activeIdCounts = {};
  (employees||[]).forEach(e=>{
    if(e && !e.licencie && typeof e.discordId==="string" && e.discordId.trim()){
      const id = e.discordId.trim();
      activeIdCounts[id] = (activeIdCounts[id]||0)+1;
    }
  });
  Object.entries(activeIdCounts).filter(([,n])=>n>1).forEach(([id,n])=>{
    const names = (employees||[]).filter(e=>e && !e.licencie && String(e.discordId||"").trim()===id).map(e=>e.name).join(" / ");
    bad.push(`ID Discord "${id}" partagé par ${n} fiches ACTIVES à la fois (${names}) — un seul dossier actif par ID Discord.`);
  });
  return bad;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
