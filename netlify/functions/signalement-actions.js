// ═══════════════════════════════════════════════════════════════════
// signalement-actions.js — le vrai circuit MC → ADD+ demandé :
//   MC propose (jamais officiel tout seul)
//        ↓
//   ADD/CD/D/OWNER valide, refuse, ou demande des infos
//        ↓ (si validé)
//   Entrée officielle dans "signalements" (système déjà existant)
//
// Chemin dédié : signalementPropositions — séparé de "signalements"
// (les vrais signalements officiels), pour ne jamais mélanger une
// simple proposition non validée avec un signalement confirmé.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { can, canFor } = require("./permissions");
const { logAction } = require("./logs");
const crypto = require("crypto");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const PROPOSITIONS_URL = `${BASE}/signalementPropositions.json`;
const SIGNALEMENTS_URL = `${BASE}/signalements.json`;
const SIGNALEMENTS_TEST_URL = `${BASE}/signalements_test.json`;
const VALID_CATEGORIES = ["inactivite","quantite_travail","qualite_travail","comportement","disponibilite","autre"];


function stripPrivateSignalementFields(signalements, isOwner) {
  if (isOwner || !signalements || typeof signalements !== "object") return signalements || {};
  const clean = {};
  for (const [key, value] of Object.entries(signalements)) {
    if (!value || typeof value !== "object") { clean[key] = value; continue; }
    const { selectionMethod, selectedBy, ...publicValue } = value;
    clean[key] = publicValue;
  }
  return clean;
}

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

exports.handler = async function (event) {
  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const { token, action, payload } = body;

  const session = verify(token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." });

  try {
    const idToken = await getFirebaseIdToken(session.discordId, session.level, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY);
    const authedUrl = (url) => `${url}?auth=${idToken}`;
    const signalementsTargetUrl = (payload && payload.sandbox === true) ? SIGNALEMENTS_TEST_URL : SIGNALEMENTS_URL;

    if (action === "listSignalements") {
      if (!(await canFor(session, "propose_signalement", idToken))) return json(403,{error:"Permission de consultation des signalements refusée."});
      const r=await fetch(authedUrl(signalementsTargetUrl));
      if(!r.ok) return json(502,{error:`Lecture signalements impossible (${r.status}).`});
      const rawSignalements = (await r.json()) || {};
      // selectionMethod/selectedBy sont une trace technique OWNER uniquement :
      // jamais les laisser sortir dans la réponse réseau d’un MC/ADD/CD/D/DG.
      return json(200,{ok:true,signalements:stripPrivateSignalementFields(rawSignalements, session.level === "OWNER")});
    }

    if (action === "deleteSignalementOfficial") {
      if (!(await canFor(session, "validate_signalement", idToken))) return json(403,{error:"Permission de validation des signalements requise."});
      const key=String(payload?.key||"");
      if(!/^[A-Za-z0-9_-]{1,120}$/.test(key)) return json(400,{error:"Identifiant de signalement invalide."});
      const r=await fetch(authedUrl(signalementsTargetUrl.replace(".json",`/${key}.json`)),{method:"DELETE"});
      if(!r.ok) return json(502,{error:`Suppression impossible (${r.status}).`});
      await logAction({action:"suppression_signalement",authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`Signalement ${key}`,idToken}).catch(()=>{});
      return json(200,{ok:true});
    }

    if (action === "withdrawSignalementByCode") {
      // Le code aléatoire remis au déclarant reste la preuve de possession du
      // signalement, mais l'écriture Firebase n'est plus faite par le navigateur.
      if (!(await canFor(session, "propose_signalement", idToken))) return json(403,{error:"Permission de signalement requise."});
      const key=String(payload?.key||"").trim();
      if(!/^[A-Za-z0-9_-]{1,120}$/.test(key)) return json(400,{error:"Code de signalement invalide."});
      const url=authedUrl(signalementsTargetUrl.replace(".json",`/${key}.json`));
      const check=await fetch(url);
      const existing=check.ok ? await check.json() : null;
      if(!existing) return json(404,{error:"Ce code ne correspond à aucun signalement (déjà retiré ou code invalide)."});
      const r=await fetch(url,{method:"DELETE"});
      if(!r.ok) return json(502,{error:`Retrait impossible (${r.status}).`});
      await logAction({action:"retrait_signalement_par_code",authorDiscordId:session.discordId,authorName:session.name,authorLevel:session.level,details:`Signalement ${key}`,idToken}).catch(()=>{});
      return json(200,{ok:true});
    }

    if (action === "createAutoSignalement") {
      if (!(await canFor(session, "reset_activite_streak", idToken))) return json(403,{error:"Permission de clôture d'activité requise."});
      const { personName, personId, personGrade, category, reason } = payload || {};
      if(!personName || !reason) return json(400,{error:"Données du signalement automatique incomplètes."});
      const cats=String(category||"inactivite").split(",").filter(c=>VALID_CATEGORIES.includes(c));
      if(!cats.length) return json(400,{error:"Catégorie invalide."});
      const entry={personName:String(personName).slice(0,100),personId:personId||null,personGrade:personGrade||null,category:cats.join(","),reason:String(reason).slice(0,1999),createdAt:Date.now(),auto:true};
      const key=crypto.randomUUID();
      const r=await fetch(authedUrl(signalementsTargetUrl.replace(".json",`/${key}.json`)),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(entry)});
      if(!r.ok) return json(502,{error:`Création automatique impossible (${r.status}).`});
      return json(200,{ok:true,key});
    }

    if (action === "createSignalementOfficial") {
      if (!(await canFor(session, "create_signalement"))) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
      }
      const { personName, personId, personGrade, category, reason, activiteSnapshot } = payload || {};
      if (!personName || !reason || !reason.trim()) return json(400, { error: "Personne concernée et motif obligatoires." });
      const cats = String(category || "").split(",").filter(c => VALID_CATEGORIES.includes(c));
      if (!cats.length) return json(400, { error: "Catégorie invalide." });

      const entry = { personName, personId: personId || null, personGrade: personGrade || null, category: cats.join(","), reason: reason.trim(), createdAt: Date.now() };
      if (activiteSnapshot) entry.activiteSnapshot = activiteSnapshot;
      const sigKey = crypto.randomUUID();
      const res = await fetch(authedUrl(signalementsTargetUrl.replace(".json", `/${sigKey}.json`)), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
      });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec (${res.status}) : ${t.slice(0,200)}` }); }

      await logAction({
        action: "signalement_officiel", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: personId, targetName: personName, details: `Catégorie(s) : ${cats.join(", ")}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, key: sigKey });
    }

    if (action === "proposeSignalement") {
      if (!(await canFor(session, "propose_signalement"))) {
        return json(403, { error: `Permission refusée (${session.level}) — impossible de proposer un signalement.` });
      }
      const { personName, personId, personGrade, category, reason, activiteSnapshot } = payload || {};
      if (!personName || !reason || !reason.trim()) return json(400, { error: "Personne concernée et motif obligatoires." });
      const cats = String(category || "").split(",").filter(c => VALID_CATEGORIES.includes(c));
      if (!cats.length) return json(400, { error: "Catégorie invalide." });

      const entry = {
        personName, personId: personId || null, personGrade: personGrade || null,
        category: cats.join(","), reason: reason.trim(),
        authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        status: "pending", createdAt: Date.now(),
      };
      if (activiteSnapshot) entry.activiteSnapshot = activiteSnapshot;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const res = await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${key}.json`)), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
      });
      if (!res.ok) { const t = await res.text().catch(()=>""); return json(502, { error: `Échec (${res.status}) : ${t.slice(0,200)}` }); }

      await logAction({
        action: "proposition_signalement", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: personId, targetName: personName, details: `Catégorie(s) : ${cats.join(", ")}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, key });
    }

    if (["validateProposition","refuseProposition","requestMoreInfo"].includes(action)) {
      if (!(await canFor(session, "validate_signalement"))) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
      }
      const { propositionId, message } = payload || {};
      if (!propositionId) return json(400, { error: "Identifiant de proposition manquant." });

      const propRes = await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${propositionId}.json`)));
      const prop = propRes.ok ? await propRes.json() : null;
      if (!prop) return json(404, { error: "Proposition introuvable." });
      if (prop.status !== "pending") return json(409, { error: `Cette proposition a déjà été traitée (statut actuel : ${prop.status}).` });

      // Si la personne concernée est elle-même ADD, un ADD ne peut pas
      // traiter le signalement (jamais juger son propre cas) — il faut
      // CD ou au-dessus (10/09, demandé après ajout d'ADD à la liste
      // des grades concernés par les signalements).
      if ((prop.personGrade || "").toUpperCase() === "ADD" && !["CD","D","DG","OWNER"].includes(session.level)) {
        return json(403, { error: `Permission refusée — un signalement concernant un ADD doit être traité par CD ou au-dessus (jamais par un ADD lui-même).` });
      }

      if (action === "validateProposition") {
        const officialEntry = {
          personName: prop.personName, personId: prop.personId, personGrade: prop.personGrade,
          category: prop.category, reason: prop.reason, createdAt: Date.now(),
        };
        if (prop.activiteSnapshot) officialEntry.activiteSnapshot = prop.activiteSnapshot;
        const sigKey = crypto.randomUUID();
        const sigRes = await fetch(authedUrl(SIGNALEMENTS_URL.replace(".json", `/${sigKey}.json`)), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(officialEntry),
        });
        if (!sigRes.ok) { const t = await sigRes.text().catch(()=>""); return json(502, { error: `Échec création signalement officiel (${sigRes.status}) : ${t.slice(0,200)}` }); }

        await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${propositionId}.json`)), {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "accepted", validatedByDiscordId: session.discordId, validatedByName: session.name, validatedAt: Date.now() }),
        });
        await logAction({
          action: "validation_proposition", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId: prop.personId, targetName: prop.personName, details: `Proposée par ${prop.authorName} (${prop.authorLevel})`,
          idToken,
        }).catch(()=>{});
        return json(200, { ok: true, signalementKey: sigKey });
      }

      if (action === "refuseProposition") {
        await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${propositionId}.json`)), {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "refused", refusedByDiscordId: session.discordId, refusedByName: session.name, refusedAt: Date.now(), refusalMessage: message || null }),
        });
        await logAction({
          action: "refus_proposition", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId: prop.personId, targetName: prop.personName,
          idToken,
        }).catch(()=>{});
        return json(200, { ok: true });
      }

      if (action === "requestMoreInfo") {
        await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${propositionId}.json`)), {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "needs_info", infoRequestedByDiscordId: session.discordId, infoRequestedByName: session.name, infoRequestedAt: Date.now(), infoMessage: message || null }),
        });
        await logAction({
          action: "demande_infos_proposition", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
          targetDiscordId: prop.personId, targetName: prop.personName, details: message || null,
          idToken,
        }).catch(()=>{});
        return json(200, { ok: true });
      }
    }

    return json(400, { error: `Action inconnue : "${action}".` });
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` });
  }
};

exports._test = { stripPrivateSignalementFields };

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
