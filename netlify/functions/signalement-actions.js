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
const { can } = require("./permissions");
const { logAction } = require("./logs");
const crypto = require("crypto");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const PROPOSITIONS_URL = `${BASE}/signalementPropositions.json`;
const SIGNALEMENTS_URL = `${BASE}/signalements.json`;
const VALID_CATEGORIES = ["inactivite","quantite_travail","qualite_travail","comportement","disponibilite","autre"];

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

    if (action === "createSignalementOfficial") {
      if (!can(session.level, "create_signalement")) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
      }
      const { personName, personId, personGrade, category, reason, activiteSnapshot } = payload || {};
      if (!personName || !reason || !reason.trim()) return json(400, { error: "Personne concernée et motif obligatoires." });
      const cats = String(category || "").split(",").filter(c => VALID_CATEGORIES.includes(c));
      if (!cats.length) return json(400, { error: "Catégorie invalide." });

      const entry = { personName, personId: personId || null, personGrade: personGrade || null, category: cats.join(","), reason: reason.trim(), createdAt: Date.now() };
      if (activiteSnapshot) entry.activiteSnapshot = activiteSnapshot;
      const sigKey = crypto.randomUUID();
      console.log("DEBUG createSignalementOfficial — entry envoyée:", JSON.stringify(entry));
      console.log("DEBUG createSignalementOfficial — session.level:", session.level, "discordId:", session.discordId);
      const res = await fetch(authedUrl(SIGNALEMENTS_URL.replace(".json", `/${sigKey}.json`)), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
      });
      if (!res.ok) {
        const t = await res.text().catch(()=>"");
        console.log("DEBUG createSignalementOfficial — échec Firebase, statut:", res.status, "corps:", t);
        return json(502, { error: `Échec (${res.status}) : ${t.slice(0,200)}` });
      }

      await logAction({
        action: "signalement_officiel", authorDiscordId: session.discordId, authorName: session.name, authorLevel: session.level,
        targetDiscordId: personId, targetName: personName, details: `Catégorie(s) : ${cats.join(", ")}`,
        idToken,
      }).catch(()=>{});
      return json(200, { ok: true, key: sigKey });
    }

    if (action === "proposeSignalement") {
      if (!can(session.level, "propose_signalement")) {
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
      if (!can(session.level, "validate_signalement")) {
        return json(403, { error: `Permission refusée (${session.level}) — réservé à ADD et au-dessus.` });
      }
      const { propositionId, message } = payload || {};
      if (!propositionId) return json(400, { error: "Identifiant de proposition manquant." });

      const propRes = await fetch(authedUrl(PROPOSITIONS_URL.replace(".json", `/${propositionId}.json`)));
      const prop = propRes.ok ? await propRes.json() : null;
      if (!prop) return json(404, { error: "Proposition introuvable." });
      if (prop.status !== "pending") return json(409, { error: `Cette proposition a déjà été traitée (statut actuel : ${prop.status}).` });

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

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
