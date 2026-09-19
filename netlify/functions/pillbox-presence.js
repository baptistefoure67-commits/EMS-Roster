// ═══════════════════════════════════════════════════════════════════
// pillbox-presence.js — sait qui est actuellement sur Pillbox, à partir
// d'une seule personne déjà (demandé le 19/09). Chaque personne connectée
// envoie un petit signal ("heartbeat") toutes les ~25 secondes tant que
// Pillbox reste ouvert ; ce signal expire tout seul après ~90 secondes
// sans nouveau signal (onglet fermé, PC éteint...), sans action manuelle
// nécessaire pour "se déconnecter" de la présence.
//
// action "heartbeat" : enregistre/rafraîchit la présence de la personne
// (identité VÉRIFIÉE via le jeton de session, jamais texte libre).
// action "list" : renvoie qui est actuellement actif (signal de moins
// de 90 secondes), en excluant les entrées trop vieilles.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");

const ACTIVE_WINDOW_MS = 90 * 1000; // au-delà, on considère la personne partie

exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  if (!SESSION_SECRET) return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const session = verify(body.token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." }, corsHeaders);

  let idToken;
  try {
    const firebaseToken = createFirebaseCustomToken({
      clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY,
      uid: `pillbox-presence:${session.discordId}`, claims: { level: session.level },
    });
    const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: firebaseToken, returnSecureToken: true }),
    });
    const exchData = await exch.json();
    if (!exch.ok) return json(502, { error: "Échec d'authentification Firebase." }, corsHeaders);
    idToken = exchData.idToken;
  } catch (e) {
    return json(502, { error: `Échec d'authentification Firebase : ${e.message}` }, corsHeaders);
  }

  const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
  const PRESENCE_URL = `${BASE}/pillboxPresence`;

  if (body.action === "heartbeat") {
    const res = await fetch(`${PRESENCE_URL}/${session.discordId}.json?auth=${idToken}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: session.name, level: session.level, lastSeen: Date.now() }),
    });
    if (!res.ok) return json(502, { error: "Échec de l'enregistrement de présence." }, corsHeaders);
    return json(200, { ok: true }, corsHeaders);
  }

  if (body.action === "list") {
    const res = await fetch(`${PRESENCE_URL}.json?auth=${idToken}`);
    if (!res.ok) return json(502, { error: "Échec de la lecture de présence." }, corsHeaders);
    const data = (await res.json()) || {};
    const now = Date.now();
    const active = Object.values(data)
      .filter(v => v && typeof v.lastSeen === "number" && now - v.lastSeen < ACTIVE_WINDOW_MS)
      .map(v => ({ name: v.name, level: v.level }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json(200, { active }, corsHeaders);
  }

  return json(400, { error: "Action inconnue." }, corsHeaders);
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(obj) };
}
