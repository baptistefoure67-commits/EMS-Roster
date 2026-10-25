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
const { can, loadPermissionContext } = require("./permissions");
const { logAction } = require("./logs");
const { cloneDefaultPayRules } = require("./pay-rules-defaults");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const CONFIG_URL = `${BASE}/payRulesConfig.json`;
const HISTORY_URL = `${BASE}/payRulesConfigHistory.json`;
const INDIVIDUAL_URL = `${BASE}/rosterIndividualPermissions.json`;

// Valeurs par défaut partagées avec Pillbox — source unique.
const DEFAULT_CONFIG = cloneDefaultPayRules();

const VALID_GRADES = ["STG","A","INF","M","MF","MP","MLP","RF","RP","RL","MC","ADD","CD","D","DG"];

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
  const { token, field, value, action } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    // (24/10, audit) Mode strict : avant, une panne de lecture des
    // permissions fines retombait silencieusement sur la permission de
    // grade, pouvant laisser passer quelqu'un à qui ce droit a été retiré
    // individuellement.
    let ctx;
    try{ ctx = await loadPermissionContext(idToken, {strict:true}); }
    catch(e){ return json(502, { error: "Permissions illisibles — modification refusée." }); }
    if (!can(session.level, "manage_pay_rules", ctx.custom, session.discordId, ctx.individual)) {
      return json(403, { error: `Permission refusée (${session.level}) — il faut la permission "Réglages des paies" (grade ou exception individuelle).` });
    }
    // Les règles Firebase exigent un niveau D+ pour écrire payRulesConfig : la
    // permission étant vérifiée ci-dessus, on écrit avec un jeton de niveau D.
    const writeToken = await getFirebaseIdToken(session.discordId, "D", FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);

    // (24/10, audit) Fail-closed : avant, une lecture en échec devenait
    // DEFAULT_CONFIG, et le PUT complet plus bas écrivait ensuite CE
    // DÉFAUT (avec juste le champ modifié) à la place de la vraie config —
    // écrasant silencieusement tous les salaires/quotas/bonus déjà
    // personnalisés pour un simple changement d'un seul champ. Maintenant,
    // si la lecture échoue, on refuse la modification plutôt que de
    // risquer d'écraser la config réelle par les valeurs par défaut.
    const curRes = await fetch(CONFIG_URL);
    if (!curRes.ok) return json(502, { error: `Configuration de paie illisible (${curRes.status}) — modification refusée pour ne pas écraser les réglages existants par les valeurs par défaut.` });
    const stored = await curRes.json().catch(()=>null);
    const current = stored ? { ...DEFAULT_CONFIG, ...stored } : { ...DEFAULT_CONFIG };

    // (24/10, bloc 2) Validation d'UN champ, factorisée pour servir aussi
    // bien à "set" (un seul champ) qu'à "setBatch" (plusieurs champs dans
    // la même sauvegarde, un seul log groupé — cahier des charges, point
    // 15). Jamais un objet libre accepté tel quel : chaque champ garde sa
    // propre règle de forme, pour ne jamais pouvoir écrire une config qui
    // ferait planter Pillbox au calcul suivant.
    function applyField(fieldName, fieldValue){
      if (fieldName === "reaRate" || fieldName === "ppaWeeklyCap") {
        if (typeof fieldValue !== "number" || !(fieldValue >= 0) || fieldValue > 100000000) return "Montant invalide.";
        current[fieldName] = fieldValue;
      } else if (fieldName === "bonusByRank") {
        if (typeof fieldValue !== "object" || fieldValue === null) return "Format invalide pour les bonus.";
        const cleaned = {};
        for (const rank of ["1","2","3"]) {
          const v = fieldValue[rank];
          if (typeof v !== "number" || !(v >= 0) || v > 100000000) return `Bonus du rang ${rank} invalide.`;
          cleaned[rank] = v;
        }
        current.bonusByRank = cleaned;
      } else if (fieldName === "fixedSalaryByGrade") {
        if (typeof fieldValue !== "object" || fieldValue === null) return "Format invalide pour les salaires fixes.";
        const cleaned = {};
        for (const g of VALID_GRADES) {
          const v = fieldValue[g];
          if (typeof v !== "number" || !(v >= 0) || v > 100000000) return `Salaire fixe invalide pour ${g}.`;
          cleaned[g] = v;
        }
        current.fixedSalaryByGrade = cleaned;
      } else if (fieldName === "ppaEligibleGrades") {
        if (!Array.isArray(fieldValue) || !fieldValue.every(g => VALID_GRADES.includes(g))) return "Liste de grades PPA invalide.";
        current.ppaEligibleGrades = [...new Set(fieldValue)];
      } else if (fieldName === "qaCumulThreshold") {
        if (typeof fieldValue !== "number" || !(fieldValue >= 1) || fieldValue > 3) return "Le cumul Q+A ne peut pas dépasser 3.";
        current[fieldName] = fieldValue;
      } else if (fieldName === "stgProposalThreshold" || fieldName === "stgAutoThreshold" || fieldName === "aProposalThreshold" || fieldName === "infProposalThreshold") {
        if (typeof fieldValue !== "number" || !(fieldValue >= 1) || fieldValue > 3) return "Le seuil ne peut pas dépasser 3.";
        current[fieldName] = fieldValue;
      } else if (fieldName === "infProposalEnabled") {
        if (typeof fieldValue !== "boolean") return "Valeur invalide (true/false attendu).";
        current[fieldName] = fieldValue;
      } else if (fieldName === "extraQProposalGrades") {
        const allowed = VALID_GRADES.filter(g => !["STG","A","INF","MC","ADD","CD","D","DG"].includes(g));
        if (!Array.isArray(fieldValue) || !fieldValue.every(g => allowed.includes(g))) return "Liste de grades invalide pour la proposition Q généralisée.";
        current[fieldName] = [...new Set(fieldValue)];
      } else if (fieldName === "extraQProposalThreshold") {
        if (typeof fieldValue !== "number" || !(fieldValue >= 1) || fieldValue > 3) return "Le seuil ne peut pas dépasser 3.";
        current[fieldName] = fieldValue;
      } else if (fieldName === "quotaStandard" || fieldName === "quotaStaff" || fieldName === "nearMissThreshold") {
        if (typeof fieldValue !== "number" || !(fieldValue >= 0) || fieldValue > 1000) return "Valeur de quota invalide.";
        current[fieldName] = fieldValue;
      } else if (fieldName === "exemptGrades" || fieldName === "nearMissGrades") {
        if (!Array.isArray(fieldValue) || !fieldValue.every(g => VALID_GRADES.includes(g))) return "Liste de grades invalide.";
        current[fieldName] = [...new Set(fieldValue)];
      } else if (fieldName === "recruitmentPrice" || fieldName === "formationPrice") {
        // (24/10, bloc 4 à venir) tarifs centralisés recrutement/formation —
        // la validation existe déjà ici pour que ce soit prêt, même si rien
        // ne les utilise encore ailleurs tant que le bloc 4 n'est pas fait.
        if (typeof fieldValue !== "number" || !(fieldValue >= 0) || fieldValue > 100000000) return "Montant invalide.";
        current[fieldName] = fieldValue;
      } else {
        return `Champ inconnu : "${fieldName}".`;
      }
      return null; // pas d'erreur
    }

    const isBatchSave = action === "setBatch";
    const fieldsToApply = isBatchSave ? (body.fields && typeof body.fields === "object" ? body.fields : null) : { [field]: value };
    if (isBatchSave && (!fieldsToApply || !Object.keys(fieldsToApply).length)) return json(400, { error: "Aucun champ à modifier." });
    if (!isBatchSave && !field) return json(400, { error: "Champ à modifier manquant." });

    const before = {};
    Object.keys(fieldsToApply).forEach(f => { before[f] = current[f]; });
    for (const [f, v] of Object.entries(fieldsToApply)) {
      const err = applyField(f, v);
      if (err) return json(400, { error: isBatchSave ? `Champ "${f}" : ${err}` : err });
    }

    current.updatedAt = Date.now();
    current.updatedBy = session.name;

    const saveRes = await fetch(`${CONFIG_URL}?auth=${writeToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
    });
    if (!saveRes.ok) { const t = await saveRes.text().catch(()=>""); return json(502, { error: `Échec de l'écriture (${saveRes.status}) : ${t.slice(0,200)}` }); }

    // Historique complet — jamais un simple écrasement, chaque champ
    // modifié garde sa propre trace consultable (point 17.4 de l'audit),
    // même lors d'une sauvegarde groupée.
    for (const f of Object.keys(fieldsToApply)) {
      const histKey = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      await fetch(`${HISTORY_URL.replace(".json", `/${histKey}.json`)}?auth=${writeToken}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field: f, oldValue: before[f] === undefined ? null : before[f], newValue: current[f],
          authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          createdAt: Date.now(),
        }),
      }).catch(()=>{});
    }

    // (24/10, bloc 2, point 15) UN SEUL log, qu'il s'agisse d'un champ ou de
    // plusieurs dans la même sauvegarde — jamais un log par champ modifié.
    const fieldNames = Object.keys(fieldsToApply);
    await logAction({
      action: fieldNames.length > 1 ? "regles_paie_modifiees_groupe" : "regle_paie_modifiee",
      authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
      details: fieldNames.length > 1 ? `${fieldNames.length} paramètre(s) modifié(s) :\n${fieldNames.map(f=>`"${f}"`).join(", ")}` : `Champ "${fieldNames[0]}"`,
      oldValue: JSON.stringify(before), newValue: JSON.stringify(Object.fromEntries(fieldNames.map(f=>[f, current[f]]))),
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
