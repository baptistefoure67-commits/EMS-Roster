// ═══════════════════════════════════════════════════════════════════
// refresh-firebase-token.js (10/10, demandé) — permet de retrouver un
// jeton Firebase valide à partir d'une session déjà existante, SANS
// repasser par l'écran de connexion Discord. Corrige le vrai problème
// signalé : currentSessionToken n'était jamais sauvegardé (juste en
// mémoire), donc un simple F5 le perdait entièrement et forçait une
// reconnexion Discord complète — alors que le jeton de session lui-même
// reste valide 2h (session-token.js, TOKEN_LIFETIME_MS). Ce point
// d'entrée fait juste la partie qui manquait : redonner un jeton
// Firebase frais tant que la session (2h) est encore valide.
//
// Ne mint JAMAIS de nouvelle session — uniquement un jeton Firebase, à
// partir d'une session DÉJÀ vérifiée. Si la session a expiré (>2h), la
// vérification échoue normalement et l'appelant doit alors repasser par
// une vraie connexion Discord (comportement inchangé pour ce cas-là).
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");

exports.handler = async function (event) {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." }, corsHeaders);

  const { SESSION_SECRET, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const session = verify(body.token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." }, corsHeaders);

  try {
    const firebaseCustomToken = createFirebaseCustomToken({
      clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY,
      uid: session.discordId, claims: { level: session.level },
    });
    return json(200, { firebaseCustomToken }, corsHeaders);
  } catch (err) {
    return json(500, { error: `Erreur inattendue : ${err.message}` }, corsHeaders);
  }
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(obj) };
}
