// ═══════════════════════════════════════════════════════════════════
// pillbox-verify-session.js — vérifie le jeton de session envoyé par
// Pillbox et renvoie le nom/niveau VÉRIFIÉS côté serveur (jamais ceux
// que le navigateur affirmerait tout seul). Utilisé uniquement pour
// enregistrer "Paie effectuée par" au moment de valider une semaine —
// aucune écriture ici, juste une vérification d'identité.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");

exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) {
    return json(500, { error: "Configuration manquante côté serveur." }, corsHeaders);
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }, corsHeaders); }
  const session = verify(body.token, SESSION_SECRET);
  if (!session) {
    return json(401, { error: "Session invalide ou expirée — reconnecte-toi avec Discord." }, corsHeaders);
  }

  return json(200, { name: session.name, level: session.level }, corsHeaders);
};

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: { "Content-Type": "application/json", ...(extraHeaders||{}) }, body: JSON.stringify(obj) };
}
