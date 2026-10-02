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

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const DISCORD_IDS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/discordIdsList.json";

exports.handler = async function (event) {
  // CORS : Pillbox est sur un autre domaine Netlify — sans ces en-têtes,
  // le navigateur bloquerait la réponse avant même que le code de
  // Pillbox ne la voie. Ouvert à tous les domaines volontairement (ce
  // n'est qu'un relais de lecture protégé par secret, pas une action
  // sensible) — le secret est la vraie protection, pas l'origine.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Secret",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

    const [rosterRes, discordIdsRes] = await Promise.all([
      fetch(`${ROSTER_URL}?auth=${idToken}`),
      fetch(`${DISCORD_IDS_URL}?auth=${idToken}`),
    ]);
    const roster = rosterRes.ok ? await rosterRes.json() : null;
    const discordIds = discordIdsRes.ok ? await discordIdsRes.json() : null;

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

    return json(200, { roster, discordIds: { text: mergedText, source: "roster+manuel", rosterCount: rosterLines.length } }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
